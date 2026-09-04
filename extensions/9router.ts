/**
 * pi-9router — Sync 9Router models into pi
 *
 * /9router  — TUI: endpoint, API key, fetch catalog, register chat models
 *
 * Chat models are registered as provider "9router" via pi.registerProvider()
 * using metadata from GET /v1/models (capabilities.contextWindow, vision, …).
 * Image / TTS / embedding / web catalogs are fetched and stored for browse
 * (and for /9router-tools). Only chat (LLM) models are registered with pi's model picker.
 *
 * List endpoints often return only { id, object, owned_by }. When a row already
 * carries name + capabilities (common for chat), we skip /v1/models/info for it.
 * Thin rows are still enriched so display names and web detailKind are real.
 *
 * edge-tts / google-tts are noAuth voice providers with no list-endpoint entry;
 * they are probed with a short synthesis call and only added when they respond.
 *
 * The registered provider also exposes a live `refreshModels` hook, so pi-side
 * refresh flows (e.g. `pi update --models`) re-fetch the chat list without a
 * manual /9router sync. On failure it falls back to the cached models so a
 * refresh never wipes the provider.
 *
 * Config: ~/.pi/agent/9router.json
 * Env:    NINEROUTER_URL, NINEROUTER_KEY
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	CONFIG_PATH,
	DEFAULT_ENDPOINT,
	INFO_CACHE_TTL,
	INFO_MISSING_TTL,
	TIMEOUT,
	STALE_SYNC_MS,
	type CatalogEntry,
	type InfoCacheEntry,
	type ModelCapabilities,
	type RemoteModel,
	asCaps,
	authHeaders,
	baseV1,
	capsBadgeOf,
	capsClassOf,
	formatUsageSummary,
	healthCheck,
	httpGetJson,
	inferNameFromId,
	isInfoCacheFresh,
	isSyncStale,
	listRowIsRich,
	loadJsonFile,
	mapConcurrent,
	maskedKey,
	normalizeEndpoint,
	postBinary,
	resolveApiKey,
	sanitizeInfoCache,
	sanitizeInfoMissing,
	sanitizeModelNames,
	saveJsonMerge,
	paintFooterStatus,
	footerFromConfig,
	isFooterEnabled,
	setFooterEnabled,
	withTimeout,
} from "./lib/shared.ts";

// ── Constants ───────────────────────────────────────────────────

const PROVIDER_ID = "9router";
const PROVIDER_NAME = "9Router";
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;

/** Full multi-kind catalog (tools + browse). Video has no list endpoint —
 *  its tool uses the documented `xai/grok-imagine-video` id directly. */
const FULL_CATALOG_KINDS = [
	"chat",
	"image",
	"tts",
	"stt",
	"embedding",
	"web",
	"image-to-text",
] as const;

/** Chat-only quick sync — skips tool catalogs and voice probes. */
const QUICK_CATALOG_KINDS = ["chat"] as const;

/** Diagnose list probes (ticket 5): chat first (sample id reuses this list),
 *  then tool catalogs. Video has no list endpoint — a FAIL row with latency
 *  is still informative, so it is probed last. */
export const DIAGNOSE_PROBE_KINDS = [
	"chat",
	"image",
	"tts",
	"stt",
	"embedding",
	"web",
	"image-to-text",
	"video",
] as const;

/** Gated debug logging — off by default. Enable topics with
 *  `NR_DEBUG=sync,timing` (comma-separated, case-insensitive). */
export function isDebugTopic(topic: string): boolean {
	const raw = process.env.NR_DEBUG ?? "";
	return raw
		.split(",")
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean)
		.includes(topic.toLowerCase());
}

export function debugLog(topic: "sync" | "timing", msg: string): void {
	if (!isDebugTopic(topic)) return;
	console.error(`[9router:${topic}] ${msg}`);
}

/** Triage status line (ticket 5): last-sync mode, per-kind counts, stale
 *  flag, and missing-info (negative-cache) count. Shared by the Status TUI
 *  and the diagnose output so both surfaces stay in sync. */
export function formatTriageLine(input: {
	lastSync?: string;
	lastSyncMode?: string;
	counts?: Partial<Record<string, number>>;
	stale: boolean;
	infoMissingCount: number;
}): string {
	const entries = Object.entries(input.counts ?? {}).filter(
		(e): e is [string, number] => typeof e[1] === "number",
	);
	const countsStr = entries.length
		? entries.map(([k, n]) => `${k}:${n}`).join("  ")
		: "no counts";
	return `Triage:   last sync ${input.lastSync ?? "never"}${input.lastSyncMode ? ` (${input.lastSyncMode})` : ""} · ${countsStr} · ${input.stale ? "stale" : "fresh"} · missing-info: ${input.infoMissingCount}`;
}

/**
 * Honest info-probe breakdown for the sync report. Each label shows its own
 * counter — no conflation:
 * probed = info HTTP probes issued · hits = probed - misses ·
 * misses = probes returning no record · cache hits = 7 d positive-cache
 * reuse (no HTTP) · negative-skips = 24 h negative-cache skips (no HTTP) ·
 * rich-skips = rows skipped as already rich (list row, synthetic, or
 * preserved with metadata — the remainder of infoSkipped).
 */
export function formatInfoLine(input: {
	infoFetched?: number;
	infoMissed?: number;
	infoCached?: number;
	infoSkippedNegative?: number;
	infoSkipped?: number;
}): string {
	const probed = input.infoFetched ?? 0;
	const misses = input.infoMissed ?? 0;
	const cached = input.infoCached ?? 0;
	const negative = input.infoSkippedNegative ?? 0;
	const skipped = input.infoSkipped ?? 0;
	return `Info probed: ${probed} (hits ${probed - misses} · misses ${misses}) · cache hits (7d): ${cached} · negative-skips: ${negative} · rich-skips: ${skipped - cached - negative}`;
}

type CatalogKind = string;

const INFO_CONCURRENCY = 8;

/**
 * Quick-sync stale threshold (ticket 3): preserved non-chat entries carried
 * over unseen for this many consecutive syncs are flagged `stale` instead
 * of looking freshly synced. A sync that lists the id again clears it.
 */
export const QUICK_STALE_AFTER_ABSENT = 2;

/**
 * Voice-based TTS providers 9Router routes without credentials (noAuth).
 * Absent from /v1/models/tts; probed during full sync only.
 */
const VOICE_TTS_PROVIDERS: Array<{
	provider: string;
	voices: string[];
	probe: string;
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
		voices: ["en", "de", "fr", "es", "vi", "ja", "ar", "hi"],
		probe: "en",
		enumerable: false,
		note: "model is a 2-letter language code",
	},
];

// ── Types ───────────────────────────────────────────────────────

interface PiModelDef {
	id: string;
	name: string;
	reasoning: boolean;
	input: Array<"text" | "image">;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
	compat?: Record<string, unknown>;
	/** Caps provenance: true when context/vision/reasoning came from the
	 *  local MODEL_PATTERN_CAPS fallback (not live server caps). Refresh
	 *  re-runs pattern inference for capless rows with a pattern-derived
	 *  hint instead of trusting the hint indefinitely. */
	capsFromPattern?: boolean;
}

interface Config {
	endpoint: string;
	apiKey?: string;
	lastSync?: string;
	lastSyncMode?: "quick" | "full";
	chatModels?: PiModelDef[];
	catalog?: CatalogEntry[];
	counts?: Partial<Record<string, number>>;
	/** bare-id → timestamp — ids the server has no info record for (24 h TTL). */
	infoMissing?: Record<string, number>;
	/** `kind\0id` → { fetchedAt, info } — fetched info records (7 d TTL). */
	infoCache?: Record<string, InfoCacheEntry>;
	/** chat id → last-known friendly server name (full sync). Refresh reuses these for thin rows. */
	modelNames?: Record<string, string>;
}

export type SyncMode = "quick" | "full";

// ── Config ──────────────────────────────────────────────────────

function defaultConfig(): Config {
	return {
		endpoint: normalizeEndpoint(),
		apiKey: process.env.NINEROUTER_KEY || undefined,
	};
}

function loadConfig(): Config {
	const base = defaultConfig();
	const raw = loadJsonFile() as Partial<Config>;
	if (!Object.keys(raw).length) return base;
	return {
		endpoint: normalizeEndpoint(
			typeof raw.endpoint === "string" ? raw.endpoint : base.endpoint,
		),
		apiKey: typeof raw.apiKey === "string" ? raw.apiKey : base.apiKey,
		lastSync: typeof raw.lastSync === "string" ? raw.lastSync : undefined,
		lastSyncMode: raw.lastSyncMode === "quick" || raw.lastSyncMode === "full" ? raw.lastSyncMode : undefined,
		chatModels: Array.isArray(raw.chatModels) ? raw.chatModels : undefined,
		catalog: Array.isArray(raw.catalog) ? raw.catalog : undefined,
		counts:
			raw.counts !== null && typeof raw.counts === "object" && !Array.isArray(raw.counts)
				? (raw.counts as Config["counts"])
				: undefined,
		infoMissing: sanitizeInfoMissing(raw.infoMissing),
		infoCache: sanitizeInfoCache(raw.infoCache),
		modelNames: sanitizeModelNames(raw.modelNames),
	};
}

