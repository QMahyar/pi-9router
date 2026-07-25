/**
 * pi-9router — Sync 9Router models into pi
 *
 * /9router  — TUI: endpoint, API key, fetch catalog, register chat models
 *
 * Chat models are registered as provider "9router" via pi.registerProvider()
 * using metadata from GET /v1/models (capabilities.contextWindow, vision, …).
 * Image / TTS / STT / embedding / web catalogs are fetched and stored for browse,
 * but only chat (LLM) models are registered with pi's model picker.
 *
 * Config: ~/.pi/agent/9router.json
 * Env:    NINEROUTER_URL, NINEROUTER_KEY
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

// ── Constants ───────────────────────────────────────────────────

const PROVIDER_ID = "9router";
const PROVIDER_NAME = "9Router";
const DEFAULT_ENDPOINT = "http://localhost:20128";
const CONFIG_PATH = join(homedir(), ".pi", "agent", "9router.json");
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;

/** OpenAI-compatible kinds 9Router exposes under /v1/models[/kind] */
const CATALOG_KINDS = [
	"chat",
	"image",
	"tts",
	"stt",
	"embedding",
	"web",
	"image-to-text",
] as const;

type CatalogKind = (typeof CATALOG_KINDS)[number];

// ── Types ───────────────────────────────────────────────────────

interface ModelCapabilities {
	vision?: boolean;
	pdf?: boolean;
	audioInput?: boolean;
	videoInput?: boolean;
	imageOutput?: boolean;
	audioOutput?: boolean;
	search?: boolean;
	tools?: boolean;
	reasoning?: boolean;
	thinkingFormat?: string | null;
	thinkingCanDisable?: boolean;
	thinkingRange?: { min?: number; max?: number } | null;
	contextWindow?: number;
	maxOutput?: number;
	upstreamProvider?: string;
	[key: string]: unknown;
}

interface RemoteModel {
	id: string;
	object?: string;
	owned_by?: string;
	name?: string;
	kind?: string;
	endpoint?: string;
	capabilities?: ModelCapabilities | string[];
	params?: string[];
	options?: unknown;
	created?: number;
}

interface CatalogEntry {
	id: string;
	name: string;
	kind: CatalogKind | string;
	ownedBy?: string;
	endpoint?: string;
	capabilities?: ModelCapabilities | string[];
	params?: string[];
	/** Only set for chat models mapped into pi */
	registered?: boolean;
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
	input?: Array<"text" | "image">;
}

interface PiModelDef {
	id: string;
	name: string;
	reasoning: boolean;
	input: Array<"text" | "image">;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
	compat?: Record<string, unknown>;
	thinkingLevelMap?: Partial<Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh", string | null>>;
}

interface Config {
	/** Base URL without trailing slash, e.g. http://localhost:20128 */
	endpoint: string;
	/** API key from 9Router Dashboard → Keys (optional if requireApiKey=false) */
	apiKey?: string;
	/** Last successful sync ISO time */
	lastSync?: string;
	/** Chat models currently registered with pi */
	chatModels?: PiModelDef[];
	/** Full multi-kind catalog from last fetch */
	catalog?: CatalogEntry[];
	/** Counts by kind from last fetch */
	counts?: Partial<Record<CatalogKind | string, number>>;
}

// ── Config I/O ──────────────────────────────────────────────────

function defaultConfig(): Config {
	return {
		endpoint: (process.env.NINEROUTER_URL || DEFAULT_ENDPOINT).replace(/\/$/, ""),
		apiKey: process.env.NINEROUTER_KEY || undefined,
	};
}

function loadConfig(): Config {
	const base = defaultConfig();
	if (!existsSync(CONFIG_PATH)) return base;
	try {
		const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as Partial<Config>;
		return {
			endpoint: (raw.endpoint || base.endpoint).replace(/\/$/, ""),
			apiKey: raw.apiKey ?? base.apiKey,
			lastSync: raw.lastSync,
			chatModels: raw.chatModels,
			catalog: raw.catalog,
			counts: raw.counts,
		};
	} catch {
		return base;
	}
}

