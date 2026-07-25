/**
 * pi-9router — Sync 9Router models into pi
 *
 * /9router  — TUI: endpoint, API key, fetch catalog, register chat models
 *
 * Chat models are registered as provider "9router" via pi.registerProvider()
 * using metadata from GET /v1/models (capabilities.contextWindow, vision, …).
 * Image / TTS / embedding / web catalogs are fetched and stored for browse
 * (and for /9router-tools). Only chat (LLM) models are registered with pi's model picker.
 * STT catalog may still appear under Browse; this package does not expose STT tools.
 *
 * The list endpoints return only { id, object, owned_by }, so every model is then
 * looked up via GET /v1/models/info?id= for its real name, precise kind, endpoint,
 * and accepted params. Without that pass, display names are guesses derived from
 * the id ("TTS-1 HD" shows up as "Openai/Tts 1 Hd").
 *
 * edge-tts / google-tts are noAuth voice providers with no list-endpoint entry;
 * they are probed with a short synthesis call and only added when they respond.
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

/** Concurrency for the per-model /v1/models/info enrichment pass */
const INFO_CONCURRENCY = 8;

/**
 * Voice-based TTS providers 9Router routes without credentials (noAuth).
 *
 * They are absent from /v1/models/tts because the `model` field is a *voice*
 * (edge-tts) or a *language code* (google-tts) rather than a published model id,
 * so there is no list endpoint entry to enumerate. /v1/audio/voices can list
 * edge-tts voices but requires a real dashboard key (401 with a dummy one), so
 * we enumerate when that works and fall back to this verified set otherwise.
 *
 * Each provider is probed with a tiny synthesis call during sync and only enters
 * the catalog when that probe returns real audio — a proxy or blocked egress
 * makes these 502, and silently listing dead models is worse than omitting them.
 */
const VOICE_TTS_PROVIDERS: Array<{
	provider: string;
	/** Voice/language ids verified against /v1/audio/speech */
	voices: string[];
	/** Representative id used for the liveness probe */
	probe: string;
	/** true when /v1/audio/voices can enumerate this provider */
	enumerable: boolean;
	note: string;
}> = [
	{
		provider: "edge-tts",
		voices: [
			"en-US-AriaNeural",
			"en-US-GuyNeural",
			"en-US-JennyNeural",
			"en-GB-SoniaNeural",
			"en-GB-RyanNeural",
			"en-AU-NatashaNeural",
			"de-DE-KatjaNeural",
			"fr-FR-DeniseNeural",
			"es-ES-ElviraNeural",
			"fa-IR-DilaraNeural",
			"vi-VN-HoaiMyNeural",
		],
		probe: "en-US-AriaNeural",
		enumerable: true,
		note: "Any edge-tts voice id works, not only the listed ones",
	},
	{
		provider: "google-tts",
		// Plain 2-letter codes only: region-qualified codes (en-GB) and some
		// languages (fa) 502 upstream.
		voices: ["en", "de", "fr", "es", "vi", "ja", "ar", "hi"],
		probe: "en",
		enumerable: false,
		note: "model is a 2-letter language code",
	},
];

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
	/** Bucket kind from the list endpoint (chat, image, tts, web, …) — used for grouping */
	kind: CatalogKind | string;
	/**
	 * Precise kind reported by /v1/models/info (llm, webSearch, webFetch, tts, …).
	 * The list endpoints do not return this, so it is only set after enrichment.
	 */
	detailKind?: string;
	ownedBy?: string;
	endpoint?: string;
	capabilities?: ModelCapabilities | string[];
	params?: string[];
	/** true when `name` came from the server rather than being derived from the id */
	namedByServer?: boolean;
	/** Locally added (voice-based TTS providers that have no list-endpoint entry) */
	synthetic?: boolean;
	/** Free-form note shown in Browse for synthetic entries */
	note?: string;
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
	// Merge so companion extensions (9router-tools) can store keys on the same file
	// without being wiped (e.g. capabilities, defaults, outputDir).
	let existing: Record<string, unknown> = {};
	if (existsSync(CONFIG_PATH)) {
		try {
			existing = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as Record<string, unknown>;
		} catch {
			existing = {};
		}
	}
	const core: Config = {
		endpoint: config.endpoint.replace(/\/$/, ""),
		apiKey: config.apiKey,
		lastSync: config.lastSync,
		chatModels: config.chatModels,
		catalog: config.catalog,
		counts: config.counts,
	};
	const out = { ...existing, ...core };
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
	// Not every id has an info record (combos, some upstream passthroughs 404).
	if (!res.ok) return null;
	if (!res.data || typeof res.data !== "object" || (res.data as any).error) return null;
	return res.data;
}