function saveConfig(config: Config): void {
		saveJsonMerge({
		endpoint: normalizeEndpoint(config.endpoint),
		apiKey: config.apiKey,
		lastSync: config.lastSync,
		lastSyncMode: config.lastSyncMode,
		chatModels: config.chatModels,
		catalog: config.catalog,
		counts: config.counts,
		infoMissing: config.infoMissing,
		infoCache: config.infoCache,
		modelNames: config.modelNames,
	});
}

// ── Catalog mapping ─────────────────────────────────────────────

function inferName(m: RemoteModel, infoName?: string): string {
	if (infoName?.trim()) return infoName.trim();
	if (m.name?.trim()) return m.name.trim();
	return inferNameFromId(m.id);
}

function looksReasoning(id: string, caps?: ModelCapabilities): boolean {
	if (caps?.reasoning === true) return true;
	const s = id.toLowerCase();
	return /thinking|reasoner|reason|-r1\b|o1\b|o3\b|o4\b/.test(s);
}

/**
 * Fallback capability table mirroring 9Router's own resolver
 * (open-sse/providers/capabilities.js → getCapabilitiesForModel) for models
 * whose /v1/models list row omits contextWindow/maxOutput (live-resolver
 * providers like kiro/kr, combos). Values are the server's resolved caps
 * (its DEFAULT_CAPABILITIES floor 200000/64000 merged with each pattern).
 * Only missing fields are filled — explicit server caps always win.
 */
const MODEL_PATTERN_CAPS: Array<{
	pattern: string;
	caps: Partial<ModelCapabilities>;
}> = [
	// ── Claude ──
	{ pattern: "*claude*opus-5*", caps: { vision: true, reasoning: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 } },
	{ pattern: "*claude*opus-4.6*", caps: { vision: true, reasoning: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 } },
	{ pattern: "*claude*opus-4.7*", caps: { vision: true, reasoning: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 } },
	{ pattern: "*claude*opus-4.8*", caps: { vision: true, reasoning: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 } },
	{ pattern: "*claude*sonnet-4.6*", caps: { vision: true, reasoning: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 } },
	{ pattern: "*claude*sonnet-4.7*", caps: { vision: true, reasoning: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 } },
	{ pattern: "*claude*sonnet-5*", caps: { vision: true, reasoning: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 } },
	{ pattern: "*claude*haiku*", caps: { vision: true, reasoning: true, thinkingFormat: "claude-budget", contextWindow: 200000, maxOutput: 64000 } },
	{ pattern: "*claude*opus*", caps: { vision: true, reasoning: true, thinkingFormat: "claude-budget", contextWindow: 200000, maxOutput: 64000 } },
	{ pattern: "*claude*sonnet*", caps: { vision: true, reasoning: true, thinkingFormat: "claude-budget", contextWindow: 200000, maxOutput: 64000 } },
	{ pattern: "*claude*", caps: { vision: true, reasoning: true, thinkingFormat: "claude-budget", contextWindow: 200000, maxOutput: 64000 } },
	// ── Gemini ──
	{ pattern: "*gemini-3*", caps: { vision: true, reasoning: true, thinkingFormat: "gemini-level", contextWindow: 1048576, maxOutput: 65536 } },
	{ pattern: "*gemini-2.5*", caps: { vision: true, reasoning: true, thinkingFormat: "gemini-budget", contextWindow: 1048576, maxOutput: 65536 } },
	{ pattern: "*gemini-2*", caps: { vision: true, contextWindow: 1048576, maxOutput: 65536 } },
	{ pattern: "*gemini*", caps: { vision: true, contextWindow: 1048576, maxOutput: 64000 } },
	{ pattern: "*gemma*", caps: { vision: true, contextWindow: 128000, maxOutput: 64000 } },
	// ── OpenAI GPT / o-series ──
	{ pattern: "*gpt-5*", caps: { vision: true, reasoning: true, thinkingFormat: "openai", contextWindow: 400000, maxOutput: 128000 } },
	{ pattern: "*gpt-4o*", caps: { vision: true, contextWindow: 128000, maxOutput: 16384 } },
	{ pattern: "*gpt-4.1*", caps: { vision: true, contextWindow: 1000000, maxOutput: 32768 } },
	{ pattern: "*gpt-4*", caps: { contextWindow: 128000, maxOutput: 64000 } },
	{ pattern: "*gpt-oss*", caps: { reasoning: true, thinkingFormat: "openai", contextWindow: 128000, maxOutput: 64000 } },
	{ pattern: "*o1*", caps: { vision: true, reasoning: true, thinkingFormat: "openai", contextWindow: 200000, maxOutput: 100000 } },
	{ pattern: "*o3*", caps: { vision: true, reasoning: true, thinkingFormat: "openai", contextWindow: 200000, maxOutput: 100000 } },
	{ pattern: "*o4*", caps: { vision: true, reasoning: true, thinkingFormat: "openai", contextWindow: 200000, maxOutput: 100000 } },
	// ── Grok ──
	{ pattern: "*grok-4.5*", caps: { vision: true, reasoning: true, thinkingFormat: "openai", contextWindow: 500000, maxOutput: 64000 } },
	{ pattern: "*grok-4*", caps: { vision: true, reasoning: true, thinkingFormat: "openai", contextWindow: 256000, maxOutput: 64000 } },
	{ pattern: "*grok*", caps: { vision: true, reasoning: true, thinkingFormat: "openai", contextWindow: 256000, maxOutput: 64000 } },
	// ── Qwen ──
	{ pattern: "*qwen*coder*", caps: { reasoning: true, thinkingFormat: "qwen", contextWindow: 1000000, maxOutput: 64000 } },
	{ pattern: "*qwen3.5*", caps: { vision: true, reasoning: true, thinkingFormat: "qwen", contextWindow: 1000000, maxOutput: 65536 } },
	{ pattern: "*qwen3.6*", caps: { vision: true, reasoning: true, thinkingFormat: "qwen", contextWindow: 1000000, maxOutput: 65536 } },
	{ pattern: "*qwen3.7*", caps: { vision: true, reasoning: true, thinkingFormat: "qwen", contextWindow: 1000000, maxOutput: 65536 } },
	{ pattern: "*qwen*max*", caps: { reasoning: true, thinkingFormat: "qwen", contextWindow: 1000000, maxOutput: 65536 } },
	{ pattern: "*qwen*", caps: { reasoning: true, thinkingFormat: "qwen", contextWindow: 262144, maxOutput: 64000 } },
	// ── Kimi ──
	{ pattern: "*kimi*k2*", caps: { vision: true, reasoning: true, thinkingFormat: "kimi", contextWindow: 262144, maxOutput: 262144 } },
	{ pattern: "*kimi*", caps: { reasoning: true, thinkingFormat: "kimi", contextWindow: 262144, maxOutput: 64000 } },
	// ── GLM / Z.ai ──
	{ pattern: "*glm-5*", caps: { reasoning: true, thinkingFormat: "zai", contextWindow: 200000, maxOutput: 128000 } },
	{ pattern: "*glm-4.7*", caps: { reasoning: true, thinkingFormat: "zai", contextWindow: 200000, maxOutput: 128000 } },
	{ pattern: "*glm*", caps: { reasoning: true, thinkingFormat: "zai", contextWindow: 200000, maxOutput: 64000 } },
	// ── DeepSeek ──
	{ pattern: "*deepseek-v4*", caps: { reasoning: true, thinkingFormat: "deepseek", contextWindow: 1000000, maxOutput: 384000 } },
	{ pattern: "*deepseek*", caps: { reasoning: true, thinkingFormat: "deepseek", contextWindow: 128000, maxOutput: 64000 } },
	// ── MiniMax ──
	{ pattern: "*minimax-m3*", caps: { vision: true, reasoning: true, thinkingFormat: "minimax", contextWindow: 1048576, maxOutput: 512000 } },
	{ pattern: "*minimax-m2.7*", caps: { reasoning: true, thinkingFormat: "minimax", thinkingCanDisable: false, contextWindow: 204800, maxOutput: 131072 } },
	{ pattern: "*minimax*", caps: { reasoning: true, thinkingFormat: "minimax", thinkingCanDisable: false, contextWindow: 200000, maxOutput: 131072 } },
	// ── Others ──
	{ pattern: "*hunyuan*", caps: { reasoning: true, thinkingFormat: "hunyuan", contextWindow: 262144, maxOutput: 262144 } },
	{ pattern: "*llama-4*", caps: { vision: true, contextWindow: 1000000, maxOutput: 64000 } },
	{ pattern: "*llama*", caps: { contextWindow: 128000, maxOutput: 64000 } },
	{ pattern: "*codestral*", caps: { contextWindow: 256000, maxOutput: 64000 } },
	{ pattern: "*mistral-large*", caps: { vision: true, contextWindow: 256000, maxOutput: 64000 } },
	{ pattern: "*mistral*", caps: { contextWindow: 128000, maxOutput: 64000 } },
	{ pattern: "*laguna*", caps: { reasoning: true, thinkingFormat: "openai", contextWindow: 200000, maxOutput: 32000 } },
	{ pattern: "*nemotron*", caps: { reasoning: true, contextWindow: 128000, maxOutput: 64000 } },
];