function saveConfig(config: Config): void {
	const dir = dirname(CONFIG_PATH);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	// Persist explicitly; do not echo env-only key unless user set it via TUI
	const out: Config = {
		endpoint: config.endpoint.replace(/\/$/, ""),
		apiKey: config.apiKey,
		lastSync: config.lastSync,
		chatModels: config.chatModels,
		catalog: config.catalog,
		counts: config.counts,
	};
	writeFileSync(CONFIG_PATH, JSON.stringify(out, null, 2));
}

function resolveApiKey(config: Config): string {
	return (config.apiKey || process.env.NINEROUTER_KEY || "9router").trim();
}

function maskedKey(key?: string): string {
	if (!key) return "(not set)";
	if (key.length <= 8) return "••••";
	return key.slice(0, 4) + "…" + key.slice(-4);
}

function baseV1(endpoint: string): string {
	return `${endpoint.replace(/\/$/, "")}/v1`;
}

// ── HTTP ────────────────────────────────────────────────────────

function authHeaders(apiKey: string): Record<string, string> {
	const h: Record<string, string> = { Accept: "application/json" };
	if (apiKey && apiKey !== "9router") {
		h.Authorization = `Bearer ${apiKey}`;
	} else if (apiKey) {
		// Dummy key still sent — some setups accept any bearer
		h.Authorization = `Bearer ${apiKey}`;
	}
	return h;
}

async function httpGetJson<T>(
	url: string,
	apiKey: string,
	signal?: AbortSignal,
): Promise<{ ok: true; data: T } | { ok: false; status: number; error: string }> {
	try {
		const res = await fetch(url, {
			method: "GET",
			headers: authHeaders(apiKey),
			signal,
		});
		if (!res.ok) {
			const body = (await res.text()).slice(0, 240);
			return { ok: false, status: res.status, error: body || res.statusText };
		}
		return { ok: true, data: (await res.json()) as T };
	} catch (err: any) {
		if (err?.name === "AbortError") return { ok: false, status: 0, error: "aborted" };
		return { ok: false, status: 0, error: err?.message || String(err) };
	}
}

async function healthCheck(
	endpoint: string,
	signal?: AbortSignal,
): Promise<{ ok: boolean; error?: string }> {
	try {
		const res = await fetch(`${endpoint.replace(/\/$/, "")}/api/health`, {
			signal,
			headers: { Accept: "application/json" },
		});
		if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
		const data = (await res.json()) as { ok?: boolean };
		return { ok: data.ok === true };
	} catch (err: any) {
		return { ok: false, error: err?.message || String(err) };
	}
}

// ── Catalog fetch + mapping ─────────────────────────────────────

function asCaps(raw: RemoteModel["capabilities"]): ModelCapabilities | undefined {
	if (!raw) return undefined;
	if (Array.isArray(raw)) {
		// e.g. image models: ["textToImage", "edit"]
		const out: ModelCapabilities = {};
		for (const tag of raw) {
			const t = String(tag).toLowerCase();
			if (t.includes("image") || t === "texttoimage") out.imageOutput = true;
			if (t === "edit") out.imageOutput = true;
			if (t === "vision") out.vision = true;
			if (t === "reasoning" || t === "thinking") out.reasoning = true;
		}
		return out;
	}
	return raw;
}

function inferName(m: RemoteModel, infoName?: string): string {
	if (infoName?.trim()) return infoName.trim();
	if (m.name?.trim()) return m.name.trim();
	// id is often "alias/model-id"
	const id = m.id;
	const slash = id.indexOf("/");
	const leaf = slash >= 0 ? id.slice(slash + 1) : id;
	return leaf
		.replace(/[-_]/g, " ")
		.replace(/\b\w/g, (c) => c.toUpperCase());
}

function looksReasoning(id: string, caps?: ModelCapabilities): boolean {
	if (caps?.reasoning === true) return true;
	const s = id.toLowerCase();
	return /thinking|reasoner|reason|-r1\b|o1\b|o3\b|o4\b/.test(s);
}

