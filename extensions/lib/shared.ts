/**
 * Shared helpers for 9router.ts and 9router-tools.ts.
 * Not an extension entry point (no default export) — only imported.
 */

import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
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
	/** Video generation is async + polled — allow minutes, not seconds. */
	video: 600_000,
} as const;

/** Warn when lastSync is older than this. */
export const STALE_SYNC_MS = 24 * 60 * 60 * 1000;

/** Negative info-cache TTL — skip re-probing ids the server doesn't know. */
export const INFO_MISSING_TTL = 24 * 60 * 60 * 1000;

/**
 * Positive info-cache TTL — reuse a fetched /v1/models/info record for 7d.
 * Stored in 9router.json as `infoCache` (`kind\0id` → { fetchedAt, info }),
 * unified with the 24 h negative `infoMissing` cache: saveJsonMerge
 * union-merges both maps key-wise (merge-safe across the two extensions)
 * and prunes expired entries on every write so the blob stays bounded.
 */
export const INFO_CACHE_TTL = 7 * 24 * 60 * 60 * 1000;

export interface InfoCacheEntry {
	fetchedAt: number;
	info: RemoteModel;
}

export function isInfoCacheFresh(
	entry: InfoCacheEntry | undefined,
	now: number = Date.now(),
): boolean {
	return (
		!!entry &&
		typeof entry.fetchedAt === "number" &&
		now - entry.fetchedAt < INFO_CACHE_TTL
	);
}

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
	/**
	 * Quick-sync aging (ticket 3): consecutive syncs this entry was carried
	 * over without being confirmed by a list fetch. Full sync rebuilds from
	 * fresh lists, so present entries come back clean and deleted ones prune.
	 */
	absentSyncs?: number;
	/** True once absentSyncs hits the threshold — run a full sync to confirm. */
	stale?: boolean;
	/**
	 * Caps provenance: true when any caps field was filled from the local
	 * MODEL_PATTERN_CAPS fallback table (live list row + /v1/models/info
	 * both left gaps). Browse shows this as a "pattern fallback" vs
	 * "live server info" badge; sync reports the fallback-hit count.
	 */
	capsFromPattern?: boolean;
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

export type CapId = "image" | "tts" | "embed" | "web_search" | "web_fetch" | "video" | "stt";

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
	{
		id: "video",
		tool: "nr_video_generate",
		label: "Video generation",
		catalogKind: (e) => e.kind === "video",
		defaultEnabled: true,
		blurb: "Text/image → video file",
	},
	{
		id: "stt",
		tool: "nr_stt",
		label: "Speech to text",
		catalogKind: "stt",
		defaultEnabled: false,
		blurb: "Audio file → transcript",
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
	return "voice" in raw || "ffmpegPath" in raw;
}

function stripLegacyKeys(next: Record<string, unknown>): Record<string, unknown> {
	delete next.voice;
	delete next.ffmpegPath;
	return next;
}

/** Plain-record guard for boundary validation (arrays and null are not records). */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate `infoMissing` (bare-id → timestamp) on load. Drops non-numeric
 *  (NaN/null/string), non-finite, and expired entries; string/array blobs
 *  become empty maps so enrich/merge/reload never crash or resurrect. */
export function sanitizeInfoMissing(value: unknown, now: number = Date.now()): Record<string, number> | undefined {
	if (value === undefined) return undefined;
	if (!isPlainRecord(value)) return {};
	const out: Record<string, number> = {};
	for (const [id, ts] of Object.entries(value)) {
		if (typeof ts !== "number" || !Number.isFinite(ts)) continue;
		if (now - ts >= INFO_MISSING_TTL) continue;
		out[id] = ts;
	}
	return out;
}

/** Boundary constructor: rebuild a RemoteModel from untrusted cache data.
 *  Picks only known fields with per-field checks, so a malformed record can
 *  never smuggle an illegal shape past the boundary (no casts). Unknown
 *  extra keys are dropped; mistyped optionals fall back to absent. */