/** Glob match (* = wildcard), case-insensitive — same semantics as 9Router's matchPattern. */
export function globMatch(pattern: string, s: string): boolean {
	const re = new RegExp(
		"^" + pattern.split("*").map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$",
		"i",
	);
	return re.test(s);
}

/**
 * Fill capability gaps (contextWindow, maxOutput, reasoning, vision,
 * thinkingFormat) from MODEL_PATTERN_CAPS. Matches the leaf model id first
 * (same as the server's getCapabilitiesForModel baseModel), then the full id.
 * Explicit server fields are never overwritten.
 *
 * `onHit` fires with the matched pattern exactly when at least one field is
 * filled — enrich counts these hits (NR_DEBUG=sync + sync report) so table
 * drift (server lists going thin, new models missing from the table) stays
 * detectable. Pure otherwise: no callback means no side effects.
 */
export function fillModelCaps(
	id: string,
	caps: ModelCapabilities,
	onHit?: (pattern: string) => void,
): ModelCapabilities {
	const leaf = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
	const row = MODEL_PATTERN_CAPS.find(
		(r) => globMatch(r.pattern, leaf) || globMatch(r.pattern, id),
	);
	if (!row) return caps;
	const out = { ...caps };
	let hit = false;
	// A hit counts only when the row actually supplies the missing field —
	// every current table row carries contextWindow/maxOutput, but the guard
	// keeps the counter honest if a future row is partial.
	if ((typeof out.contextWindow !== "number" || out.contextWindow <= 0) && row.caps.contextWindow != null) {
		out.contextWindow = row.caps.contextWindow;
		hit = true;
	}
	if ((typeof out.maxOutput !== "number" || out.maxOutput <= 0) && row.caps.maxOutput != null) {
		out.maxOutput = row.caps.maxOutput;
		hit = true;
	}
	if (out.vision === undefined && row.caps.vision !== undefined) {
		out.vision = row.caps.vision;
		hit = true;
	}
	if (out.reasoning === undefined && row.caps.reasoning !== undefined) {
		out.reasoning = row.caps.reasoning;
		hit = true;
	}
	if (out.thinkingFormat === undefined && out.reasoning === true && row.caps.thinkingFormat !== undefined) {
		out.thinkingFormat = row.caps.thinkingFormat;
		hit = true;
	}
	if (hit) onHit?.(row.pattern);
	return out;
}