/** Run `task` over `items` with a fixed concurrency, aborting between batches. */
async function mapConcurrent<T, R>(
	items: T[],
	limit: number,
	task: (item: T) => Promise<R>,
	signal?: AbortSignal,
): Promise<void> {
	for (let i = 0; i < items.length; i += limit) {
		if (signal?.aborted) return;
		await Promise.all(items.slice(i, i + limit).map(task));
	}
}

/**
 * Fill in per-model metadata the list endpoints omit.
 *
 * GET /v1/models[/kind] returns only { id, object, owned_by }, so a display name
 * derived from the id is a guess — "nb/nanobanana-flash" becomes "Nanobanana Flash"
 * when the server calls it "NanoBanana Flash", and "openrouter/openai/tts-1-hd"
 * becomes "Openai/Tts 1 Hd" instead of "TTS-1 HD". GET /v1/models/info?id= returns
 * the real name plus the precise kind, endpoint, and accepted params. This pass asks
 * for every model in the catalog; ids without an info record keep the derived name.
 */
async function enrichCatalog(
	endpoint: string,
	apiKey: string,
	catalog: CatalogEntry[],
	opts: { signal?: AbortSignal; onProgress?: (msg: string) => void } = {},
): Promise<{ named: number; missing: number; infoById: Map<string, RemoteModel> }> {
	const infoById = new Map<string, RemoteModel>();
	let named = 0;
	let missing = 0;

	opts.onProgress?.(`Fetching metadata for ${catalog.length} models…`);
	await mapConcurrent(
		catalog,
		INFO_CONCURRENCY,
		async (entry) => {
			const info = await fetchModelInfo(endpoint, apiKey, entry.id, opts.signal);
			if (!info) {
				missing++;
				return;
			}
			infoById.set(entry.id, info);
			if (info.name?.trim()) {
				entry.name = info.name.trim();
				entry.namedByServer = true;
				named++;
			}
			if (info.kind?.trim()) entry.detailKind = info.kind.trim();
			if (info.endpoint?.trim()) entry.endpoint = info.endpoint.trim();
			if (Array.isArray(info.params) && info.params.length) entry.params = info.params;
			const caps = asCaps(info.capabilities);
			if (caps) {
				entry.capabilities = { ...(asCaps(entry.capabilities) || {}), ...caps };
				if (caps.contextWindow) entry.contextWindow = caps.contextWindow;
				if (caps.maxOutput) entry.maxTokens = caps.maxOutput;
				if (caps.vision) entry.input = ["text", "image"];
			}
		},
		opts.signal,
	);

	return { named, missing, infoById };
}

// ── Voice-based TTS providers (edge-tts / google-tts) ───────────

/** POST a 1-word synthesis and report whether real audio came back. */
async function probeSpeech(
	endpoint: string,
	apiKey: string,
	model: string,
	signal?: AbortSignal,
): Promise<{ ok: boolean; error?: string }> {
	try {
		const res = await fetch(`${baseV1(endpoint)}/audio/speech`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "*/*",
				...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
			},
			body: JSON.stringify({ model, input: "ok" }),
			signal,
		});
		if (!res.ok) {
			const body = (await res.text()).slice(0, 160);
			return { ok: false, error: `HTTP ${res.status} ${body}` };
		}
		const bytes = await res.arrayBuffer();
		// A JSON error body is far smaller than any real clip.
		if (bytes.byteLength < 512) return { ok: false, error: `only ${bytes.byteLength} bytes` };
		return { ok: true };
	} catch (err: any) {
		if (err?.name === "AbortError") return { ok: false, error: "aborted" };
		return { ok: false, error: err?.message || String(err) };
	}
}

/** Try to enumerate a provider's voices; returns null when the endpoint is unavailable. */
async function fetchVoices(
	endpoint: string,
	apiKey: string,
	provider: string,
	signal?: AbortSignal,
): Promise<string[] | null> {
	const url = `${baseV1(endpoint)}/audio/voices?provider=${encodeURIComponent(provider)}`;
	const res = await httpGetJson<{ data?: Array<{ model?: string; id?: string; name?: string }> }>(
		url,
		apiKey,
		signal,
	);
	if (!res.ok) return null;
	const rows = Array.isArray(res.data?.data) ? res.data.data : [];
	const ids = rows
		.map((v) => (v.model || v.id || v.name || "").trim())
		.filter(Boolean)
		// The endpoint may return either bare voice ids or already-prefixed ones.
		.map((v) => (v.startsWith(`${provider}/`) ? v.slice(provider.length + 1) : v));
	return ids.length ? ids : null;
}

/**
 * Probe each noAuth voice provider and return catalog entries for the live ones.
 *
 * These have no /v1/models/tts entry to discover, so without this they are
 * invisible to /9router-tools and to the agent even though they work and are free.
 */