function mapThinkingCompat(caps?: ModelCapabilities): {
	compat?: Record<string, unknown>;
	thinkingLevelMap?: PiModelDef["thinkingLevelMap"];
} {
	const format = (caps?.thinkingFormat || "").toLowerCase();
	if (!caps?.reasoning && !format) {
		return {
			compat: {
				supportsDeveloperRole: false,
				supportsReasoningEffort: false,
				maxTokensField: "max_tokens",
			},
		};
	}

	// 9Router speaks OpenAI chat-completions; map effort where useful
	if (format === "openai" || format === "openrouter" || !format) {
		return {
			compat: {
				supportsDeveloperRole: false,
				supportsReasoningEffort: true,
				thinkingFormat: format === "openrouter" ? "openrouter" : "openai",
				maxTokensField: "max_tokens",
			},
		};
	}

	if (format.includes("claude")) {
		// Still OpenAI wire via 9Router gateway
		return {
			compat: {
				supportsDeveloperRole: false,
				supportsReasoningEffort: true,
				thinkingFormat: "openrouter",
				maxTokensField: "max_tokens",
			},
		};
	}

	if (format.includes("gemini")) {
		return {
			compat: {
				supportsDeveloperRole: false,
				supportsReasoningEffort: true,
				maxTokensField: "max_tokens",
			},
		};
	}

	if (format === "qwen" || format.includes("qwen")) {
		return {
			compat: {
				supportsDeveloperRole: false,
				supportsReasoningEffort: false,
				thinkingFormat: "qwen",
				maxTokensField: "max_tokens",
			},
		};
	}

	if (format === "deepseek" || format.includes("deepseek")) {
		return {
			compat: {
				supportsDeveloperRole: false,
				supportsReasoningEffort: false,
				thinkingFormat: "deepseek",
				maxTokensField: "max_tokens",
			},
		};
	}

	if (format === "zai" || format === "glm") {
		return {
			compat: {
				supportsDeveloperRole: false,
				supportsReasoningEffort: false,
				thinkingFormat: "zai",
				maxTokensField: "max_tokens",
			},
		};
	}

	// kimi / minimax / default
	return {
		compat: {
			supportsDeveloperRole: false,
			supportsReasoningEffort: true,
			maxTokensField: "max_tokens",
		},
	};
}

function toPiModel(m: RemoteModel, info?: RemoteModel): PiModelDef {
	const caps = asCaps(info?.capabilities) || asCaps(m.capabilities) || {};
	const id = m.id;
	const reasoning = looksReasoning(id, caps);
	const vision = caps.vision === true;
	const contextWindow =
		(typeof caps.contextWindow === "number" && caps.contextWindow > 0
			? caps.contextWindow
			: undefined) || 128000;
	const maxTokens =
		(typeof caps.maxOutput === "number" && caps.maxOutput > 0
			? caps.maxOutput
			: undefined) || Math.min(64000, Math.floor(contextWindow / 4)) || 8192;

	const { compat, thinkingLevelMap } = mapThinkingCompat({ ...caps, reasoning });

	const def: PiModelDef = {
		id,
		name: inferName(m, info?.name),
		reasoning,
		input: vision ? ["text", "image"] : ["text"],
		cost: { ...ZERO_COST },
		contextWindow,
		maxTokens,
	};
	if (compat) def.compat = compat;
	if (thinkingLevelMap) def.thinkingLevelMap = thinkingLevelMap;
	return def;
}

function kindPath(kind: CatalogKind): string {
	// chat → /v1/models  (default LLM list)
	if (kind === "chat") return "/models";
	return `/models/${kind}`;
}

async function fetchKind(
	endpoint: string,
	apiKey: string,
	kind: CatalogKind,
	signal?: AbortSignal,
): Promise<{ ok: true; models: RemoteModel[] } | { ok: false; error: string }> {
	const url = `${baseV1(endpoint)}${kindPath(kind)}`;
	const res = await httpGetJson<{ data?: RemoteModel[] }>(url, apiKey, signal);
	if (!res.ok) return { ok: false, error: `${kind}: HTTP ${res.status} ${res.error}` };
	const models = Array.isArray(res.data.data) ? res.data.data : [];
	return { ok: true, models };
}