export function mapThinkingCompat(caps?: ModelCapabilities): {
	compat?: Record<string, unknown>;
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

	if (format.includes("qwen")) {
		return {
			compat: {
				supportsDeveloperRole: false,
				supportsReasoningEffort: false,
				thinkingFormat: "qwen",
				maxTokensField: "max_tokens",
			},
		};
	}

	if (format.includes("deepseek")) {
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

	return {
		compat: {
			supportsDeveloperRole: false,
			supportsReasoningEffort: true,
			maxTokensField: "max_tokens",
		},
	};
}

function toPiModel(m: RemoteModel, info?: RemoteModel): PiModelDef {
	// List-row caps win over info-record caps (chat info records are often thin).
	let patternHit = false;
	const caps = fillModelCaps(
		m.id,
		{
			...(asCaps(info?.capabilities) || {}),
			...(asCaps(m.capabilities) || {}),
		},
		() => {
			patternHit = true;
		},
	);
	const id = m.id;
	const reasoning = caps.reasoning ?? looksReasoning(id, caps);
	const vision = caps.vision === true;
	const contextWindow =
		(typeof caps.contextWindow === "number" && caps.contextWindow > 0
			? caps.contextWindow
			: undefined) || 128000;
	const maxTokens =
		(typeof caps.maxOutput === "number" && caps.maxOutput > 0 ? caps.maxOutput : undefined) ||
		Math.min(64000, Math.floor(contextWindow / 4));

	const { compat } = mapThinkingCompat({ ...caps, reasoning });

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
	if (patternHit) def.capsFromPattern = true;
	return def;
}

/**
 * Merge last-known friendly chat names (ticket 2).
 * Chat-kind only — image/chat twins sharing a bare id never collide.
 * Carries `prev` forward for ids still present (transient info misses keep
 * their friendly name) and drops ids no longer listed. Server-named catalog
 * entries (`namedByServer`) overwrite stale cached names.
 */
export function buildModelNames(
	catalog: CatalogEntry[],
	prev?: Record<string, string>,
	presentIds?: Iterable<string>,
): Record<string, string> {
	const next: Record<string, string> = {};
	const present = presentIds ? new Set(presentIds) : undefined;
	if (prev) {
		for (const [id, name] of Object.entries(prev)) {
			if (typeof name !== "string" || !name.trim()) continue;
			if (present && !present.has(id)) continue;
			next[id] = name.trim();
		}
	}
	for (const e of catalog) {
		if (e.kind !== "chat") continue;
		if (present && !present.has(e.id)) continue;
		if (e.namedByServer && typeof e.name === "string" && e.name.trim()) {
			next[e.id] = e.name.trim();
		}
	}
	return next;
}

/**
 * Prune last-known friendly names to the ids a listing actually returned.
 * Refresh (and full sync) drop removed ids from the in-memory map AND the
 * persisted patch, so a deleted server model stops shadowing a future
 * same-id listing with a stale friendly name. Live names merge after.
 */
export function pruneModelNamesToListed(
	cached: Map<string, string>,
	listedIds: Iterable<string>,
): void {
	const listed = listedIds instanceof Set ? listedIds : new Set(listedIds);
	for (const id of [...cached.keys()]) {
		if (!listed.has(id)) cached.delete(id);
	}
}

/**
 * Thin-row-safe wrapper over toPiModel (ticket 2): live names always win
 * (`info.name`, then list-row `m.name`); the cached friendly name is only a
 * fallback for thin rows so `pi update --models` refreshes keep display
 * names without an info fetch. Caps still merge from live rows/info.
 *
 * CORE BATCH (d): when `opts.hintFromPattern` is set (the caps-only hint was
 * itself pattern-derived) and the live list row is capless, the hint is
 * ignored for caps so pattern inference re-runs instead of trusting stale
 * numbers indefinitely. The cached friendly name is still kept. When the
 * pattern table has no match, the hint is used as before (unknown models
 * keep their last-known numbers).
 */
export function toPiModelWithCachedName(
	m: RemoteModel,
	cachedName?: string,
	info?: RemoteModel,
	opts?: { hintFromPattern?: boolean },
): PiModelDef {
	if (info?.name?.trim()) return toPiModel(m, info);
	if (m.name?.trim()) return toPiModel(m, info);
	const cached = cachedName?.trim();
	if (opts?.hintFromPattern && !info?.name?.trim()) {
		const liveCaps = asCaps(m.capabilities);
		const liveCapless = !liveCaps || Object.keys(liveCaps).length === 0;
		if (liveCapless) {
			let patternWouldFill = false;
			fillModelCaps(m.id, {}, () => {
				patternWouldFill = true;
			});
			if (patternWouldFill) {
				return toPiModel(m, cached ? { id: m.id, name: cached } : undefined);
			}
		}
	}
	if (cached) {
		const hint: RemoteModel = info ? { ...info, name: cached } : { id: m.id, name: cached };
		return toPiModel(m, hint);
	}
	return toPiModel(m, info);
}

/** Keep only fields tools/browse need — shrinks ~/.pi/agent/9router.json. */
function slimCaps(caps?: ModelCapabilities | string[]): ModelCapabilities | string[] | undefined {
	if (!caps) return undefined;
	if (Array.isArray(caps)) return caps.slice(0, 12);
	const out: ModelCapabilities = {};
	if (caps.vision != null) out.vision = caps.vision;
	if (caps.reasoning != null) out.reasoning = caps.reasoning;
	if (caps.imageOutput != null) out.imageOutput = caps.imageOutput;
	if (caps.tools != null) out.tools = caps.tools;
	if (caps.search != null) out.search = caps.search;
	if (caps.contextWindow) out.contextWindow = caps.contextWindow;
	if (caps.maxOutput) out.maxOutput = caps.maxOutput;
	if (caps.thinkingFormat) out.thinkingFormat = caps.thinkingFormat;
	return Object.keys(out).length ? out : undefined;
}

function kindPath(kind: string): string {
	if (kind === "chat") return "/models";
	return `/models/${kind}`;
}

async function fetchKind(
	endpoint: string,
	apiKey: string,
	kind: string,
	signal?: AbortSignal,
): Promise<
	| { ok: true; models: RemoteModel[]; ms: number }
	| { ok: false; error: string; ms: number }
> {
	const t0 = Date.now();
	const url = `${baseV1(endpoint)}${kindPath(kind)}`;
	const res = await httpGetJson<{ data?: RemoteModel[] }>(url, apiKey, {
		signal,
		timeoutMs: TIMEOUT.list,
	});
	const ms = Date.now() - t0;
	if (!res.ok) return { ok: false, error: `${kind}: HTTP ${res.status} ${res.error}`, ms };
	const models = Array.isArray(res.data.data) ? res.data.data : [];
	return { ok: true, models, ms };
}

async function fetchModelInfo(
	endpoint: string,
	apiKey: string,
	id: string,
	signal?: AbortSignal,
): Promise<{ info: RemoteModel | null; status: number }> {
	const url = `${baseV1(endpoint)}/models/info?id=${encodeURIComponent(id)}`;
	const res = await httpGetJson<RemoteModel>(url, apiKey, {
		signal,
		timeoutMs: TIMEOUT.info,
	});
	// Propagate the HTTP status so callers negative-cache only true-404s.
	// Transient 500s, timeouts, and 12 s aborts surface as status !== 404
	// (status 0 for network/abort) and must be retried, never skipped for 24 h.
	if (!res.ok) return { info: null, status: res.status };
	if (!res.data || typeof res.data !== "object" || (res.data as any).error) return { info: null, status: 200 };
	return { info: res.data, status: 200 };
}

/** Merge fresh caps into a catalog entry (list-row and info paths share this). */
function applyCapsToEntry(entry: CatalogEntry, caps: ModelCapabilities): void {
	entry.capabilities = slimCaps({
		...(asCaps(entry.capabilities as ModelCapabilities) || {}),
		...caps,
	});
	if (caps.contextWindow) entry.contextWindow = caps.contextWindow;
	if (caps.maxOutput) entry.maxTokens = caps.maxOutput;
	if (caps.vision) entry.input = ["text", "image"];
	if (caps.reasoning != null) entry.reasoning = caps.reasoning;
}

/**
 * Look up info for (kind, id) — kind-qualified key first, bare-id fallback
 * only when the bare id is unambiguous (appears under exactly one kind).
 *
 * Twin-risk note: the same bare id can appear in different catalog kinds
 * (e.g. an image model and a chat model sharing the id `provider/name`).
 * Keying infoById by `kind\0id` prevents cross-kind twin collisions — a
 * chat twin can never donate the wrong kind's info name to an image entry.
 * The bare-id fallback is safe only when no second kind has the same id in
 * the info map.
 */
function lookupInfo(
	infoById: Map<string, RemoteModel>,
	kind: string,
	id: string,
): RemoteModel | undefined {
	const kindKey = catalogKey(kind, id);
	if (infoById.has(kindKey)) return infoById.get(kindKey);
	// Bare-id fallback: only when exactly one kind stored this id
	let found: RemoteModel | undefined;
	let count = 0;
	for (const [key, val] of infoById) {
		if (key.endsWith(`\0${id}`)) {
			found = val;
			count++;
			if (count > 1) break;
		}
	}
	return count === 1 ? found : undefined;
}

/**
 * Negative-cache predicate — true when `id` missed its info probe within the
 * TTL and should be skipped without re-probing. Single source of truth for
 * the infoMissing check (used by enrichCatalog, locked by regression tests).
 */
function isInfoMissingCached(
	infoMissing: Record<string, number> | undefined,
	id: string,
	now: number = Date.now(),
): boolean {
	const cached = infoMissing?.[id];
	return typeof cached === "number" && now - cached < INFO_MISSING_TTL;
}

/**
 * Enrich thin catalog rows via /v1/models/info.
 * Rows that already look rich (name + caps from list) are skipped.
 *
 * infoById is keyed by `kind\0id` so cross-kind twins never collide.
 * infoCache (positive, 7 d TTL) is keyed by `kind\0id` for the same reason.
 * infoMissing is a negative cache (bare-id → timestamp, 24 h TTL) for
 * true-404 ids only, so quick-sync rebuilds (and full sync) skip
 * re-probing known-missing ids while transient 500/timeout/abort failures
 * are retried on the next sync.
 */
async function enrichCatalog(
	endpoint: string,
	apiKey: string,
	catalog: CatalogEntry[],
	remotesByKey: Map<string, RemoteModel>,
	opts: {
		signal?: AbortSignal;
		onProgress?: (msg: string) => void;
		infoMissing?: Record<string, number>;
		infoCache?: Record<string, InfoCacheEntry>;
	} = {},
): Promise<{
	named: number;
	missing: number;
	skipped: number;
	fetched: number;
	cachedInfo: number;
	skippedNegative: number;
	patternHits: number;
	aborted: boolean;
	infoById: Map<string, RemoteModel>;
	infoMissing: Record<string, number>;
	infoCache: Record<string, InfoCacheEntry>;
}> {
	const infoById = new Map<string, RemoteModel>();
	const now = Date.now();
	// Seed from the persisted caches through boundary validation: string/array
	// blobs become empty maps, NaN/null/string timestamps and { info: null }
	// records are dropped so malformed state never crashes or resurrects.
	// Expired ids are re-probed so the config blob stays bounded.
	const infoMissing: Record<string, number> = sanitizeInfoMissing(opts.infoMissing, now) ?? {};
	const infoCache: Record<string, InfoCacheEntry> = sanitizeInfoCache(opts.infoCache, now) ?? {};
	let named = 0;
	let missing = 0;
	let skipped = 0;
	let fetched = 0;
	let cachedInfo = 0;
	let skippedNegative = 0;
	// MODEL_PATTERN_CAPS fallback hits inside enrich (rich-row + info paths).
	// Added to the list-build hits for the sync-report total.
	let patternHits = 0;
	const countPatternHit = (_pattern: string): void => {
		patternHits++;
	};

	/** Apply a live (fresh or 7 d-cached) info record to its catalog entry. */
	function applyInfoToEntry(entry: CatalogEntry, info: RemoteModel): void {
		if (info.name?.trim()) {
			entry.name = info.name.trim();
			entry.namedByServer = true;
			named++;
		}
		if (info.kind?.trim()) entry.detailKind = info.kind.trim();
		if (info.endpoint?.trim()) entry.endpoint = info.endpoint.trim();
		if (Array.isArray(info.params) && info.params.length) entry.params = info.params;
		const caps = fillModelCaps(entry.id, asCaps(info.capabilities) || {}, (pattern) => {
			entry.capsFromPattern = true;
			countPatternHit(pattern);
		});
		if (Object.keys(caps).length) applyCapsToEntry(entry, caps);
	}

	const needInfo: CatalogEntry[] = [];
	// Twins sharing a bare id (chat + image) share one /v1/models/info record:
	// only the first thin twin queues a probe; the result fans out to every
	// twin in the group. Kind-qualified reads (catalogKey) stay intact.
	const probeGroups = new Map<string, CatalogEntry[]>();
	for (const entry of catalog) {
		if (entry.synthetic) {
			skipped++;
			continue;
		}
		// Entries preserved from a previous sync (quick mode) already have metadata.
		if (!remotesByKey.has(`${entry.kind}\0${entry.id}`) && (entry.namedByServer || entry.params?.length || entry.detailKind)) {
			skipped++;
			if (entry.namedByServer) named++;
			continue;
		}
		const remote = remotesByKey.get(`${entry.kind}\0${entry.id}`);
		if (remote && listRowIsRich(remote)) {
			// Already rich from list — seed info map keyed by (kind, id) to
			// prevent cross-kind twin collisions.
			infoById.set(catalogKey(entry.kind, entry.id), remote);
			if (remote.name?.trim()) {
				entry.name = remote.name.trim();
				entry.namedByServer = true;
				named++;
			}
			const caps = fillModelCaps(entry.id, asCaps(remote.capabilities) || {}, (pattern) => {
				entry.capsFromPattern = true;
				countPatternHit(pattern);
			});
			if (Object.keys(caps).length) applyCapsToEntry(entry, caps);
			if (remote.kind?.trim()) entry.detailKind = remote.kind.trim();
			if (Array.isArray(remote.params) && remote.params.length) entry.params = remote.params;
			skipped++;
			continue;
		}
		// 7 d positive-cache hit — reuse the fetched record, no HTTP.
		// Keyed by (kind, id): a record fetched for one kind is never reused
		// by another kind's twin, even within the TTL. Validated shape only
		// (plain-record info with a string id); anything malformed
		// ({ info: null }, arrays, NaN timestamps) was already dropped at
		// seed and falls through to a live re-probe.
		const cached = infoCache[catalogKey(entry.kind, entry.id)];
		const cachedInfoRecord: unknown = cached?.info;
		const cachedUsable =
			cached !== undefined &&
			isInfoCacheFresh(cached, now) &&
			typeof cached === "object" &&
			cached !== null &&
			!Array.isArray(cached) &&
			typeof cachedInfoRecord === "object" &&
			cachedInfoRecord !== null &&
			!Array.isArray(cachedInfoRecord) &&
			typeof (cachedInfoRecord as { id?: unknown }).id === "string";
		if (cachedUsable) {
			infoById.set(catalogKey(entry.kind, entry.id), cached.info);
			applyInfoToEntry(entry, cached.info);
			cachedInfo++;
			skipped++;
			continue;
		}
		// Skip ids whose last info probe already returned null (negative cache).
		if (isInfoMissingCached(infoMissing, entry.id, now)) {
			skipped++;
			skippedNegative++;
			continue;
		}
		const group = probeGroups.get(entry.id);
		if (group) {
			group.push(entry);
			continue;
		}
		probeGroups.set(entry.id, [entry]);
		needInfo.push(entry);
	}

	opts.onProgress?.(
		`Fetching metadata for ${needInfo.length} models (${skipped} already rich)…`,
	);

	const total = needInfo.length;
	// Stream progress — ~10 updates per enrich so long syncs stay alive.
	// The step scales with the total (min would cap the step, not the count).
	let done = 0;
	const step = Math.max(1, Math.ceil(total / 10));
	const results = await mapConcurrent(
		needInfo,
		INFO_CONCURRENCY,
		async (entry) => {
			const { info, status } = await fetchModelInfo(endpoint, apiKey, entry.id, opts.signal);
			done++;
			if (done % step === 0 || done === total) {
				opts.onProgress?.(`Metadata ${done}/${total}…`);
			}
			return { entry, info, status };
		},
		opts.signal,
	);

	for (const r of results) {
		if (!r) continue;
		fetched++;
		const { entry, info, status } = r;
		if (!info) {
			missing++;
			// Negative-cache only true-404s so quick-sync (and full sync)
			// skips re-probing ids the server has no record for. Transient
			// 500s, timeouts, and aborts (status !== 404) are NOT cached —
			// the next sync re-probes them.
			if (status === 404) infoMissing[entry.id] = now;
			continue;
		}
		// Fan out to every twin in the probe group; each twin keeps its own
		// kind-qualified key so cross-kind twins never collide on read.
		const twins = probeGroups.get(entry.id) ?? [entry];
		for (const twin of twins) {
			// Key by (kind, id) — prevents cross-kind twin collisions.
			infoById.set(catalogKey(twin.kind, twin.id), info);
			// Persist the raw record for 7 d reuse (pattern fill re-runs per sync).
			infoCache[catalogKey(twin.kind, twin.id)] = { fetchedAt: now, info };
			applyInfoToEntry(twin, info);
		}
	}

	debugLog(
		"sync",
		`enrich classify named=${named} fetched=${fetched} cached=${cachedInfo} skipped=${skipped} missing=${missing} skip-negative=${skippedNegative} needInfo=${needInfo.length}`,
	);
	debugLog(
		"sync",
		`info hit=${fetched - missing} miss=${missing} skip-negative=${skippedNegative} pattern-hits=${patternHits}`,
	);
	const aborted = opts.signal?.aborted ?? false;
	if (aborted) debugLog("sync", "enrich aborted — partial results discarded by caller");

	return {
		named,
		missing,
		skipped,
		fetched,
		cachedInfo,
		skippedNegative,
		patternHits,
		aborted,
		infoById,
		infoMissing,
		infoCache,
	};
}

// ── Voice TTS ───────────────────────────────────────────────────

async function probeSpeech(
	endpoint: string,
	apiKey: string,
	model: string,
	signal?: AbortSignal,
): Promise<{ ok: boolean; error?: string; ms?: number }> {
	const t0 = Date.now();
	const res = await postBinary(
		`${baseV1(endpoint)}/audio/speech`,
		apiKey,
		{ model, input: "ok" },
		{ signal, timeoutMs: TIMEOUT.probe },
	);
	const ms = Date.now() - t0;
	if (!res.ok) return { ok: false, error: `HTTP ${res.status} ${res.error}`, ms };
	if (res.bytes.byteLength < 512) {
		return { ok: false, error: `only ${res.bytes.byteLength} bytes`, ms };
	}
	return { ok: true, ms };
}

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
		{ signal, timeoutMs: TIMEOUT.info },
	);
	if (!res.ok) return null;
	const rows = Array.isArray(res.data?.data) ? res.data.data : [];
	const ids = rows
		.map((v) => (v.model || v.id || v.name || "").trim())
		.filter(Boolean)
		.map((v) => (v.startsWith(`${provider}/`) ? v.slice(provider.length + 1) : v));
	return ids.length ? ids : null;
}

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
			const probe = await probeSpeech(
				endpoint,
				apiKey,
				`${p.provider}/${p.probe}`,
				opts.signal,
			);
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