async function discoverVoiceTts(
	endpoint: string,
	apiKey: string,
	opts: { signal?: AbortSignal; onProgress?: (msg: string) => void } = {},
): Promise<{ entries: CatalogEntry[]; skipped: string[] }> {
	const entries: CatalogEntry[] = [];
	const skipped: string[] = [];

	await Promise.all(
		VOICE_TTS_PROVIDERS.map(async (p) => {
			opts.onProgress?.(`Probing ${p.provider}…`);
			const probe = await probeSpeech(endpoint, apiKey, `${p.provider}/${p.probe}`, opts.signal);
			if (!probe.ok) {
				skipped.push(`${p.provider} (${probe.error})`);
				return;
			}

			let voices = p.voices;
			if (p.enumerable) {
				const listed = await fetchVoices(endpoint, apiKey, p.provider, opts.signal);
				if (listed?.length) voices = listed;
			}

			for (const voice of voices) {
				entries.push({
					id: `${p.provider}/${voice}`,
					name: `${voice} (${p.provider})`,
					kind: "tts",
					detailKind: "tts",
					ownedBy: p.provider,
					endpoint: "/v1/audio/speech",
					params: ["input"],
					namedByServer: false,
					synthetic: true,
					note: p.note,
				});
			}
		}),
	);

	entries.sort((a, b) => a.id.localeCompare(b.id));
	return { entries, skipped };
}

export interface SyncResult {
	ok: boolean;
	error?: string;
	counts: Partial<Record<string, number>>;
	chatModels: PiModelDef[];
	catalog: CatalogEntry[];
	healthOk: boolean;
	/** How many display names came from the server vs were derived from the id */
	namedByServer?: number;
	namesDerived?: number;
	/** Voice TTS providers that failed their liveness probe, with the reason */
	voiceSkipped?: string[];
	/** Voice TTS entries added to the catalog */
	voiceAdded?: number;
}