async function fetchModelInfo(
	endpoint: string,
	apiKey: string,
	id: string,
	signal?: AbortSignal,
): Promise<RemoteModel | null> {
	const url = `${baseV1(endpoint)}/models/info?id=${encodeURIComponent(id)}`;
	const res = await httpGetJson<RemoteModel>(url, apiKey, signal);
	if (!res.ok) return null;
	return res.data;
}

export interface SyncResult {
	ok: boolean;
	error?: string;
	counts: Partial<Record<string, number>>;
	chatModels: PiModelDef[];
	catalog: CatalogEntry[];
	healthOk: boolean;
}

async function fetchAllAndBuild(
	config: Config,
	opts: {
		signal?: AbortSignal;
		enrichChatInfo?: boolean;
		onProgress?: (msg: string) => void;
	} = {},
): Promise<SyncResult> {
	const endpoint = config.endpoint.replace(/\/$/, "");
	const apiKey = resolveApiKey(config);
	const counts: Partial<Record<string, number>> = {};
	const catalog: CatalogEntry[] = [];
	const chatModels: PiModelDef[] = [];

	opts.onProgress?.("Checking health…");
	const health = await healthCheck(endpoint, opts.signal);
	if (!health.ok) {
		return {
			ok: false,
			error: `9Router not reachable at ${endpoint} (${health.error || "health failed"}). Is it running?`,
			counts: {},
			chatModels: [],
			catalog: [],
			healthOk: false,
		};
	}

	// Fetch all kinds in parallel
	opts.onProgress?.("Fetching model catalogs…");
	const results = await Promise.all(
		CATALOG_KINDS.map(async (kind) => {
			const r = await fetchKind(endpoint, apiKey, kind, opts.signal);
			return { kind, r };
		}),
	);

	const errors: string[] = [];
	let chatRemotes: RemoteModel[] = [];

	for (const { kind, r } of results) {
		if (!r.ok) {
			// chat is required; others optional
			if (kind === "chat") errors.push(r.error);
			else errors.push(r.error);
			counts[kind] = 0;
			continue;
		}
		counts[kind] = r.models.length;
		if (kind === "chat") chatRemotes = r.models;

		for (const m of r.models) {
			const caps = asCaps(m.capabilities);
			catalog.push({
				id: m.id,
				name: inferName(m),
				kind,
				ownedBy: m.owned_by,
				endpoint: m.endpoint,
				capabilities: caps || m.capabilities,
				params: m.params,
				contextWindow: caps?.contextWindow,
				maxTokens: caps?.maxOutput,
				reasoning: looksReasoning(m.id, caps),
				input: caps?.vision ? ["text", "image"] : ["text"],
			});
		}
	}

	if (!chatRemotes.length && errors.some((e) => e.startsWith("chat:"))) {
		return {
			ok: false,
			error: errors.join("\n"),
			counts,
			chatModels: [],
			catalog,
			healthOk: true,
		};
	}

	// Map chat → pi models. List already carries rich capabilities for most.
	// Optionally enrich sparse entries via /v1/models/info (combos often lack caps).
	opts.onProgress?.(`Mapping ${chatRemotes.length} chat models…`);
	const sparse = chatRemotes.filter((m) => !asCaps(m.capabilities)?.contextWindow);
	const infoMap = new Map<string, RemoteModel>();

	if (opts.enrichChatInfo !== false && sparse.length > 0 && sparse.length <= 40) {
		opts.onProgress?.(`Enriching ${sparse.length} models via /v1/models/info…`);
		const conc = 6;
		for (let i = 0; i < sparse.length; i += conc) {
			if (opts.signal?.aborted) break;
			const batch = sparse.slice(i, i + conc);
			await Promise.all(
				batch.map(async (m) => {
					const info = await fetchModelInfo(endpoint, apiKey, m.id, opts.signal);
					if (info) infoMap.set(m.id, info);
				}),
			);
		}
	}

	for (const m of chatRemotes) {
		const def = toPiModel(m, infoMap.get(m.id));
		chatModels.push(def);
		const entry = catalog.find((c) => c.id === m.id && c.kind === "chat");
		if (entry) {
			entry.registered = true;
			entry.name = def.name;
			entry.contextWindow = def.contextWindow;
			entry.maxTokens = def.maxTokens;
			entry.reasoning = def.reasoning;
			entry.input = def.input;
		}
	}

	return {
		ok: true,
		error: errors.length ? `Partial: ${errors.join("; ")}` : undefined,
		counts,
		chatModels,
		catalog,
		healthOk: true,
	};
}

