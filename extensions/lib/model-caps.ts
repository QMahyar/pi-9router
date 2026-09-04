/**
 * Chat-model capability mapping: the local MODEL_PATTERN_CAPS fallback table
 * (mirrors 9Router's own resolver for thin list rows), the pi model-def
 * mapping, and the friendly-name merge used by refresh. Pure — no HTTP, no
 * config I/O.
 */

import {
  type CatalogEntry,
  type ModelCapabilities,
  type RemoteModel,
  asCaps,
  inferNameFromId,
} from "./shared.ts";

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

/** One registered pi chat model (provider `9router`). */
export interface PiModelDef {
  id: string;
  name: string;
  reasoning: boolean;
  input: Array<"text" | "image">;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  contextWindow: number;
  maxTokens: number;
  compat?: Record<string, unknown>;
  /** Caps provenance: true when context/vision/reasoning came from the
   *  local MODEL_PATTERN_CAPS fallback (not live server caps). Refresh
   *  re-runs pattern inference for capless rows with a pattern-derived
   *  hint instead of trusting the hint indefinitely. */
  capsFromPattern?: boolean;
}

export function inferName(m: RemoteModel, infoName?: string): string {
  if (infoName?.trim()) return infoName.trim();
  if (m.name?.trim()) return m.name.trim();
  return inferNameFromId(m.id);
}

