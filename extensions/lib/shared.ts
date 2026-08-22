/**
 * Shared helpers for 9router.ts and 9router-tools.ts.
 * Not an extension entry point (no default export) — only imported.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import type { Theme } from "@earendil-works/pi-coding-agent";

// ── Paths / defaults ────────────────────────────────────────────

export const CONFIG_PATH = join(homedir(), ".pi", "agent", "9router.json");
export const DEFAULT_ENDPOINT = "http://localhost:20128";
export const DEFAULT_OUTPUT_DIR = join(homedir(), ".pi", "agent", "9router-output");

/** Request timeouts (ms). Esc/UI AbortSignal still wins when present. */
export const TIMEOUT = {
	health: 8_000,
	list: 45_000,
	info: 12_000,
	probe: 20_000,
	tool: 120_000,
	download: 60_000,
} as const;

/** Warn when lastSync is older than this. */
export const STALE_SYNC_MS = 24 * 60 * 60 * 1000;

// ── Types ───────────────────────────────────────────────────────

export interface ModelCapabilities {
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

export interface RemoteModel {
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

/** Shared slim catalog entry — written by 9router.ts, read by 9router-tools.ts. */
export interface CatalogEntry {
	id: string;
	name: string;
	kind: string;
	detailKind?: string;
	ownedBy?: string;
	endpoint?: string;
	/** Slim caps for tools/browse — not the full server blob */
	capabilities?: ModelCapabilities | string[];
	params?: string[];
	namedByServer?: boolean;
	synthetic?: boolean;
	note?: string;
	registered?: boolean;
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
	input?: Array<"text" | "image">;
}

/**
 * Voice-based TTS providers. Probed during full sync: the two entries with
 * voices/probe metadata in VOICE_TTS_PROVIDERS (9router.ts). Tools accept any
 * of these prefixes as a pass-through TTS model id (`<prefix>/<voice>`).
 */
export const VOICE_PROVIDER_PREFIXES: readonly string[] = ["edge-tts", "google-tts", "el", "local-device"];

// ── Capability tools (single source for both extensions) ────────

export type CapId = "image" | "tts" | "embed" | "web_search" | "web_fetch";

export interface CapDef {
	id: CapId;
	tool: string;
	label: string;
	catalogKind: string | ((e: CatalogEntry) => boolean);
	defaultEnabled: boolean;
	blurb: string;
}

export const CAPS: CapDef[] = [
	{
		id: "image",
		tool: "nr_image_generate",
		label: "Image generation",
		catalogKind: "image",
		defaultEnabled: true,
		blurb: "Text → image",
	},
	{
		id: "tts",
		tool: "nr_tts",
		label: "Text to speech",
		catalogKind: "tts",
		defaultEnabled: true,
		blurb: "Text → audio file",
	},
	{
		id: "embed",
		tool: "nr_embed",
		label: "Embeddings",
		catalogKind: "embedding",
		defaultEnabled: false,
		blurb: "Text → vectors",
	},
	{
		id: "web_search",
		tool: "nr_web_search",
		label: "Web search",
		catalogKind: (e) =>
			e.kind === "web" && (e.detailKind === "webSearch" || (!e.detailKind && /search/i.test(e.id))),
		defaultEnabled: true,
		blurb: "Query → results",
	},
	{
		id: "web_fetch",
		tool: "nr_web_fetch",
		label: "Web fetch",
		catalogKind: (e) =>
			e.kind === "web" && (e.detailKind === "webFetch" || (!e.detailKind && /fetch/i.test(e.id))),
		defaultEnabled: true,
		blurb: "URL → markdown",
	},
];

// ── Config I/O ──────────────────────────────────────────────────

export function loadJsonFile(path: string = CONFIG_PATH): Record<string, unknown> {
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
	} catch {
		return {};
	}
}

/**
 * Write JSON atomically (temp file + rename) so a crash or a concurrent
 * write from the other 9router extension can never truncate the config.
 */
function writeJsonAtomic(path: string, data: unknown): void {
	const dir = dirname(path);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	const tmp = join(dir, `.${basenameOf(path)}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`);
	writeFileSync(tmp, JSON.stringify(data, null, 2));
	try {
		chmodSync(tmp, 0o600); // config can hold an API key (no-op-ish on Windows)
	} catch {
		/* platform without chmod semantics */
	}
	renameSync(tmp, path);
}

function basenameOf(path: string): string {
	const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
	return i >= 0 ? path.slice(i + 1) : path;
}

/** Legacy keys dropped from older installs; their presence triggers a rewrite. */
export function hasLegacyKeys(raw: Record<string, unknown> = loadJsonFile()): boolean {
	if ("voice" in raw || "ffmpegPath" in raw) return true;
	const caps = raw.capabilities as Record<string, unknown> | undefined;
	return Boolean(caps && "stt" in caps);
}

function stripLegacyKeys(next: Record<string, unknown>): Record<string, unknown> {
	delete next.voice;
	delete next.ffmpegPath;
	if (next.capabilities && typeof next.capabilities === "object") {
		const caps = { ...(next.capabilities as Record<string, unknown>) };
		delete caps.stt;
		next.capabilities = caps;
	}
	return next;
}

/** Deep-merge top-level keys; merges `capabilities` one level when both sides set it. */
export function saveJsonMerge(
	patch: Record<string, unknown>,
	path: string = CONFIG_PATH,
): Record<string, unknown> {
	const cur = loadJsonFile(path);
	const next: Record<string, unknown> = { ...cur, ...patch };
	if (patch.capabilities && typeof patch.capabilities === "object") {
		next.capabilities = {
			...((cur.capabilities as Record<string, unknown>) || {}),
			...(patch.capabilities as Record<string, unknown>),
		};
	}
	stripLegacyKeys(next);
	writeJsonAtomic(path, next);
	return next;
}

export function normalizeEndpoint(endpoint?: string): string {
	const raw = (endpoint || process.env.NINEROUTER_URL || DEFAULT_ENDPOINT).trim();
	const trimmed = raw.replace(/\/+$/, "");
	// Tolerate scheme-less input like "localhost:20128" (assume http).
	if (/^[a-z][a-z0-9+.\-]*:\/\//i.test(trimmed)) return trimmed;
	return `http://${trimmed}`;
}

export function resolveApiKey(apiKey?: string): string {
	return (apiKey || process.env.NINEROUTER_KEY || "9router").trim();
}

export function maskedKey(key?: string): string {
	if (!key) return "(not set)";
	if (key.length <= 8) return "••••";
	return key.slice(0, 4) + "…" + key.slice(-4);
}

export function baseV1(endpoint: string): string {
	return `${normalizeEndpoint(endpoint)}/v1`;
}

export function isSyncStale(lastSync?: string, maxAgeMs = STALE_SYNC_MS): boolean {
	if (!lastSync) return true;
	const t = Date.parse(lastSync);
	if (Number.isNaN(t)) return true;
	return Date.now() - t > maxAgeMs;
}

// ── Footer status (single slot for both extensions) ─────────────

/** Default on/off for capability tools — derived from CAPS, no manual sync. */
export const TOOL_CAP_DEFAULTS: Record<string, boolean> = Object.fromEntries(
	CAPS.map((c) => [c.id, c.defaultEnabled]),
);

/** One footer key so we never show two competing "9router" / "tools" lines. */
export const FOOTER_STATUS_ID = "9router";
/** Cleared on paint so older installs drop the second status chip. */
export const FOOTER_STATUS_LEGACY_ID = "9router-tools";

export interface FooterSnapshot {
	/** false hides the chip entirely (default true) */
	enabled: boolean;
	chatCount: number;
	toolsOn: number;
	toolsTotal: number;
	lastSync?: string;
}

export function countEnabledTools(
	capabilities?: Partial<Record<string, { enabled?: boolean }>>,
): { on: number; total: number } {
	const ids = Object.keys(TOOL_CAP_DEFAULTS);
	let on = 0;
	for (const id of ids) {
		const saved = capabilities?.[id]?.enabled;
		const enabled = saved ?? TOOL_CAP_DEFAULTS[id];
		if (enabled) on++;
	}
	return { on, total: ids.length };
}

/** Footer chip is on unless `showFooter` is explicitly false in 9router.json. */
export function isFooterEnabled(raw: Record<string, unknown> = loadJsonFile()): boolean {
	return raw.showFooter !== false;
}

export function setFooterEnabled(enabled: boolean): void {
	saveJsonMerge({ showFooter: enabled });
}

/** Build footer snapshot from the shared 9router.json blob. */
export function footerFromConfig(raw: Record<string, unknown> = loadJsonFile()): FooterSnapshot {
	const chatModels = raw.chatModels;
	const chatCount = Array.isArray(chatModels) ? chatModels.length : 0;
	const caps = raw.capabilities as Partial<Record<string, { enabled?: boolean }>> | undefined;
	const { on, total } = countEnabledTools(caps);
	return {
		enabled: raw.showFooter !== false,
		chatCount,
		toolsOn: on,
		toolsTotal: total,
		lastSync: typeof raw.lastSync === "string" ? raw.lastSync : undefined,
	};
}

/**
 * Footer chip text.
 *
 * Examples:
 *   `9router(sync)`
 *   `9router(95 Models · 3/5 Tools)`
 *   `9router(95 Models · 3/5 Tools · stale)`
 */
export function formatFooterText(snap: FooterSnapshot): { text: string; tone: "dim" | "warning" } {
	const stale = isSyncStale(snap.lastSync);
	if (!snap.lastSync && snap.chatCount === 0) {
		return { text: "9router(sync)", tone: "dim" };
	}
	const inner: string[] = [];
	if (snap.chatCount > 0) {
		inner.push(`${snap.chatCount} Model${snap.chatCount === 1 ? "" : "s"}`);
	} else {
		inner.push("no models");
	}
	if (snap.toolsTotal > 0) {
		inner.push(`${snap.toolsOn}/${snap.toolsTotal} Tools`);
	}
	if (stale) inner.push("stale");
	return {
		text: `9router(${inner.join(" · ")})`,
		tone: stale ? "warning" : "dim",
	};
}

type StatusUi = {
	setStatus: (id: string, text: string | undefined) => void;
	theme: Pick<Theme, "fg">;
};

/**
 * Paint or clear the single 9Router footer chip.
 * Always clears the legacy `9router-tools` chip from older installs.
 */
export function paintFooterStatus(ui: StatusUi, snap?: FooterSnapshot): void {
	ui.setStatus(FOOTER_STATUS_LEGACY_ID, undefined);
	const s = snap ?? footerFromConfig();
	if (!s.enabled) {
		ui.setStatus(FOOTER_STATUS_ID, undefined);
		return;
	}
	const { text, tone } = formatFooterText(s);
	ui.setStatus(FOOTER_STATUS_ID, ui.theme.fg(tone, text));
}

// ── Abort / timeout ─────────────────────────────────────────────

/** Combine optional parent signal with a timeout. */
export function withTimeout(timeoutMs: number, parent?: AbortSignal): AbortSignal {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
	const onParent = () => {
		clearTimeout(timer);
		ctrl.abort(parent?.reason ?? new Error("aborted"));
	};
	if (parent) {
		if (parent.aborted) onParent();
		else parent.addEventListener("abort", onParent, { once: true });
	}
	// Clear timer and detach the parent listener when we abort for any reason
	ctrl.signal.addEventListener(
		"abort",
		() => {
			clearTimeout(timer);
			parent?.removeEventListener("abort", onParent);
		},
		{ once: true },
	);
	return ctrl.signal;
}

function errMsg(err: unknown): string {
	if (!err) return "unknown error";
	if (err instanceof Error) {
		if (err.name === "AbortError" || /timeout/i.test(err.message)) {
			return err.message.includes("timeout") ? err.message : "aborted";
		}
		return err.message || String(err);
	}
	return String(err);
}

// ── HTTP ────────────────────────────────────────────────────────

export function authHeaders(apiKey: string, json = false): Record<string, string> {
	const h: Record<string, string> = { Accept: json ? "application/json" : "*/*" };
	if (json) h["Content-Type"] = "application/json";
	// Always send Bearer — dummy "9router" is fine when auth is off
	if (apiKey) h.Authorization = `Bearer ${apiKey}`;
	return h;
}

export async function httpGetJson<T>(
	url: string,
	apiKey: string,
	opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<{ ok: true; data: T } | { ok: false; status: number; error: string }> {
	const signal = withTimeout(opts.timeoutMs ?? TIMEOUT.list, opts.signal);
	try {
		const res = await fetch(url, {
			method: "GET",
			headers: authHeaders(apiKey, true),
			signal,
		});
		if (!res.ok) {
			const body = (await res.text()).slice(0, 240);
			return { ok: false, status: res.status, error: body || res.statusText };
		}
		return { ok: true, data: (await res.json()) as T };
	} catch (err) {
		return { ok: false, status: 0, error: errMsg(err) };
	}
}

export async function healthCheck(
	endpoint: string,
	opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<{ ok: boolean; error?: string; ms?: number }> {
	const signal = withTimeout(opts.timeoutMs ?? TIMEOUT.health, opts.signal);
	const t0 = Date.now();
	try {
		const res = await fetch(`${normalizeEndpoint(endpoint)}/api/health`, {
			signal,
			headers: { Accept: "application/json" },
		});
		const ms = Date.now() - t0;
		if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, ms };
		const data = (await res.json()) as { ok?: boolean };
		return { ok: data.ok === true, ms, error: data.ok === true ? undefined : "health.ok !== true" };
	} catch (err) {
		return { ok: false, error: errMsg(err), ms: Date.now() - t0 };
	}
}

export async function postJson(
	url: string,
	apiKey: string,
	body: unknown,
	opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<{ ok: true; status: number; data: any } | { ok: false; status: number; error: string }> {
	const signal = withTimeout(opts.timeoutMs ?? TIMEOUT.tool, opts.signal);
	try {
		const res = await fetch(url, {
			method: "POST",
			headers: authHeaders(apiKey, true),
			body: JSON.stringify(body),
			signal,
		});
		const text = await res.text();
		let data: any = null;
		try {
			data = text ? JSON.parse(text) : null;
		} catch {
			data = text;
		}
		if (!res.ok) {
			const msg =
				typeof data === "string"
					? data.slice(0, 400)
					: data?.error?.message || data?.message || JSON.stringify(data).slice(0, 400);
			return { ok: false, status: res.status, error: msg || res.statusText };
		}
		return { ok: true, status: res.status, data };
	} catch (err) {
		return { ok: false, status: 0, error: errMsg(err) };
	}
}

export async function postBinary(
	url: string,
	apiKey: string,
	body: unknown,
	opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<
	| { ok: true; status: number; bytes: Uint8Array; contentType: string }
	| { ok: false; status: number; error: string }
> {
	const signal = withTimeout(opts.timeoutMs ?? TIMEOUT.tool, opts.signal);
	try {
		const res = await fetch(url, {
			method: "POST",
			headers: authHeaders(apiKey, true),
			body: JSON.stringify(body),
			signal,
		});
		if (!res.ok) {
			const text = (await res.text()).slice(0, 400);
			return { ok: false, status: res.status, error: text || res.statusText };
		}
		return {
			ok: true,
			status: res.status,
			bytes: new Uint8Array(await res.arrayBuffer()),
			contentType: res.headers.get("content-type") || "application/octet-stream",
		};
	} catch (err) {
		return { ok: false, status: 0, error: errMsg(err) };
	}
}

export async function downloadUrl(
	url: string,
	opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<{ bytes: Uint8Array; contentType: string } | null> {
	const signal = withTimeout(opts.timeoutMs ?? TIMEOUT.download, opts.signal);
	try {
		const res = await fetch(url, { signal });
		if (!res.ok) return null;
		return {
			bytes: new Uint8Array(await res.arrayBuffer()),
			contentType: res.headers.get("content-type") || "application/octet-stream",
		};
	} catch {
		return null;
	}
}

// ── Concurrency ─────────────────────────────────────────────────

export async function mapConcurrent<T, R>(
	items: T[],
	limit: number,
	task: (item: T) => Promise<R>,
	signal?: AbortSignal,
): Promise<R[]> {
	const out: R[] = new Array(items.length);
	let next = 0;
	async function worker() {
		while (next < items.length) {
			if (signal?.aborted) return;
			const i = next++;
			out[i] = await task(items[i]);
		}
	}
	const n = Math.min(limit, Math.max(1, items.length));
	await Promise.all(Array.from({ length: n }, () => worker()));
	return out;
}

// ── Small utils ─────────────────────────────────────────────────

export function asCaps(raw: RemoteModel["capabilities"]): ModelCapabilities | undefined {
	if (!raw) return undefined;
	if (Array.isArray(raw)) {
		const out: ModelCapabilities = {};
		for (const tag of raw) {
			const t = String(tag).toLowerCase();
			if (t.includes("image") || t === "texttoimage" || t === "edit") out.imageOutput = true;
			if (t === "vision") out.vision = true;
			if (t === "reasoning" || t === "thinking") out.reasoning = true;
		}
		return out;
	}
	const out: ModelCapabilities = { ...raw };
	// Live resolvers (e.g. kiro) report `thinking` instead of `reasoning`.
	if (out.reasoning === undefined && out.thinking != null) {
		out.reasoning = out.thinking === true || out.thinking === "true";
	}
	return out;
}

/**
 * List row already has enough metadata to skip /v1/models/info.
 *
 * Chat lists often ship full capabilities without a display name or kind field
 * — that is still enough to register a pi model. Image/web lists are usually
 * thin ({ id, owned_by } only) and still need an info lookup for real names.
 */
export function listRowIsRich(m: RemoteModel): boolean {
	const caps = asCaps(m.capabilities);
	if (Array.isArray(m.capabilities) && m.capabilities.length > 0) return true;
	if (!caps || typeof caps !== "object") return false;
	// Numeric context / output is the strong signal from chat list endpoints.
	if (typeof caps.contextWindow === "number" && caps.contextWindow > 0) return true;
	if (typeof caps.maxOutput === "number" && caps.maxOutput > 0) return true;
	const hasName = Boolean(m.name?.trim());
	const hasKind = Boolean(m.kind?.trim());
	const hasFlag =
		caps.vision != null || caps.reasoning != null || caps.imageOutput != null || caps.tools != null;
	return hasFlag && (hasName || hasKind);
}

export function inferNameFromId(id: string): string {
	const slash = id.indexOf("/");
	const leaf = slash >= 0 ? id.slice(slash + 1) : id;
	return leaf
		.replace(/[-_]/g, " ")
		.replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Sanitize a model-supplied output file name: no separators, no traversal. */
export function safeFilename(name: string): string {
	return name.replace(/[^\w.\-]+/g, "_");
}