export function toCachedInfo(value: unknown): RemoteModel | undefined {
	if (!isPlainRecord(value) || typeof value.id !== "string") return undefined;
	const info: RemoteModel = { id: value.id };
	for (const key of ["object", "owned_by", "name", "kind", "endpoint"] as const) {
		if (typeof value[key] === "string") info[key] = value[key];
	}
	if (Array.isArray(value.capabilities)) {
		info.capabilities = value.capabilities;
	} else if (isPlainRecord(value.capabilities)) {
		info.capabilities = value.capabilities;
	}
	if (Array.isArray(value.params) && value.params.every((p) => typeof p === "string")) {
		info.params = value.params;
	}
	if (value.options !== undefined) info.options = value.options;
	if (typeof value.created === "number" && Number.isFinite(value.created)) {
		info.created = value.created;
	}
	return info;
}

/** Validate `infoCache` (`kind\0id` → { fetchedAt, info }) on load. Drops
 *  non-record entries, non-finite/expired timestamps, and non-record info
 *  (including { info: null }) so malformed records never resurrect. */
export function sanitizeInfoCache(
	value: unknown,
	now: number = Date.now(),
): Record<string, InfoCacheEntry> | undefined {
	if (value === undefined) return undefined;
	if (!isPlainRecord(value)) return {};
	const out: Record<string, InfoCacheEntry> = {};
	for (const [id, entry] of Object.entries(value)) {
		if (!isPlainRecord(entry)) continue;
		const fetchedAt: unknown = entry.fetchedAt;
		if (typeof fetchedAt !== "number" || !Number.isFinite(fetchedAt)) continue;
		if (now - fetchedAt >= INFO_CACHE_TTL) continue;
		const info = toCachedInfo(entry.info);
		if (!info) continue;
		out[id] = { fetchedAt, info };
	}
	return out;
}

/** Validate `modelNames` (chat id → friendly name) on load. Keeps only
 *  non-empty strings; string/array blobs become empty maps. */
export function sanitizeModelNames(value: unknown): Record<string, string> | undefined {
	if (value === undefined) return undefined;
	if (!isPlainRecord(value)) return {};
	const out: Record<string, string> = {};
	for (const [id, name] of Object.entries(value)) {
		if (typeof name !== "string" || !name.trim()) continue;
		out[id] = name.trim();
	}
	return out;
}

/** Deep-merge top-level keys; merges `capabilities` one level when both sides set it. */
export function saveJsonMerge(
	patch: Record<string, unknown>,
	path: string = CONFIG_PATH,
): Record<string, unknown> {
	const loaded: unknown = loadJsonFile(path);
	const cur: Record<string, unknown> = isPlainRecord(loaded) ? loaded : {};
	const next: Record<string, unknown> = { ...cur, ...patch };
	if (isPlainRecord(patch.capabilities)) {
		const curCaps: Record<string, unknown> = isPlainRecord(cur.capabilities) ? cur.capabilities : {};
		const patchCaps: Record<string, unknown> = patch.capabilities;
		const merged: Record<string, unknown> = { ...curCaps };
		for (const [k, v] of Object.entries(patchCaps)) {
			if (!isPlainRecord(v)) continue;
			const base: Record<string, unknown> = isPlainRecord(curCaps[k]) ? (curCaps[k] as Record<string, unknown>) : {};
			merged[k] = { ...base, ...v };
		}
		next.capabilities = merged;
	}
	// Merge-safe caches + names: union per-id keys (patch wins per key) so a
	// concurrent write from the other extension never wipes fresh entries.
	// refreshModels persists chatModels + modelNames from stale in-memory
	// state — without the union a refresh would flush fresh on-disk names.
	for (const key of ["infoCache", "infoMissing", "modelNames"] as const) {
		if (isPlainRecord(patch[key])) {
		const base: Record<string, unknown> = isPlainRecord(cur[key])
			? (cur[key] as Record<string, unknown>)
			: {};
		next[key] = { ...base, ...(patch[key] as Record<string, unknown>) };
		}
	}
	pruneInfoCaches(next);
	stripLegacyKeys(next);
	writeJsonAtomic(path, next);
	return next;
}