// ── Provider registration ───────────────────────────────────────

function registerWithPi(pi: ExtensionAPI, config: Config, chatModels: PiModelDef[]): void {
	const endpoint = config.endpoint.replace(/\/$/, "");
	const apiKey = resolveApiKey(config);

	if (!chatModels.length) {
		// Clear provider models if empty
		try {
			pi.unregisterProvider(PROVIDER_ID);
		} catch {
			/* not registered */
		}
		return;
	}

	pi.registerProvider(PROVIDER_ID, {
		name: PROVIDER_NAME,
		baseUrl: baseV1(endpoint),
		api: "openai-completions",
		apiKey,
		authHeader: true,
		models: chatModels.map((m) => ({
			id: m.id,
			name: m.name,
			reasoning: m.reasoning,
			input: m.input,
			cost: m.cost,
			contextWindow: m.contextWindow,
			maxTokens: m.maxTokens,
			...(m.compat ? { compat: m.compat } : {}),
			...(m.thinkingLevelMap ? { thinkingLevelMap: m.thinkingLevelMap } : {}),
		})),
	});
}

function applySyncToConfig(config: Config, sync: SyncResult): Config {
	const next: Config = {
		...config,
		lastSync: new Date().toISOString(),
		chatModels: sync.chatModels,
		catalog: sync.catalog,
		counts: sync.counts,
	};
	saveConfig(next);
	return next;
}

// ── TUI helpers ─────────────────────────────────────────────────

function statusLines(config: Config): string[] {
	const counts = config.counts || {};
	const chat = config.chatModels?.length ?? counts.chat ?? 0;
	const lines = [
		`Endpoint:  ${config.endpoint}`,
		`API key:   ${config.apiKey ? maskedKey(config.apiKey) : process.env.NINEROUTER_KEY ? maskedKey(process.env.NINEROUTER_KEY) + " (env)" : "(not set — ok if 9Router auth off)"}`,
		`Last sync: ${config.lastSync || "never"}`,
		`Chat registered: ${chat}`,
	];
	const extras = (["image", "tts", "stt", "embedding", "web", "image-to-text"] as const)
		.map((k) => (counts[k] ? `${k}:${counts[k]}` : null))
		.filter(Boolean);
	if (extras.length) lines.push(`Catalog:   ${extras.join("  ")}`);
	lines.push(`Config:    ${CONFIG_PATH}`);
	return lines;
}