// ── Sync ────────────────────────────────────────────────────────

export interface SyncResult {
	ok: boolean;
	error?: string;
	mode: SyncMode;
	counts: Partial<Record<string, number>>;
	chatModels: PiModelDef[];
	catalog: CatalogEntry[];
	healthOk: boolean;
	namedByServer?: number;
	namesDerived?: number;
	infoFetched?: number;
	infoSkipped?: number;
	/** 7 d positive-cache hits (no HTTP) — unified with the 24 h negative cache. */
	infoCached?: number;
	/** Info probes that returned no record (404s + transient). Positive hits = infoFetched - infoMissed. */
	infoMissed?: number;
	/** 24 h negative-cache skips (no HTTP) — included in infoSkipped. */
	infoSkippedNegative?: number;
	/** MODEL_PATTERN_CAPS fallback fills (list build + enrich). A rising
	 *  count across syncs signals table drift — thin server lists or new
	 *  models missing from the table. See NR_DEBUG=sync logs. */
	patternHits?: number;
	voiceSkipped?: string[];
	voiceAdded?: number;
	infoMissing?: Record<string, number>;
	infoCache?: Record<string, InfoCacheEntry>;
	modelNames?: Record<string, string>;
	timings?: Record<string, number>;
}

function catalogKey(kind: string, id: string): string {
	return `${kind}\0${id}`;
}

/**
 * Quick-sync aging (ticket 3): mark preserved entries stale after N absent
 * syncs instead of keeping them fresh forever — with no re-probe, so quick
 * sync stays a chat-only fetch.
 *
 * `prev` entries whose (kind, id) is NOT in `confirmed` (the ids this sync
 * actually listed) get `absentSyncs` bumped and `stale: true` once the count
 * reaches `maxAbsent`. Entries this sync DID confirm come back clean
 * (`absentSyncs`/`stale` cleared). Synthetic voice entries are exempt — they
 * are generated locally, have no server list to be absent from, and full
 * sync re-probes them anyway.
 *
 * Counts live on the CatalogEntry itself, so they persist through the
 * existing catalog save path (`saveConfig` → `saveJsonMerge`) with no new
 * top-level config keys and no extra merge logic. Full sync rebuilds the
 * catalog from fresh lists, which naturally clears reappearing entries and
 * prunes truly-deleted ones.
 */
export function ageAbsentEntries(
	prev: CatalogEntry[],
	confirmed: Set<string> | Iterable<string>,
	maxAbsent: number = QUICK_STALE_AFTER_ABSENT,
): CatalogEntry[] {
	const seen = confirmed instanceof Set ? confirmed : new Set(confirmed);
	return prev.map((e) => {
		if (e.synthetic) return e;
		if (seen.has(catalogKey(e.kind, e.id))) {
			if (e.absentSyncs == null && !e.stale) return e;
			const next: CatalogEntry = { ...e };
			delete next.absentSyncs;
			delete next.stale;
			return next;
		}
		const absent = (e.absentSyncs ?? 0) + 1;
		const next: CatalogEntry = { ...e, absentSyncs: absent };
		if (absent >= maxAbsent) next.stale = true;
		return next;
	});
}