/** Drop expired/malformed cache entries so the config blob stays bounded.
 *  Non-numeric timestamps (NaN/null/string), non-record info entries
 *  (including { info: null }), and non-string modelNames go — anything
 *  malformed is dropped rather than risk resurrection across
 *  enrich → prune → merge → reload. Non-record top-level blobs are removed. */
function pruneInfoCaches(next: Record<string, unknown>, now: number = Date.now()): void {
	const missing: unknown = next.infoMissing;
	if (missing !== undefined) {
		if (!isPlainRecord(missing)) {
			delete next.infoMissing;
		} else {
			for (const [id, ts] of Object.entries(missing)) {
				if (typeof ts !== "number" || !Number.isFinite(ts) || now - ts >= INFO_MISSING_TTL) {
					delete missing[id];
				}
			}
		}
	}
	const cache: unknown = next.infoCache;
	if (cache !== undefined) {
		if (!isPlainRecord(cache)) {
			delete next.infoCache;
		} else {
			for (const [id, entry] of Object.entries(cache)) {
				if (!isPlainRecord(entry)) {
					delete cache[id];
					continue;
				}
				const fetchedAt: unknown = entry.fetchedAt;
				const info: unknown = entry.info;
				if (typeof fetchedAt !== "number" || !Number.isFinite(fetchedAt) || now - fetchedAt >= INFO_CACHE_TTL) {
					delete cache[id];
					continue;
				}
				if (!isPlainRecord(info) || typeof info.id !== "string") {
					delete cache[id];
				}
			}
		}
	}
	const names: unknown = next.modelNames;
	if (names !== undefined) {
		if (!isPlainRecord(names)) {
			delete next.modelNames;
		} else {
			for (const [id, name] of Object.entries(names)) {
				if (typeof name !== "string" || !name.trim()) delete names[id];
			}
		}
	}
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

// ── Usage log (cost/latency) ──────────────────────────────────────

/**
 * Bounded usage log next to the config (never in the repo).
 * One JSON object per line: { ts, tool, model, ms, ok, status?, bytes?, count?, note? }.
 * Writers never throw — a failed append must not break a tool call.
 * Bounded: an append that pushes the file past MAX_USAGE_BYTES rewrites
 * just the last MAX_USAGE_LINES lines, so the file (and every full-file
 * read per status render) stays capped.
 */
export const USAGE_PATH = join(dirname(CONFIG_PATH), "9router-usage.jsonl");

export const MAX_USAGE_BYTES = 256_000;
export const MAX_USAGE_LINES = 1000;

export interface UsageRecord {
	tool: string;
	model?: string;
	ms?: number;
	ok: boolean;
	status?: number;
	bytes?: number;
	count?: number;
	note?: string;
}

export interface UsageEntry extends UsageRecord {
	ts: string;
}

export function logUsage(rec: UsageRecord, path: string = USAGE_PATH): void {
	try {
		const dir = dirname(path);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		appendFileSync(path, JSON.stringify({ ts: new Date().toISOString(), ...rec }) + "\n");
		pruneUsageLog(path);
	} catch {
		/* usage logging never breaks tools */
	}
}

/** Rewrite the tail once the file exceeds MAX_USAGE_BYTES — never throws. */
function pruneUsageLog(path: string): void {
	try {
		if (statSync(path).size <= MAX_USAGE_BYTES) return;
		const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
		writeFileSync(path, lines.slice(-MAX_USAGE_LINES).join("\n") + "\n");
	} catch {
		/* pruning is best-effort; the next append retries */
	}
}

/** Last `maxLines` parsed records (newest last); corrupt lines are skipped. */
export function readUsageRecords(path: string = USAGE_PATH, maxLines = 200): UsageEntry[] {
	try {
		const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
		const out: UsageEntry[] = [];
		for (const line of lines.slice(-maxLines)) {
			try {
				const r = JSON.parse(line) as UsageEntry;
				if (r && typeof r.tool === "string") out.push(r);
			} catch {
			/* skip corrupt lines */
			}
		}
		return out;
	} catch {
		return [];
	}
}

function fmtMs(ms: number): string {
	return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

/** One-line usage summary for status surfaces — undefined when never logged. */
export function formatUsageSummary(path: string = USAGE_PATH): string | undefined {
	const recs = readUsageRecords(path);
	if (!recs.length) return undefined;
	const ok = recs.filter((r) => r.ok).length;
	const times = recs.filter((r) => typeof r.ms === "number").map((r) => r.ms as number);
	const avg = times.length ? times.reduce((a, b) => a + b, 0) / times.length : undefined;
	const last = recs[recs.length - 1];
	const bits = [`Usage: ${recs.length} call${recs.length === 1 ? "" : "s"}`, `${Math.round((ok / recs.length) * 100)}% ok`];
	if (avg != null) bits.push(`avg ${fmtMs(avg)}`);
	bits.push(`last ${last.tool}${last.model ? ` ${last.model}` : ""}${typeof last.ms === "number" ? ` ${fmtMs(last.ms)}` : ""}`);
	return bits.join(" · ");
}

/**
 * Per-tool usage breakdown from the bounded usage log — one line per tool
 * with call count, ok-rate, and average latency. Newest tool first by last
 * call; tools with no records are absent. Pure over readUsageRecords, so it
 * is locked by unit tests and shared by the /9router and /9router-tools
 * Status surfaces. Undefined when the log is empty.
 */
export function formatUsageByTool(path: string = USAGE_PATH): string[] | undefined {
	const recs = readUsageRecords(path);
	if (!recs.length) return undefined;
	const byTool = new Map<string, UsageEntry[]>();
	for (const r of recs) {
		const list = byTool.get(r.tool) ?? [];
		list.push(r);
		byTool.set(r.tool, list);
	}
	const lines: string[] = [];
	for (const tool of [...byTool.keys()].sort((a, b) => {
		// Most recently used tool first; alphabetical tiebreak for stability.
		const la = byTool.get(a)![byTool.get(a)!.length - 1].ts;
		const lb = byTool.get(b)![byTool.get(b)!.length - 1].ts;
		if (la !== lb) return la < lb ? 1 : -1;
		return a.localeCompare(b);
	})) {
		const rs = byTool.get(tool)!;
		const ok = rs.filter((r) => r.ok).length;
		const times = rs.filter((r) => typeof r.ms === "number").map((r) => r.ms as number);
		const avg = times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : undefined;
		lines.push(
			`  ${tool.padEnd(20)} ${String(rs.length).padStart(4)} calls  ${Math.round((ok / rs.length) * 100)}% ok${avg != null ? `  avg ${fmtMs(avg)}` : ""}`,
		);
	}
	return lines.length ? lines : undefined;
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

/** Create a timeout-bound signal with explicit cleanup — caller must call `clear()` when done. */
function createTimeoutSignal(timeoutMs: number, parent?: AbortSignal): { signal: AbortSignal; clear: () => void } {
	const ctrl = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(
		() => ctrl.abort(new Error(`timeout after ${timeoutMs}ms`)),
		timeoutMs,
	);
	const onParent = () => {
		if (timer) clearTimeout(timer);
		timer = undefined;
		ctrl.abort(parent?.reason ?? new Error("aborted"));
	};
	if (parent) {
		if (parent.aborted) onParent();
		else parent.addEventListener("abort", onParent, { once: true });
	}
	const clear = () => {
		if (timer) clearTimeout(timer);
		timer = undefined;
		parent?.removeEventListener("abort", onParent);
	};
	ctrl.signal.addEventListener("abort", clear, { once: true });
	return { signal: ctrl.signal, clear };
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

/** Cap for `fullError` bodies (video 403/poll detail) — full enough for the
 *  server explanation, bounded so a huge body can't blow up tool errors. */
export const FULL_ERROR_MAX = 2048;

export async function httpGetJson<T>(
	url: string,
	apiKey: string,
	opts: { signal?: AbortSignal; timeoutMs?: number; headers?: Record<string, string>; fullError?: boolean } = {},
): Promise<{ ok: true; data: T } | { ok: false; status: number; error: string }> {
	const { signal, clear } = createTimeoutSignal(opts.timeoutMs ?? TIMEOUT.list, opts.signal);
	try {
		const res = await fetch(url, {
			method: "GET",
			headers: { ...authHeaders(apiKey, true), ...(opts.headers || {}) },
			signal,
		});
		if (!res.ok) {
			// fullError keeps up to FULL_ERROR_MAX of server detail (video 403) — otherwise cap it.
			const body = (await res.text()).slice(0, opts.fullError ? FULL_ERROR_MAX : 240);
			clear();
			return { ok: false, status: res.status, error: body || res.statusText };
		}
		const data = (await res.json()) as T;
		clear();
		return { ok: true, data };
	} catch (err) {
		clear();
		return { ok: false, status: 0, error: errMsg(err) };
	}
}

export async function healthCheck(
	endpoint: string,
	opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<{ ok: boolean; error?: string; ms?: number }> {
	const { signal, clear } = createTimeoutSignal(opts.timeoutMs ?? TIMEOUT.health, opts.signal);
	const t0 = Date.now();
	try {
		const res = await fetch(`${normalizeEndpoint(endpoint)}/api/health`, {
			signal,
			headers: { Accept: "application/json" },
		});
		const ms = Date.now() - t0;
		if (!res.ok) {
			clear();
			return { ok: false, error: `HTTP ${res.status}`, ms };
		}
		const data = (await res.json()) as { ok?: boolean };
		clear();
		return { ok: data.ok === true, ms, error: data.ok === true ? undefined : "health.ok !== true" };
	} catch (err) {
		clear();
		return { ok: false, error: errMsg(err), ms: Date.now() - t0 };
	}
}

export async function postJson(
	url: string,
	apiKey: string,
	body: unknown,
	opts: { signal?: AbortSignal; timeoutMs?: number; fullError?: boolean } = {},
): Promise<
	| { ok: true; status: number; data: any; headers: Record<string, string> }
	| { ok: false; status: number; error: string }
> {
	const { signal, clear } = createTimeoutSignal(opts.timeoutMs ?? TIMEOUT.tool, opts.signal);
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
			// fullError keeps up to FULL_ERROR_MAX of server detail (video 403) — otherwise cap it.
			const msg =
				typeof data === "string"
					? data.slice(0, opts.fullError ? FULL_ERROR_MAX : 400)
					: data?.error?.message || data?.message || JSON.stringify(data).slice(0, opts.fullError ? FULL_ERROR_MAX : 400);
			clear();
			return { ok: false, status: res.status, error: msg || res.statusText };
		}
		const headers: Record<string, string> = {};
		res.headers.forEach((v, k) => {
			headers[k] = v;
		});
		clear();
		return { ok: true, status: res.status, data, headers };
	} catch (err) {
		clear();
		return { ok: false, status: 0, error: errMsg(err) };
	}
}

/**
 * Multipart upload (e.g. /v1/audio/transcriptions). `form` carries files;
 * fetch sets the multipart Content-Type boundary itself.
 * Returns raw text + content-type so text/srt/vtt responses work too.
 */
export async function postMultipart(
	url: string,
	apiKey: string,
	form: FormData,
	opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<
	| { ok: true; status: number; text: string; contentType: string }
	| { ok: false; status: number; error: string }
> {
	const { signal, clear } = createTimeoutSignal(opts.timeoutMs ?? TIMEOUT.tool, opts.signal);
	try {
		const res = await fetch(url, {
			method: "POST",
			headers: { Authorization: `Bearer ${apiKey}`, Accept: "*/*" },
			body: form,
			signal,
		});
		const text = await res.text();
		if (!res.ok) {
			let msg = text.slice(0, 400);
			try {
				const data = JSON.parse(text);
				msg = data?.error?.message || data?.message || msg;
			} catch {
				/* plain text error */
			}
			clear();
			return { ok: false, status: res.status, error: msg || res.statusText };
		}
		clear();
		return {
			ok: true,
			status: res.status,
			text,
			contentType: res.headers.get("content-type") || "text/plain",
		};
	} catch (err) {
		clear();
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
	const { signal, clear } = createTimeoutSignal(opts.timeoutMs ?? TIMEOUT.tool, opts.signal);
	try {
		const res = await fetch(url, {
			method: "POST",
			headers: authHeaders(apiKey, true),
			body: JSON.stringify(body),
			signal,
		});
		if (!res.ok) {
			const text = (await res.text()).slice(0, 400);
			clear();
			return { ok: false, status: res.status, error: text || res.statusText };
		}
		const bytes = new Uint8Array(await res.arrayBuffer());
		clear();
		return {
			ok: true,
			status: res.status,
			bytes,
			contentType: res.headers.get("content-type") || "application/octet-stream",
		};
	} catch (err) {
		clear();
		return { ok: false, status: 0, error: errMsg(err) };
	}
}

/**
 * GET a URL to bytes. Failures keep the HTTP status (status 0 for
 * network/abort) so callers can report and log it — never bare null.
 */
export async function downloadUrl(
	url: string,
	opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<
	| { ok: true; bytes: Uint8Array; contentType: string }
	| { ok: false; status: number; error: string }
> {
	const { signal, clear } = createTimeoutSignal(opts.timeoutMs ?? TIMEOUT.download, opts.signal);
	try {
		const res = await fetch(url, { signal });
		if (!res.ok) {
			clear();
			return { ok: false, status: res.status, error: res.statusText || `HTTP ${res.status}` };
		}
		const out = {
			ok: true as const,
			bytes: new Uint8Array(await res.arrayBuffer()),
			contentType: res.headers.get("content-type") || "application/octet-stream",
		};
		clear();
		return out;
	} catch (err) {
		clear();
		return { ok: false, status: 0, error: errMsg(err) };
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

/** True when the entry carries live server caps (slim caps, context, or output). */
function hasLiveCaps(e: Pick<CatalogEntry, "capabilities" | "contextWindow" | "maxTokens">): boolean {
	const c = e.capabilities;
	if (Array.isArray(c) ? c.length > 0 : !!c && typeof c === "object" && Object.keys(c).length > 0) {
		return true;
	}
	return (e.contextWindow ?? 0) > 0 || (e.maxTokens ?? 0) > 0;
}

/** Rich-row check over a catalog entry (adapts it to a list row for listRowIsRich). */
function entryIsRich(e: CatalogEntry): boolean {
	if ((e.contextWindow ?? 0) > 0 || (e.maxTokens ?? 0) > 0) return true;
	if ((e.params?.length ?? 0) > 0) return true;
	return listRowIsRich({
		id: e.id,
		name: e.name,
		kind: e.detailKind ?? e.kind,
		capabilities: e.capabilities,
	});
}

/**
 * Capability-aware auto default: when the user omits `model` and no default
 * is set, prefer the first rich row (live caps via listRowIsRich) over a
 * thin `{ id, owned_by }`-style entry. Falls back to the first entry when
 * nothing is rich, undefined when the list is empty.
 */
export function pickAutoDefaultModel(models: CatalogEntry[]): CatalogEntry | undefined {
	if (!models.length) return undefined;
	return models.find(entryIsRich) ?? models[0];
}

export type CapsClass = "rich" | "thin" | "missing";

/**
 * Caps provenance class for browse filters + badges:
 * rich = live server caps · thin = pattern fallback filled a thin live row ·
 * missing = no caps at all (re-sync to confirm).
 */
export function capsClassOf(e: CatalogEntry): CapsClass {
	if (e.capsFromPattern) return "thin";
	return hasLiveCaps(e) ? "rich" : "missing";
}

/** Browse detail badge for caps provenance (single source — matches usage docs). */
export function capsBadgeOf(e: CatalogEntry): string {
	const c = capsClassOf(e);
	if (c === "thin") return "caps source: pattern fallback (local estimate — live list/info had gaps)";
	if (c === "rich") return "caps source: live server info";
	return "caps source: missing (no live caps — run full sync)";
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