async function browseCatalog(ui: ExtensionContext["ui"], config: Config): Promise<void> {
	const catalog = config.catalog || [];
	if (!catalog.length) {
		ui.notify("No catalog yet — run Fetch & register first", "warning");
		return;
	}

	while (true) {
		const byKind = new Map<string, number>();
		for (const e of catalog) byKind.set(e.kind, (byKind.get(e.kind) || 0) + 1);
		const kindItems = [...byKind.entries()]
			.sort((a, b) => a[0].localeCompare(b[0]))
			.map(([k, n]) => `${k} (${n})`);
		kindItems.push("← Back");

		const kindChoice = await ui.select("Browse catalog by kind", kindItems);
		if (!kindChoice || kindChoice === "← Back") return;

		const kind = kindChoice.replace(/\s*\(\d+\)$/, "");
		const entries = catalog.filter((e) => e.kind === kind).sort((a, b) => a.id.localeCompare(b.id));

		const pageSize = 30;
		let page = 0;
		while (true) {
			const totalPages = Math.max(1, Math.ceil(entries.length / pageSize));
			const slice = entries.slice(page * pageSize, page * pageSize + pageSize);
			const items = slice.map((e) => {
				const bits: string[] = [e.id];
				if (e.reasoning) bits.push("🧠");
				if (e.input?.includes("image")) bits.push("👁");
				if (e.contextWindow) bits.push(`${Math.round(e.contextWindow / 1000)}k`);
				if (e.registered) bits.push("✓ pi");
				return bits.join(" · ");
			});
			if (page > 0) items.push("← Prev page");
			if (page + 1 < totalPages) items.push("→ Next page");
			items.push("← Back");

			const pick = await ui.select(
				`${kind} · ${entries.length} models · page ${page + 1}/${totalPages}`,
				items,
			);
			if (!pick || pick === "← Back") break;
			if (pick === "← Prev page") {
				page = Math.max(0, page - 1);
				continue;
			}
			if (pick === "→ Next page") {
				page = Math.min(totalPages - 1, page + 1);
				continue;
			}

			const id = pick.split(" · ")[0];
			const entry = entries.find((e) => e.id === id);
			if (!entry) continue;

			const detail = [
				`id: ${entry.id}`,
				`name: ${entry.name}`,
				`kind: ${entry.kind}`,
				entry.ownedBy ? `owned_by: ${entry.ownedBy}` : "",
				entry.endpoint ? `endpoint: ${entry.endpoint}` : "",
				entry.contextWindow ? `contextWindow: ${entry.contextWindow}` : "",
				entry.maxTokens ? `maxTokens: ${entry.maxTokens}` : "",
				entry.reasoning != null ? `reasoning: ${entry.reasoning}` : "",
				entry.input ? `input: ${entry.input.join(", ")}` : "",
				entry.registered ? "registered in pi: yes" : "registered in pi: no (non-chat or not synced)",
				entry.capabilities
					? `capabilities: ${typeof entry.capabilities === "string" ? entry.capabilities : JSON.stringify(entry.capabilities)}`
					: "",
				entry.params?.length ? `params: ${entry.params.join(", ")}` : "",
			]
				.filter(Boolean)
				.join("\n");

			await ui.confirm(entry.id, detail + "\n\n(OK to close)");
		}
	}
}