export async function fetchAllAndBuild(
	config: Config,
	opts: {
		signal?: AbortSignal;
		mode?: SyncMode;
		onProgress?: (msg: string) => void;
	} = {},
): Promise<SyncResult> {
	const mode: SyncMode = opts.mode || "full";
	const kinds = mode === "quick" ? [...QUICK_CATALOG_KINDS] : [...FULL_CATALOG_KINDS];
	const endpoint = normalizeEndpoint(config.endpoint);
	const apiKey = resolveApiKey(config.apiKey);
	const counts: Partial<Record<string, number>> = {};
	const catalog: CatalogEntry[] = [];
	const chatModels: PiModelDef[] = [];
	const remotesByKey = new Map<string, RemoteModel>();
	// MODEL_PATTERN_CAPS fallback hits during list build; enrich adds its own.
	let patternHits = 0;
	const timings: Record<string, number> = {};
	const tSync = Date.now();

	opts.onProgress?.("Checking health…");
	const health = await healthCheck(endpoint, { signal: opts.signal });
	timings.health = health.ms ?? 0;
	if (!health.ok) {
		return {
			ok: false,
			mode,
			error: `9Router not reachable at ${endpoint} (${health.error || "health failed"}). Is it running?`,
			counts: {},
			chatModels: [],
			catalog: [],
			healthOk: false,
			timings,
		};
	}

	opts.onProgress?.(
		mode === "quick" ? "Fetching chat models…" : "Fetching model catalogs…",
	);
	const tList = Date.now();
	// Each kind reports as it lands (Promise.all still fetches concurrently).
	const results = await Promise.all(
		kinds.map(async (kind) => {
			const r = await fetchKind(endpoint, apiKey, kind, opts.signal);
			opts.onProgress?.(
				r.ok ? `Listed ${kind}: ${r.models.length} models (${r.ms}ms)…` : `List ${kind} failed: ${r.error}`,
			);
			return { kind, r };
		}),
	);
	timings.lists = Date.now() - tList;

	const errors: string[] = [];
	let chatRemotes: RemoteModel[] = [];

	for (const { kind, r } of results) {
		timings[`list:${kind}`] = r.ms;
		debugLog("timing", `list ${kind}: ${r.ms}ms ${r.ok ? `${r.models.length} models` : `FAIL ${r.error}`}`);
		if (!r.ok) {
			errors.push(r.error);
			counts[kind] = 0;
			continue;
		}
		counts[kind] = r.models.length;
		if (kind === "chat") chatRemotes = r.models;

		for (const m of r.models) {
			const key = catalogKey(kind, m.id);
			// Dedupe (kind, id) — server can list the same id under two buckets
			if (remotesByKey.has(key)) continue;
			remotesByKey.set(key, m);

			let listPatternHit = false;
			const caps = fillModelCaps(m.id, asCaps(m.capabilities) || {}, () => {
				listPatternHit = true;
			});
			if (listPatternHit) patternHits++;
			const namedByServer = Boolean(m.name?.trim());
			catalog.push({
				id: m.id,
				name: inferName(m),
				kind,
				detailKind: m.kind?.trim() || undefined,
				ownedBy: m.owned_by,
				endpoint: m.endpoint,
				capabilities: slimCaps(caps),
				params: m.params,
				namedByServer,
				...(listPatternHit ? { capsFromPattern: true as const } : {}),
				contextWindow: caps.contextWindow,
				maxTokens: caps.maxOutput,
				reasoning: caps.reasoning ?? looksReasoning(m.id, caps),
				input: caps.vision ? ["text", "image"] : ["text"],
			});
		}
	}

	if (!chatRemotes.length && errors.some((e) => e.startsWith("chat:"))) {
		return {
			ok: false,
			mode,
			error: errors.join("\n"),
			counts,
			chatModels: [],
			catalog,
			healthOk: true,
			timings,
		};
	}

	// Quick mode: keep previous non-chat catalog entries so tools still work.
	// Unconfirmed entries age via absence counts — stale after N consecutive
	// syncs unseen (ticket 3). No re-probe: quick sync stays chat-only fetch.
	if (mode === "quick") {
		const prev = (loadConfig().catalog || []).filter((e) => e.kind !== "chat");
		const seen = new Set(catalog.map((c) => catalogKey(c.kind, c.id)));
		for (const e of ageAbsentEntries(prev, seen)) {
			const k = catalogKey(e.kind, e.id);
			if (seen.has(k)) continue;
			seen.add(k);
			catalog.push(e);
		}
		// Rebuild counts for preserved kinds
		for (const e of catalog) {
			if (e.kind === "chat") continue;
			counts[e.kind] = (counts[e.kind] || 0) + 1;
		}
	}

	const tInfo = Date.now();
	const enriched = await enrichCatalog(endpoint, apiKey, catalog, remotesByKey, {
		signal: opts.signal,
		onProgress: opts.onProgress,
		infoMissing: config.infoMissing,
		infoCache: config.infoCache,
	});
	timings.enrich = Date.now() - tInfo;
	debugLog("timing", `enrich: ${timings.enrich}ms`);
	// Abort during enrich must NOT save a partial sync as success. The enrich
	// workers fail fast on abort (status 0, never negatively cached), so without
	// this check the truncated catalog would return ok:true and the TUI would
	// persist it with a fresh lastSync. Mark the sync failed instead — runSync
	// leaves the config (and status/sync-summary) untouched on !ok.
	if (opts.signal?.aborted || enriched.aborted) {
		timings.total = Date.now() - tSync;
		debugLog("timing", `sync aborted during enrich mode=${mode}`);
		return {
			ok: false,
			mode,
			error: "Sync aborted during metadata fetch — partial results discarded (config unchanged).",
			counts,
			chatModels: [],
			catalog,
			healthOk: true,
			infoMissing: enriched.infoMissing,
			infoCache: enriched.infoCache,
			timings,
		};
	}
	const infoById = enriched.infoById;
	const infoMissing = enriched.infoMissing;
	const infoCache = enriched.infoCache;
	const namedByServer = enriched.named;
	const infoFetched = enriched.fetched;
	const infoSkipped = enriched.skipped;
	const infoCached = enriched.cachedInfo;
	const infoMissed = enriched.missing;
	const infoSkippedNegative = enriched.skippedNegative;
	patternHits += enriched.patternHits;
	debugLog("sync", `pattern fallback hits=${patternHits} (list+enrich) of ${catalog.length} catalog rows`);

	let voiceSkipped: string[] = [];
	let voiceAdded = 0;
	if (mode === "full") {
		const tVoice = Date.now();
		const voice = await discoverVoiceTts(endpoint, apiKey, {
			signal: opts.signal,
			onProgress: opts.onProgress,
		});
		timings.voice = Date.now() - tVoice;
		debugLog("timing", `voice: ${timings.voice}ms added=${voice.entries.length} skipped=${voice.skipped.length}`);
		voiceSkipped = voice.skipped;
		if (voice.entries.length) {
			const known = new Set(catalog.map((c) => c.id));
			const fresh = voice.entries.filter((e) => !known.has(e.id));
			catalog.push(...fresh);
			counts.tts = (counts.tts || 0) + fresh.length;
			voiceAdded = fresh.length;
		}
	}

	opts.onProgress?.(`Mapping ${chatRemotes.length} chat models…`);
	const chatEntryById = new Map(
		catalog.filter((c) => c.kind === "chat").map((c) => [c.id, c] as const),
	);
	// Last-known friendly names: thin list rows with no server name reuse the
	// persisted modelNames cache instead of the bare id fallback. Live names
	// (list row, then info record) still win inside toPiModelWithCachedName.
	const cachedChatNames = config.modelNames;

	for (const m of chatRemotes) {
		const def = toPiModelWithCachedName(
			m,
			cachedChatNames?.[m.id],
			lookupInfo(infoById, "chat", m.id),
		);
		chatModels.push(def);
		const entry = chatEntryById.get(m.id);
		if (entry) {
			entry.registered = true;
			if (!entry.namedByServer) entry.name = def.name;
			else def.name = entry.name;
			entry.contextWindow = def.contextWindow;
			entry.maxTokens = def.maxTokens;
			entry.reasoning = def.reasoning;
			entry.input = def.input;
		}
	}

	timings.total = Date.now() - tSync;
	debugLog("timing", `sync total: ${timings.total}ms mode=${mode}`);

	const modelNames = buildModelNames(
		catalog,
		config.modelNames,
		chatRemotes.map((m) => m.id),
	);

	return {
		ok: true,
		mode,
		error: errors.length ? `Partial: ${errors.join("; ")}` : undefined,
		counts,
		chatModels,
		catalog,
		healthOk: true,
		namedByServer,
		namesDerived: catalog.filter((c) => !c.namedByServer && !c.synthetic).length,
		infoFetched,
		infoSkipped,
		infoCached,
		infoMissed,
		infoSkippedNegative,
		patternHits,
		voiceSkipped,
		voiceAdded,
		infoMissing,
		infoCache,
		modelNames,
		timings,
	};
}

// ── Diagnose ────────────────────────────────────────────────────

export interface DiagnoseResult {
	endpoint: string;
	health: { ok: boolean; error?: string; ms?: number };
	kinds: Array<{ kind: string; ok: boolean; count?: number; ms: number; error?: string }>;
	sampleInfo?: { id: string; ok: boolean; ms: number; name?: string; error?: string };
	voiceProbes: Array<{ provider: string; ok: boolean; ms?: number; error?: string }>;
	lastSync?: string;
	lastSyncMode?: string;
	counts?: Partial<Record<string, number>>;
	infoMissingCount?: number;
	stale: boolean;
}

export async function diagnoseConnection(
	config: Config,
	opts: { signal?: AbortSignal; onProgress?: (msg: string) => void } = {},
): Promise<DiagnoseResult> {
	const endpoint = normalizeEndpoint(config.endpoint);
	const apiKey = resolveApiKey(config.apiKey);
	const out: DiagnoseResult = {
		endpoint,
		health: { ok: false },
		kinds: [],
		voiceProbes: [],
		lastSync: config.lastSync,
		lastSyncMode: config.lastSyncMode,
		counts: config.counts ? { ...config.counts } : undefined,
		infoMissingCount: Object.keys(config.infoMissing ?? {}).length,
		stale: isSyncStale(config.lastSync),
	};

	opts.onProgress?.("Health…");
	out.health = await healthCheck(endpoint, { signal: opts.signal });
	debugLog("timing", `diagnose health: ${out.health.ms ?? 0}ms ${out.health.ok ? "OK" : `FAIL ${out.health.error ?? ""}`}`);

	// Reuse the first chat list for the sample info id — no second fetch.
	let chatSampleId: string | undefined;
	for (const kind of DIAGNOSE_PROBE_KINDS) {
		opts.onProgress?.(`List ${kind}…`);
		const r = await fetchKind(endpoint, apiKey, kind, opts.signal);
		debugLog("timing", `diagnose list ${kind}: ${r.ms}ms ${r.ok ? `${r.models.length} models` : `FAIL ${r.error}`}`);
		if (r.ok) {
			out.kinds.push({ kind, ok: true, count: r.models.length, ms: r.ms });
			if (kind === "chat" && chatSampleId === undefined) chatSampleId = r.models[0]?.id;
		} else out.kinds.push({ kind, ok: false, ms: r.ms, error: r.error });
	}

	if (chatSampleId) {
		opts.onProgress?.(`Info ${chatSampleId}…`);
		const t0 = Date.now();
		const { info } = await fetchModelInfo(endpoint, apiKey, chatSampleId, opts.signal);
		const ms = Date.now() - t0;
		debugLog("timing", `diagnose info ${chatSampleId}: ${ms}ms ${info ? "OK" : "miss"}`);
		out.sampleInfo = {
			id: chatSampleId,
			ok: Boolean(info),
			ms,
			name: info?.name,
			error: info ? undefined : "no info record",
		};
	}

	for (const p of VOICE_TTS_PROVIDERS) {
		opts.onProgress?.(`Probe ${p.provider}…`);
		const probe = await probeSpeech(
			endpoint,
			apiKey,
			`${p.provider}/${p.probe}`,
			opts.signal,
		);
		debugLog("timing", `diagnose voice ${p.provider}: ${probe.ms ?? 0}ms ${probe.ok ? "OK" : `FAIL ${probe.error ?? ""}`}`);
		out.voiceProbes.push({
			provider: p.provider,
			ok: probe.ok,
			ms: probe.ms,
			error: probe.error,
		});
	}

	return out;
}