export async function fetchAllAndBuild(
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

	// Ask the server for real names / kinds / endpoints / params. The list
	// endpoints omit all of it, so skipping this leaves every display name a guess.
	let infoById = new Map<string, RemoteModel>();
	let namedByServer = 0;
	if (opts.enrichChatInfo !== false) {
		const enriched = await enrichCatalog(endpoint, apiKey, catalog, {
			signal: opts.signal,
			onProgress: opts.onProgress,
		});
		infoById = enriched.infoById;
		namedByServer = enriched.named;
	}

	// Voice-based noAuth TTS providers have no list entry — probe and add the live ones.
	const voice = await discoverVoiceTts(endpoint, apiKey, {
		signal: opts.signal,
		onProgress: opts.onProgress,
	});
	if (voice.entries.length) {
		const known = new Set(catalog.map((c) => c.id));
		const fresh = voice.entries.filter((e) => !known.has(e.id));
		catalog.push(...fresh);
		counts.tts = (counts.tts || 0) + fresh.length;
	}

	// Map chat → pi models, reusing the info records already fetched above.
	opts.onProgress?.(`Mapping ${chatRemotes.length} chat models…`);
	for (const m of chatRemotes) {
		const def = toPiModel(m, infoById.get(m.id));
		chatModels.push(def);
		const entry = catalog.find((c) => c.id === m.id && c.kind === "chat");
		if (entry) {
			entry.registered = true;
			// The catalog name is already the server's when enrichment found one;
			// only fall back to the derived name when it is not.
			if (!entry.namedByServer) entry.name = def.name;
			entry.contextWindow = def.contextWindow;
			entry.maxTokens = def.maxTokens;
			entry.reasoning = def.reasoning;
			entry.input = def.input;
		}
	}

	// Keep pi's model picker in step with the server's naming.
	for (const def of chatModels) {
		const entry = catalog.find((c) => c.id === def.id && c.kind === "chat");
		if (entry?.namedByServer) def.name = entry.name;
	}

	return {
		ok: true,
		error: errors.length ? `Partial: ${errors.join("; ")}` : undefined,
		counts,
		chatModels,
		catalog,
		healthOk: true,
		namedByServer,
		namesDerived: catalog.filter((c) => !c.namedByServer && !c.synthetic).length,
		voiceSkipped: voice.skipped,
		voiceAdded: voice.entries.length,
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
				// Names are the server's after enrichment, so worth showing inline.
				if (e.namedByServer && e.name && e.name !== e.id) bits.push(e.name);
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
				`name: ${entry.name}${entry.namedByServer ? "" : " (derived from id — server has no name)"}`,
				`kind: ${entry.kind}${entry.detailKind && entry.detailKind !== entry.kind ? ` (server: ${entry.detailKind})` : ""}`,
				entry.synthetic ? `source: added locally${entry.note ? ` — ${entry.note}` : ""}` : "",
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
		const chatN = config.chatModels?.length ?? 0;
		const synced = config.lastSync ? new Date(config.lastSync).toLocaleString() : "never";
		const header = [
			`Endpoint  ${config.endpoint}`,
			`Key       ${config.apiKey ? maskedKey(config.apiKey) : process.env.NINEROUTER_KEY ? maskedKey(process.env.NINEROUTER_KEY) + " (env)" : "not set"}`,
			`Chat      ${chatN} registered · last sync ${synced}`,
		].join("\n");

		const menu = [
			"Sync models",
			"Connection",
			"Browse catalog",
			"Status",
			"Unregister chat models",
			"Close",
		];

		const choice = await ui.select(`9Router\n${header}`, menu);
		if (!choice || choice === "Close") break;

		if (choice === "Status") {
			await ui.confirm("Status", statusLines(config).join("\n"));
			continue;
		}

		if (choice === "Connection") {
			while (true) {
				const sub = await ui.select("Connection", [
					`Endpoint: ${config.endpoint}`,
					`API key: ${config.apiKey ? maskedKey(config.apiKey) : process.env.NINEROUTER_KEY ? "env NINEROUTER_KEY" : "not set"}`,
					"Test connection",
					"Clear API key",
					"Back",
				]);
				if (!sub || sub === "Back") break;

				if (sub.startsWith("Endpoint")) {
					const next = await ui.input("Base URL (no /v1)", config.endpoint || DEFAULT_ENDPOINT);
					if (next?.trim()) {
						config = { ...config, endpoint: next.trim().replace(/\/$/, "") };
						saveConfig(config);
						if (config.chatModels?.length) registerWithPi(pi, config, config.chatModels);
						ui.notify("Endpoint saved", "info");
					}
					continue;
				}

				if (sub.startsWith("API key")) {
					const next = await ui.input("API key (Dashboard → Keys)", config.apiKey || "");
					if (next !== undefined) {
						config = { ...config, apiKey: next.trim() || undefined };
						saveConfig(config);
						if (config.chatModels?.length) registerWithPi(pi, config, config.chatModels);
						ui.notify(config.apiKey ? "API key saved" : "API key cleared", "info");
					}
					continue;
				}

				if (sub === "Clear API key") {
					const ok = await ui.confirm("Clear API key?", "Env NINEROUTER_KEY still works if set.");
					if (ok) {
						config = { ...config, apiKey: undefined };
						saveConfig(config);
						if (config.chatModels?.length) registerWithPi(pi, config, config.chatModels);
						ui.notify("API key cleared", "info");
					}
					continue;
				}

				if (sub === "Test connection") {
					ui.notify("Testing…", "info");
					const health = await healthCheck(config.endpoint);
					if (!health.ok) {
						ui.notify(`Health failed: ${health.error}`, "error");
						continue;
					}
					const chat = await fetchKind(config.endpoint, resolveApiKey(config), "chat");
					if (!chat.ok) {
						ui.notify(`Health OK, /v1/models failed: ${chat.error}`, "warning");
						continue;
					}
					ui.notify(`OK · health · ${chat.models.length} chat models`, "info");
				}
			}
			continue;
		}

		if (choice === "Sync models") {
			ui.notify("Fetching catalogs…", "info");
			const sync = await fetchAllAndBuild(config, {
				onProgress: (msg) => ui.notify(msg, "info"),
			});
			if (!sync.ok) {
				ui.notify(sync.error || "Sync failed", "error");
				continue;
			}

			config = applySyncToConfig(config, sync);
			registerWithPi(pi, config, sync.chatModels);

			pi.events.emit("9router:synced", {
				endpoint: config.endpoint,
				counts: sync.counts,
				chatCount: sync.chatModels.length,
				at: config.lastSync,
			});

			const summary = [
				`Registered ${sync.chatModels.length} chat models (provider ${PROVIDER_ID})`,
				...Object.entries(sync.counts).map(([k, n]) => `  ${k}: ${n}`),
				"",
				`Names from server: ${sync.namedByServer ?? 0} · derived from id: ${sync.namesDerived ?? 0}`,
				sync.voiceAdded ? `Voice TTS added: ${sync.voiceAdded} (edge-tts / google-tts)` : "",
				sync.voiceSkipped?.length ? `Voice TTS unavailable: ${sync.voiceSkipped.join(", ")}` : "",
				sync.error ? `Note: ${sync.error}` : "",
				"",
				"Next: /model → provider 9router",
				"Tools: /9router-tools",
			]
				.filter(Boolean)
				.join("\n");

			await ui.confirm("Sync complete", summary);
			continue;
		}

		if (choice === "Browse catalog") {
			await browseCatalog(ui, config);
			continue;
		}

		if (choice === "Unregister chat models") {
			const ok = await ui.confirm(
				"Unregister chat models?",
				`Remove ${config.chatModels?.length || 0} models from provider "${PROVIDER_ID}".`,
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
		description: "9Router — connect, sync models, register chat providers in pi",
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