async function runNineRouterUI(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	const ui = ctx.ui;
	let config = loadConfig();

	while (true) {
		const menu = [
			"📡 Status",
			"🔗 Set endpoint",
			"🔑 Set API key",
			"🧹 Clear API key",
			"🩺 Test connection",
			"⬇ Fetch all & register chat models",
			"📚 Browse catalog",
			"✕ Unregister chat models",
			"Done",
		];

		const choice = await ui.select("9Router", menu);
		if (!choice || choice === "Done") break;

		if (choice.startsWith("📡")) {
			await ui.confirm("9Router status", statusLines(config).join("\n") + "\n\n(OK to close)");
			continue;
		}

		if (choice.startsWith("🔗")) {
			const next = await ui.input(
				"9Router base URL (no /v1)",
				config.endpoint || DEFAULT_ENDPOINT,
			);
			if (next?.trim()) {
				config = { ...config, endpoint: next.trim().replace(/\/$/, "") };
				saveConfig(config);
				// Re-register with new base if we have models
				if (config.chatModels?.length) {
					registerWithPi(pi, config, config.chatModels);
					ui.notify("Endpoint saved — provider baseUrl updated", "info");
				} else {
					ui.notify("Endpoint saved", "info");
				}
			}
			continue;
		}

		if (choice.startsWith("🔑")) {
			const next = await ui.input("API key (Dashboard → Keys)", config.apiKey || "sk-…");
			if (next !== undefined) {
				const trimmed = next.trim();
				config = { ...config, apiKey: trimmed || undefined };
				saveConfig(config);
				if (config.chatModels?.length) registerWithPi(pi, config, config.chatModels);
				ui.notify(trimmed ? "API key saved" : "API key cleared", "info");
			}
			continue;
		}

		if (choice.startsWith("🧹")) {
			const ok = await ui.confirm("Clear API key?", "Remove stored key from config? (env NINEROUTER_KEY still works)");
			if (ok) {
				config = { ...config, apiKey: undefined };
				saveConfig(config);
				if (config.chatModels?.length) registerWithPi(pi, config, config.chatModels);
				ui.notify("API key cleared", "info");
			}
			continue;
		}

		if (choice.startsWith("🩺")) {
			ui.notify("Testing…", "info");
			const health = await healthCheck(config.endpoint);
			if (!health.ok) {
				ui.notify(`Health failed: ${health.error}`, "error");
				continue;
			}
			const chat = await fetchKind(config.endpoint, resolveApiKey(config), "chat");
			if (!chat.ok) {
				ui.notify(`Health OK, but /v1/models failed: ${chat.error}`, "warning");
				continue;
			}
			ui.notify(`OK — health ✓ · ${chat.models.length} chat models visible`, "info");
			continue;
		}

		if (choice.startsWith("⬇")) {
			ui.notify("Fetching catalogs from 9Router…", "info");
			const sync = await fetchAllAndBuild(config, {
				onProgress: (msg) => ui.notify(msg, "info"),
			});
			if (!sync.ok) {
				ui.notify(sync.error || "Sync failed", "error");
				continue;
			}

			config = applySyncToConfig(config, sync);
			registerWithPi(pi, config, sync.chatModels);

			const summary = [
				`Registered ${sync.chatModels.length} chat models as provider "${PROVIDER_ID}"`,
				...Object.entries(sync.counts).map(([k, n]) => `  ${k}: ${n}`),
				sync.error ? `Note: ${sync.error}` : "",
				"",
				"Open /model and select provider 9router (or search a model id).",
				"Changes apply immediately — /reload not required for provider update.",
			]
				.filter(Boolean)
				.join("\n");

			await ui.confirm("Sync complete", summary);
			continue;
		}

		if (choice.startsWith("📚")) {
			await browseCatalog(ui, config);
			continue;
		}

		if (choice.startsWith("✕")) {
			const ok = await ui.confirm(
				"Unregister?",
				`Remove ${config.chatModels?.length || 0} chat models from pi provider "${PROVIDER_ID}"?`,
			);
			if (!ok) continue;
			try {
				pi.unregisterProvider(PROVIDER_ID);
			} catch {
				/* ignore */
			}
			config = {
				...config,
				chatModels: [],
				catalog: (config.catalog || []).map((c) => ({ ...c, registered: false })),
			};
			saveConfig(config);
			ui.notify("Chat models unregistered", "info");
			continue;
		}
	}
}

// ── Extension entry ─────────────────────────────────────────────

export default async function (pi: ExtensionAPI) {
	const config = loadConfig();

	// Register cached chat models at startup so /model works immediately.
	// Fresh network sync is manual via /9router (avoids slow/fragile startup).
	if (config.chatModels?.length && config.endpoint) {
		try {
			registerWithPi(pi, config, config.chatModels);
		} catch (err: any) {
			console.error("[pi-9router] failed to register cached models:", err?.message || err);
		}
	}

	pi.registerCommand("9router", {
		description: "Manage 9Router endpoint, API key, and sync models into pi",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI && ctx.mode !== "tui") {
				ctx.ui.notify("/9router needs interactive mode", "error");
				return;
			}
			await runNineRouterUI(pi, ctx);
		},
	});

	// Optional: show a quiet status hint once per session when configured but never synced
	pi.on("session_start", async (_event, ctx) => {
		const cfg = loadConfig();
		if (cfg.endpoint && !cfg.lastSync && ctx.hasUI) {
			ctx.ui.setStatus(
				"9router",
				ctx.ui.theme.fg("dim", "9router: run /9router to sync models"),
			);
		} else if (cfg.chatModels?.length && ctx.hasUI) {
			ctx.ui.setStatus(
				"9router",
				ctx.ui.theme.fg("dim", `9router · ${cfg.chatModels.length} models`),
			);
		}
	});
}