// ── Provider registration ───────────────────────────────────────

function registerWithPi(pi: ExtensionAPI, config: Config, models: PiModelDef[]): void {
	const endpoint = normalizeEndpoint(config.endpoint);
	const apiKey = resolveApiKey(config.apiKey);
	let chatModels = models;
	// Last-known friendly chat names — explicit map first, then fall back to
	// the registered models + chat catalog entries (pre-map configs).
	// Chat-kind only so image/chat twins never donate the wrong kind's name.
	const cachedNames = new Map<string, string>();
	if (config.modelNames) {
		for (const [id, name] of Object.entries(config.modelNames)) {
			if (typeof name === "string" && name.trim()) cachedNames.set(id, name.trim());
		}
	}
	for (const m of models) {
		if (cachedNames.has(m.id)) continue;
		if (typeof m.name === "string" && m.name.trim() && m.name.trim() !== inferNameFromId(m.id)) {
			cachedNames.set(m.id, m.name.trim());
		}
	}
	for (const c of config.catalog || []) {
		if (c.kind !== "chat" || cachedNames.has(c.id)) continue;
		if (c.namedByServer && typeof c.name === "string" && c.name.trim()) {
			cachedNames.set(c.id, c.name.trim());
		}
	}

	if (!chatModels.length) {
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
		})),
		// Live discovery hook (docs/extensions.md): pi calls this during model
		// refresh. Quick chat-only fetch — no enrich. Thin refresh rows reuse
		// the last-known friendly names persisted by full sync (modelNames +
		// chatModels/catalog fallback) instead of the bare inferName fallback.
		// Successful refreshes persist chatModels + modelNames and become the
		// new fallback, so a later failed refresh never wipes the provider.
		async refreshModels(context: { signal: AbortSignal; allowNetwork?: boolean }) {
			if (context.allowNetwork === false) return chatModels;
			try {
				const list = await fetchKind(endpoint, apiKey, "chat", context.signal);
				if (!list.ok || !list.models.length) return chatModels;
				// Last-known per-kind (chat) info hints: exact caps from the
				// registered defs beat pattern estimates for thin refresh rows. A capless live
					// row with a pattern-derived hint re-runs pattern inference instead of
					// trusting the hint indefinitely (provenance flag).
				// Caps only (no name) — names stay on the cached-friendly path
				// so a stale def name can never override them. Live list-row
				// caps still win via the toPiModel merge order.
				const prevCapsById = new Map(chatModels.map((d) => [d.id, d] as const));
				const next = list.models.map((m) => {
					const prev = prevCapsById.get(m.id);
					const hint: RemoteModel | undefined = prev
						? {
								id: prev.id,
								capabilities: {
									contextWindow: prev.contextWindow,
									maxOutput: prev.maxTokens,
								},
							}
						: undefined;
					return toPiModelWithCachedName(m, cachedNames.get(m.id), hint, {
						hintFromPattern: prev?.capsFromPattern,
					});
				});
				// Drop names for ids the server no longer lists before merging
				// live names, so removed models prune out of the saved map.
				pruneModelNamesToListed(cachedNames, list.models.map((m) => m.id));
				for (const m of list.models) {
					if (m.name?.trim()) cachedNames.set(m.id, m.name.trim());
				}
				chatModels = next;
				saveJsonMerge({ chatModels, modelNames: Object.fromEntries(cachedNames) });
				return chatModels;
			} catch {
				return chatModels;
			}
		},
	});
}

function applySyncToConfig(config: Config, sync: SyncResult): Config {
	const next: Config = {
		...config,
		lastSync: new Date().toISOString(),
		lastSyncMode: sync.mode,
		chatModels: sync.chatModels,
		catalog: sync.catalog,
		counts: sync.counts,
		infoMissing: sync.infoMissing,
		infoCache: sync.infoCache,
		modelNames: sync.modelNames,
	};
	const tSave = Date.now();
	saveConfig(next);
	debugLog("timing", `save: ${Date.now() - tSave}ms`);
	return next;
}

// ── TUI ─────────────────────────────────────────────────────────

/** One-line API key display: masked, env fallback, or "(not set)". */
function describeKey(apiKey?: string, notSetText = "(not set — ok if 9Router auth off)"): string {
	if (apiKey) return maskedKey(apiKey);
	if (process.env.NINEROUTER_KEY) return maskedKey(process.env.NINEROUTER_KEY) + " (env)";
	return notSetText;
}

export function statusLines(config: Config): string[] {
	const counts = config.counts || {};
	const chat = config.chatModels?.length ?? counts.chat ?? 0;
	const stale = isSyncStale(config.lastSync);
	const footerOn = isFooterEnabled();
	const lines = [
		`Endpoint:  ${config.endpoint}`,
		`API key:   ${describeKey(config.apiKey)}`,
		`Last sync: ${config.lastSync || "never"}${config.lastSyncMode ? ` (${config.lastSyncMode})` : ""}${stale ? "  ⚠ stale (>24h)" : ""}`,
		formatTriageLine({
			lastSync: config.lastSync,
			lastSyncMode: config.lastSyncMode,
			counts,
			stale,
			infoMissingCount: Object.keys(config.infoMissing ?? {}).length,
		}),
		`Chat registered: ${chat}`,
		`Footer:    ${footerOn ? "on" : "off"}`,
	];
	const extras = (["image", "tts", "stt", "embedding", "web", "image-to-text"] as const)
		.map((k) => (counts[k] ? `${k}:${counts[k]}` : null))
		.filter(Boolean);
	if (extras.length) lines.push(`Catalog:   ${extras.join("  ")}`);
	const usage = formatUsageSummary();
	if (usage) lines.push(usage);
	const staleN = (config.catalog || []).filter((e) => e.stale).length;
	if (staleN) lines.push(`Stale:     ${staleN} unconfirmed (quick sync) — run full sync to confirm`);
	lines.push(`Config:    ${CONFIG_PATH}`);
	return lines;
}

async function browseCatalog(ui: ExtensionContext["ui"], config: Config): Promise<void> {
	const catalog = config.catalog || [];
	if (!catalog.length) {
		ui.notify("No catalog yet — run Sync first", "warning");
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
		const kindEntries = catalog.filter((e) => e.kind === kind).sort((a, b) => a.id.localeCompare(b.id));

		// Caps filter: rich (live server caps) / thin (pattern fallback) / missing.
		const nRich = kindEntries.filter((e) => capsClassOf(e) === "rich").length;
		const nThin = kindEntries.filter((e) => capsClassOf(e) === "thin").length;
		const nMissing = kindEntries.filter((e) => capsClassOf(e) === "missing").length;
		const filterChoice = await ui.select(`${kind} — filter`, [
			`All (${kindEntries.length})`,
			`Rich — live caps (${nRich})`,
			`Thin — pattern fallback (${nThin})`,
			`Missing caps (${nMissing})`,
			"← Back",
		]);
		if (!filterChoice || filterChoice === "← Back") continue;
		const cls = filterChoice.startsWith("Rich")
			? ("rich" as const)
			: filterChoice.startsWith("Thin")
				? ("thin" as const)
				: filterChoice.startsWith("Missing")
					? ("missing" as const)
					: undefined;
		const entries = cls ? kindEntries.filter((e) => capsClassOf(e) === cls) : kindEntries;
		const filterLabel = cls ?? "all";

		const pageSize = 30;
		let page = 0;
		while (true) {
			const totalPages = Math.max(1, Math.ceil(entries.length / pageSize));
			const slice = entries.slice(page * pageSize, page * pageSize + pageSize);
			const items = slice.map((e) => {
				const bits: string[] = [e.id];
				if (e.namedByServer && e.name && e.name !== e.id) bits.push(e.name);
				if (e.reasoning) bits.push("🧠");
				if (e.input?.includes("image")) bits.push("👁");
				if (e.contextWindow) bits.push(`${Math.round(e.contextWindow / 1000)}k`);
				if (e.registered) bits.push("✓ pi");
				if (e.stale) bits.push("⚠ stale");
				if (e.capsFromPattern) bits.push("◐ pattern");
				else if (capsClassOf(e) === "missing") bits.push("○ no caps");
				if (e.params?.length) bits.push(`[${e.params.slice(0, 3).join(",")}]`);
				return bits.join(" · ");
			});
			if (page > 0) items.push("← Prev page");
			if (page + 1 < totalPages) items.push("→ Next page");
			items.push("← Back");

			const pick = await ui.select(
				`${kind} · ${filterLabel} · ${entries.length} models · page ${page + 1}/${totalPages}`,
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
				capsBadgeOf(entry),
				entry.synthetic ? `source: added locally${entry.note ? ` — ${entry.note}` : ""}` : "",
				entry.ownedBy ? `owned_by: ${entry.ownedBy}` : "",
				entry.endpoint ? `endpoint: ${entry.endpoint}` : "",
				entry.contextWindow ? `contextWindow: ${entry.contextWindow}` : "",
				entry.maxTokens ? `maxTokens: ${entry.maxTokens}` : "",
				entry.reasoning != null ? `reasoning: ${entry.reasoning}` : "",
				entry.input ? `input: ${entry.input.join(", ")}` : "",
				entry.registered ? "registered in pi: yes" : "registered in pi: no (non-chat or not synced)",
				entry.stale
					? `stale: unconfirmed for ${entry.absentSyncs ?? "?"} sync(s) — run full sync to confirm or prune`
					: "",
				entry.params?.length ? `params: ${entry.params.join(", ")}` : "",
				entry.capabilities
					? `capabilities: ${typeof entry.capabilities === "string" ? entry.capabilities : JSON.stringify(entry.capabilities)}`
					: "",
			]
				.filter(Boolean)
				.join("\n");

			await ui.confirm(entry.id, detail + "\n\n(OK to close)");
		}
	}
}