export function looksReasoning(id: string, caps?: ModelCapabilities): boolean {
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
  {
    pattern: "*claude*opus-5*",
    caps: {
      vision: true,
      reasoning: true,
      thinkingFormat: "claude-adaptive",
      contextWindow: 1000000,
      maxOutput: 128000,
    },
  },
  {
    pattern: "*claude*opus-4.6*",
    caps: {
      vision: true,
      reasoning: true,
      thinkingFormat: "claude-adaptive",
      contextWindow: 1000000,
      maxOutput: 128000,
    },
  },
  {
    pattern: "*claude*opus-4.7*",
    caps: {
      vision: true,
      reasoning: true,
      thinkingFormat: "claude-adaptive",
      contextWindow: 1000000,
      maxOutput: 128000,
    },
  },
  {
    pattern: "*claude*opus-4.8*",
    caps: {
      vision: true,
      reasoning: true,
      thinkingFormat: "claude-adaptive",
      contextWindow: 1000000,
      maxOutput: 128000,
    },
  },
  {
    pattern: "*claude*sonnet-4.6*",
    caps: {
      vision: true,
      reasoning: true,
      thinkingFormat: "claude-adaptive",
      contextWindow: 1000000,
      maxOutput: 128000,
    },
  },
  {
    pattern: "*claude*sonnet-4.7*",
    caps: {
      vision: true,
      reasoning: true,
      thinkingFormat: "claude-adaptive",
      contextWindow: 1000000,
      maxOutput: 128000,
    },
  },
  {
    pattern: "*claude*sonnet-5*",
    caps: {
      vision: true,
      reasoning: true,
      thinkingFormat: "claude-adaptive",
      contextWindow: 1000000,
      maxOutput: 128000,
    },
  },
  {
    pattern: "*claude*haiku*",
    caps: {
      vision: true,
      reasoning: true,
      thinkingFormat: "claude-budget",
      contextWindow: 200000,
      maxOutput: 64000,
    },
  },
  {
    pattern: "*claude*opus*",
    caps: {
      vision: true,
      reasoning: true,
      thinkingFormat: "claude-budget",
      contextWindow: 200000,
      maxOutput: 64000,
    },
  },
  {
    pattern: "*claude*sonnet*",
    caps: {
      vision: true,
      reasoning: true,
      thinkingFormat: "claude-budget",
      contextWindow: 200000,
      maxOutput: 64000,
    },
  },
  {
    pattern: "*claude*",
    caps: {
      vision: true,
      reasoning: true,
      thinkingFormat: "claude-budget",
      contextWindow: 200000,
      maxOutput: 64000,
    },
  },
  // ── Gemini ──
  {
    pattern: "*gemini-3*",
    caps: {
      vision: true,
      reasoning: true,
      thinkingFormat: "gemini-level",
      contextWindow: 1048576,
      maxOutput: 65536,
    },
  },
  {
    pattern: "*gemini-2.5*",
    caps: {
      vision: true,
      reasoning: true,
      thinkingFormat: "gemini-budget",
      contextWindow: 1048576,
      maxOutput: 65536,
    },
  },
  {
    pattern: "*gemini-2*",
    caps: { vision: true, contextWindow: 1048576, maxOutput: 65536 },
  },
  {
    pattern: "*gemini*",
    caps: { vision: true, contextWindow: 1048576, maxOutput: 64000 },
  },
  {
    pattern: "*gemma*",
    caps: { vision: true, contextWindow: 128000, maxOutput: 64000 },
  },
  // ── OpenAI GPT / o-series ──
  {
    pattern: "*gpt-5*",
    caps: {
      vision: true,
      reasoning: true,
      thinkingFormat: "openai",
      contextWindow: 400000,
      maxOutput: 128000,
    },
  },
  {
    pattern: "*gpt-4o*",
    caps: { vision: true, contextWindow: 128000, maxOutput: 16384 },
  },
  {
    pattern: "*gpt-4.1*",
    caps: { vision: true, contextWindow: 1000000, maxOutput: 32768 },
  },
  { pattern: "*gpt-4*", caps: { contextWindow: 128000, maxOutput: 64000 } },
  {
    pattern: "*gpt-oss*",
    caps: {
      reasoning: true,
      thinkingFormat: "openai",
      contextWindow: 128000,
      maxOutput: 64000,
    },
  },
  {
    pattern: "*o1*",
    caps: {
      vision: true,
      reasoning: true,
      thinkingFormat: "openai",
      contextWindow: 200000,
      maxOutput: 100000,
    },
  },
  {
    pattern: "*o3*",
    caps: {
      vision: true,
      reasoning: true,
      thinkingFormat: "openai",
      contextWindow: 200000,
      maxOutput: 100000,
    },
  },
  {
    pattern: "*o4*",
    caps: {
      vision: true,
      reasoning: true,
      thinkingFormat: "openai",
      contextWindow: 200000,
      maxOutput: 100000,
    },
  },
  // ── Grok ──
  {
    pattern: "*grok-4.5*",
    caps: {
      vision: true,
      reasoning: true,
      thinkingFormat: "openai",
      contextWindow: 500000,
      maxOutput: 64000,
    },
  },
  {
    pattern: "*grok-4*",
    caps: {
      vision: true,
      reasoning: true,
      thinkingFormat: "openai",
      contextWindow: 256000,
      maxOutput: 64000,
    },
  },
  {
    pattern: "*grok*",
    caps: {
      vision: true,
      reasoning: true,
      thinkingFormat: "openai",
      contextWindow: 256000,
      maxOutput: 64000,
    },
  },
  // ── Qwen ──
  {
    pattern: "*qwen*coder*",
    caps: {
      reasoning: true,
      thinkingFormat: "qwen",
      contextWindow: 1000000,
      maxOutput: 64000,
    },
  },
  {
    pattern: "*qwen3.5*",
    caps: {
      vision: true,
      reasoning: true,
      thinkingFormat: "qwen",
      contextWindow: 1000000,
      maxOutput: 65536,
    },
  },
  {
    pattern: "*qwen3.6*",
    caps: {
      vision: true,
      reasoning: true,
      thinkingFormat: "qwen",
      contextWindow: 1000000,
      maxOutput: 65536,
    },
  },
  {
    pattern: "*qwen3.7*",
    caps: {
      vision: true,
      reasoning: true,
      thinkingFormat: "qwen",
      contextWindow: 1000000,
      maxOutput: 65536,
    },
  },
  {
    pattern: "*qwen*max*",
    caps: {
      reasoning: true,
      thinkingFormat: "qwen",
      contextWindow: 1000000,
      maxOutput: 65536,
    },
  },
  {
    pattern: "*qwen*",
    caps: {
      reasoning: true,
      thinkingFormat: "qwen",
      contextWindow: 262144,
      maxOutput: 64000,
    },
  },
  // ── Kimi ──
  {
    pattern: "*kimi*k2*",
    caps: {
      vision: true,
      reasoning: true,
      thinkingFormat: "kimi",
      contextWindow: 262144,
      maxOutput: 262144,
    },
  },
  {
    pattern: "*kimi*",
    caps: {
      reasoning: true,
      thinkingFormat: "kimi",
      contextWindow: 262144,
      maxOutput: 64000,
    },
  },
  // ── GLM / Z.ai ──
  {
    pattern: "*glm-5*",
    caps: {
      reasoning: true,
      thinkingFormat: "zai",
      contextWindow: 200000,
      maxOutput: 128000,
    },
  },
  {
    pattern: "*glm-4.7*",
    caps: {
      reasoning: true,
      thinkingFormat: "zai",
      contextWindow: 200000,
      maxOutput: 128000,
    },
  },
  {
    pattern: "*glm*",
    caps: {
      reasoning: true,
      thinkingFormat: "zai",
      contextWindow: 200000,
      maxOutput: 64000,
    },
  },
  // ── DeepSeek ──
  {
    pattern: "*deepseek-v4*",
    caps: {
      reasoning: true,
      thinkingFormat: "deepseek",
      contextWindow: 1000000,
      maxOutput: 384000,
    },
  },
  {
    pattern: "*deepseek*",
    caps: {
      reasoning: true,
      thinkingFormat: "deepseek",
      contextWindow: 128000,
      maxOutput: 64000,
    },
  },
  // ── MiniMax ──
  {
    pattern: "*minimax-m3*",
    caps: {
      vision: true,
      reasoning: true,
      thinkingFormat: "minimax",
      contextWindow: 1048576,
      maxOutput: 512000,
    },
  },
  {
    pattern: "*minimax-m2.7*",
    caps: {
      reasoning: true,
      thinkingFormat: "minimax",
      thinkingCanDisable: false,
      contextWindow: 204800,
      maxOutput: 131072,
    },
  },
  {
    pattern: "*minimax*",
    caps: {
      reasoning: true,
      thinkingFormat: "minimax",
      thinkingCanDisable: false,
      contextWindow: 200000,
      maxOutput: 131072,
    },
  },
  // ── Others ──
  {
    pattern: "*hunyuan*",
    caps: {
      reasoning: true,
      thinkingFormat: "hunyuan",
      contextWindow: 262144,
      maxOutput: 262144,
    },
  },
  {
    pattern: "*llama-4*",
    caps: { vision: true, contextWindow: 1000000, maxOutput: 64000 },
  },
  { pattern: "*llama*", caps: { contextWindow: 128000, maxOutput: 64000 } },
  { pattern: "*codestral*", caps: { contextWindow: 256000, maxOutput: 64000 } },
  {
    pattern: "*mistral-large*",
    caps: { vision: true, contextWindow: 256000, maxOutput: 64000 },
  },
  { pattern: "*mistral*", caps: { contextWindow: 128000, maxOutput: 64000 } },
  {
    pattern: "*laguna*",
    caps: {
      reasoning: true,
      thinkingFormat: "openai",
      contextWindow: 200000,
      maxOutput: 32000,
    },
  },
  {
    pattern: "*nemotron*",
    caps: { reasoning: true, contextWindow: 128000, maxOutput: 64000 },
  },
];

/** Glob match (* = wildcard), case-insensitive — same semantics as 9Router's matchPattern. */
export function globMatch(pattern: string, s: string): boolean {
  const re = new RegExp(
    "^" +
      pattern
        .split("*")
        .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*") +
      "$",
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
  if (
    (typeof out.contextWindow !== "number" || out.contextWindow <= 0) &&
    row.caps.contextWindow != null
  ) {
    out.contextWindow = row.caps.contextWindow;
    hit = true;
  }
  if (
    (typeof out.maxOutput !== "number" || out.maxOutput <= 0) &&
    row.caps.maxOutput != null
  ) {
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
  if (
    out.thinkingFormat === undefined &&
    out.reasoning === true &&
    row.caps.thinkingFormat !== undefined
  ) {
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

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;

export function toPiModel(m: RemoteModel, info?: RemoteModel): PiModelDef {
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
    (typeof caps.maxOutput === "number" && caps.maxOutput > 0
      ? caps.maxOutput
      : undefined) || Math.min(64000, Math.floor(contextWindow / 4));

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
    const hint: RemoteModel = info
      ? { ...info, name: cached }
      : { id: m.id, name: cached };
    return toPiModel(m, hint);
  }
  return toPiModel(m, info);
}