export function formatDiagnose(d: DiagnoseResult): string {
	const lines = [
		`Endpoint  ${d.endpoint}`,
		`Health    ${d.health.ok ? "OK" : "FAIL"} ${d.health.ms != null ? `${d.health.ms}ms` : ""}${d.health.error ? ` — ${d.health.error}` : ""}`,
		`Last sync ${d.lastSync || "never"}${d.stale ? "  ⚠ stale (>24h)" : ""}`,
		formatTriageLine({
			lastSync: d.lastSync,
			lastSyncMode: d.lastSyncMode,
			counts: d.counts,
			stale: d.stale,
			infoMissingCount: d.infoMissingCount ?? 0,
		}),
		"",
		"List latency:",
		...d.kinds.map((k) =>
			k.ok
				? `  ${k.kind.padEnd(12)} ${String(k.count).padStart(4)} models  ${k.ms}ms`
				: `  ${k.kind.padEnd(12)} FAIL  ${k.ms}ms  ${k.error || ""}`,
		),
	];
	if (d.sampleInfo) {
		lines.push(
			"",
			`Sample info  ${d.sampleInfo.id}`,
			`  ${d.sampleInfo.ok ? "OK" : "FAIL"} ${d.sampleInfo.ms}ms${d.sampleInfo.name ? ` · ${d.sampleInfo.name}` : ""}${d.sampleInfo.error ? ` — ${d.sampleInfo.error}` : ""}`,
		);
	}
	lines.push("", "Voice TTS probes:");
	for (const v of d.voiceProbes) {
		lines.push(
			`  ${v.provider.padEnd(12)} ${v.ok ? "OK" : "FAIL"} ${v.ms != null ? `${v.ms}ms` : ""}${v.error ? ` — ${v.error}` : ""}`,
		);
	}
	return lines.join("\n");
}

async function runSync(
	pi: ExtensionAPI,
	ui: ExtensionContext["ui"],
	config: Config,
	mode: SyncMode,
): Promise<Config> {
	ui.notify(mode === "quick" ? "Quick sync (chat)…" : "Full sync…", "info");
	const sync = await fetchAllAndBuild(config, {
		mode,
		onProgress: (msg) => ui.notify(msg, "info"),
	});
	if (!sync.ok) {
		ui.notify(sync.error || "Sync failed", "error");
		return config;
	}

	config = applySyncToConfig(config, sync);
	registerWithPi(pi, config, sync.chatModels);

	pi.events.emit("9router:synced", {
		endpoint: config.endpoint,
		counts: sync.counts,
		chatCount: sync.chatModels.length,
		mode: sync.mode,
		at: config.lastSync,
	});

	const totalMs = sync.timings?.total;
	const summary = [
		`Mode: ${sync.mode}`,
		`Registered ${sync.chatModels.length} chat models (provider ${PROVIDER_ID})`,
		...Object.entries(sync.counts).map(([k, n]) => `  ${k}: ${n}`),
		"",
		`Names from server: ${sync.namedByServer ?? 0} · derived: ${sync.namesDerived ?? 0}`,
		formatInfoLine(sync),
		`Pattern fallback: ${sync.patternHits ?? 0} of ${sync.catalog.length} rows (rising counts signal table drift — see NR_DEBUG=sync)`,
		sync.voiceAdded ? `Voice TTS added: ${sync.voiceAdded}` : "",
		sync.voiceSkipped?.length ? `Voice TTS unavailable: ${sync.voiceSkipped.join(", ")}` : "",
		sync.catalog.some((c) => c.stale)
			? `Stale: ${sync.catalog.filter((c) => c.stale).length} unconfirmed (quick sync) — run full sync to confirm`
			: "",
		totalMs != null ? `Total: ${totalMs}ms` : "",
		sync.error ? `Note: ${sync.error}` : "",
		"",
		"Next: /model → provider 9router",
		"Tools: /9router-tools",
	]
		.filter(Boolean)
		.join("\n");

	await ui.confirm("Sync complete", summary);
	paintFooterStatus(ui, footerFromConfig());
	return config;
}

async function runNineRouterUI(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	const ui = ctx.ui;
	let config = loadConfig();

	while (true) {
		const chatN = config.chatModels?.length ?? 0;
		const synced = config.lastSync ? new Date(config.lastSync).toLocaleString() : "never";
		const stale = isSyncStale(config.lastSync);
		const footerOn = isFooterEnabled();
		const header = [
			`Endpoint  ${config.endpoint}`,
			`Key       ${describeKey(config.apiKey, "not set")}`,
			`Chat      ${chatN} registered · last sync ${synced}${config.lastSyncMode ? ` (${config.lastSyncMode})` : ""}${stale ? " ⚠" : ""}`,
			`Footer    ${footerOn ? "on" : "off"}`,
		].join("\n");

		const menu = [
			"Sync models (full catalog)",
			"Quick sync (chat only)",
			"Connection",
			"Diagnose",
			"Browse catalog",
			footerOn ? "Footer: on  (hide from status bar)" : "Footer: off  (show in status bar)",
			"Status",
			"Unregister chat models",
			"Close",
		];

		const choice = await ui.select(`9Router\n${header}`, menu);
		if (!choice || choice === "Close") {
			paintFooterStatus(ui, footerFromConfig());
			break;
		}

		if (choice.startsWith("Footer:")) {
			const next = !footerOn;
			setFooterEnabled(next);
			paintFooterStatus(ui, footerFromConfig());
			ui.notify(next ? "Footer on" : "Footer off", "info");
			continue;
		}

		if (choice === "Status") {
			await ui.confirm("Status", statusLines(config).join("\n"));
			continue;
		}

		if (choice === "Diagnose") {
			ui.notify("Running diagnostics…", "info");
			const d = await diagnoseConnection(config, {
				onProgress: (msg) => ui.notify(msg, "info"),
			});
			await ui.confirm("Diagnose", formatDiagnose(d));
			continue;
		}

		if (choice === "Connection") {
			while (true) {
				const sub = await ui.select("Connection", [
					`Endpoint: ${config.endpoint}`,
					`API key: ${describeKey(config.apiKey, "not set")}`,
					"Test connection",
					"Clear API key",
					"Back",
				]);
				if (!sub || sub === "Back") break;

				if (sub.startsWith("Endpoint")) {
					const next = await ui.input("Base URL (no /v1)", config.endpoint || DEFAULT_ENDPOINT);
					if (next?.trim()) {
						config = { ...config, endpoint: normalizeEndpoint(next.trim()) };
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
					const chat = await fetchKind(config.endpoint, resolveApiKey(config.apiKey), "chat");
					if (!chat.ok) {
						ui.notify(`Health OK, /v1/models failed: ${chat.error}`, "warning");
						continue;
					}
					ui.notify(`OK · health ${health.ms}ms · ${chat.models.length} chat models · ${chat.ms}ms`, "info");
				}
			}
			continue;
		}

		if (choice.startsWith("Sync models")) {
			config = await runSync(pi, ui, config, "full");
			continue;
		}

		if (choice.startsWith("Quick sync")) {
			config = await runSync(pi, ui, config, "quick");
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

export default function (pi: ExtensionAPI) {
	const config = loadConfig();

	// Register cached chat models at startup so /model works immediately.
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

	const refreshFooter = (ctx: { hasUI?: boolean; ui: ExtensionContext["ui"] }) => {
		if (!ctx.hasUI) return;
		paintFooterStatus(ctx.ui, footerFromConfig());
	};

	pi.on("session_start", async (_event, ctx) => {
		refreshFooter(ctx);
	});
}

// re-export for tests
export { isSyncStale, STALE_SYNC_MS, withTimeout, authHeaders, lookupInfo, catalogKey, INFO_MISSING_TTL, INFO_CACHE_TTL, isInfoMissingCached, enrichCatalog };
