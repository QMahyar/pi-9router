/**
 * Tool-model resolution: the tools-side config slice, capability state,
 * `resolveModel` (whatever the caller passed → a real catalog id), and the
 * compact description builders. Pure over the config slice — no HTTP, no fs.
 */

import {
  type CapDef,
  type CapId,
  type CatalogEntry,
  CAPS,
  DEFAULT_OUTPUT_DIR,
  VOICE_PROVIDER_PREFIXES,
  loadJsonFile,
  normalizeEndpoint,
  pickAutoDefaultModel,
  resolveApiKey,
  saveJsonMerge,
} from "./shared.ts";

// ── Types / config slice ────────────────────────────────────────

export interface CapState {
  enabled: boolean;
  model?: string;
}

export interface ToolsConfigSlice {
  endpoint?: string;
  apiKey?: string;
  catalog?: CatalogEntry[];
  counts?: Record<string, number>;
  lastSync?: string;
  lastSyncMode?: string;
  capabilities?: Partial<Record<CapId, CapState>>;
  outputDir?: string;
  /** Inline generated images into the conversation as base64 (default false) */
  attachImages?: boolean;
}

export function loadRaw(): ToolsConfigSlice {
  return loadJsonFile() as ToolsConfigSlice;
}

export function saveRaw(patch: Partial<ToolsConfigSlice>): ToolsConfigSlice {
  return saveJsonMerge(patch as Record<string, unknown>) as ToolsConfigSlice;
}

export function endpointOf(cfg: ToolsConfigSlice): string {
  return normalizeEndpoint(cfg.endpoint);
}

export function apiKeyOf(cfg: ToolsConfigSlice): string {
  return resolveApiKey(cfg.apiKey);
}

export function outputDirOf(cfg: ToolsConfigSlice): string {
  return cfg.outputDir || DEFAULT_OUTPUT_DIR;
}

/** Inline generated images into the conversation as base64 (default false). */
export function shouldAttachImage(cfg: ToolsConfigSlice): boolean {
  return cfg.attachImages === true;
}

export function defaultCapState(cap: CapDef): CapState {
  return { enabled: cap.defaultEnabled };
}

export function getCapState(cfg: ToolsConfigSlice, cap: CapDef): CapState {
  return { ...defaultCapState(cap), ...(cfg.capabilities?.[cap.id] || {}) };
}

/**
 * Documented video default. 9Router exposes no /v1/models/video list
 * endpoint, so the catalog rarely holds video entries — resolveModel still
 * routes through the shared path and falls back to this id.
 */
export const VIDEO_DEFAULT_MODEL = "xai/grok-imagine-video";

export function modelsForCap(
  cfg: ToolsConfigSlice,
  cap: CapDef,
): CatalogEntry[] {
  const catalog = cfg.catalog || [];
  const filter = cap.catalogKind;
  const models =
    typeof filter === "function"
      ? catalog.filter(filter)
      : catalog.filter((e) => e.kind === filter);
  if (cap.id === "video" && models.length === 0) {
    // No list endpoint — synthesize the documented default so resolveModel,
    // reject-with-candidates, and the compact description keep working.
    return [
      {
        id: VIDEO_DEFAULT_MODEL,
        name: "Grok Imagine video",
        kind: "video",
        note: "documented default (no video list endpoint)",
      },
    ];
  }
  return models;
}

function normalizeId(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function leafOf(id: string): string {
  const i = id.lastIndexOf("/");
  return i >= 0 ? id.slice(i + 1) : id;
}

export function isVoiceProviderId(id: string): boolean {
  const i = id.indexOf("/");
  if (i <= 0 || i === id.length - 1) return false;
  return VOICE_PROVIDER_PREFIXES.includes(id.slice(0, i));
}

/**
 * Explicit escape hatch for custom/future video models. 9Router exposes no
 * /v1/models/video list endpoint, so a brand-new provider video id can never
 * appear in the synced catalog — a single-`/` `provider/model` id passes
 * through verbatim (billed if valid; the server is the final validator).
 * Bare names without a slash still reject with the available candidates.
 */
export function isVideoPassthroughId(id: string): boolean {
  const i = id.indexOf("/");
  return i > 0 && i < id.length - 1 && id.indexOf("/", i + 1) === -1;
}

/**
 * True when omitting `model` would bill a capability-aware auto pick rather
 * than a configured default: no saved default, no documented video default,
 * and the rich-row pick differs from the first entry. The tool description
 * and status rows announce this so the billed default is never silent — set
 * an explicit default in /9router-tools to pin it.
 */
export function isAutoRichDefault(cfg: ToolsConfigSlice, cap: CapDef): boolean {
  const models = modelsForCap(cfg, cap);
  if (models.length === 0) return false;
  if (getCapState(cfg, cap).model?.trim()) return false;
  if (cap.id === "video" && models.some((m) => m.id === VIDEO_DEFAULT_MODEL))
    return false;
  const auto = pickAutoDefaultModel(models);
  return !!auto && auto.id !== models[0]?.id;
}

/**
 * The default model a tool runs when `model` is omitted — single source of
 * truth for resolveModel, withModelHint, and the TUI status rows, so the
 * description always names the model that actually runs. Precedence: a saved
 * default that is still usable (in the catalog, or a voice/passthrough id
 * the wire accepts) → the documented video default → the capability-aware
 * auto pick. `usable` reports whether the saved default was usable (drives
 * the "no longer in the catalog" note).
 */
export function effectiveDefault(
  cfg: ToolsConfigSlice,
  cap: CapDef,
): { id: string | undefined; usable: boolean; saved: string | undefined } {
  const models = modelsForCap(cfg, cap);
  const saved = getCapState(cfg, cap).model?.trim();
  // Voice-provider ids are TTS-only: a saved voice id must never become
  // the video model (the create call is billed per generation).
  const savedVoiceOk = cap.id !== "video" && isVoiceProviderId(saved ?? "");
  const usable =
    saved &&
    (models.some((m) => m.id === saved) ||
      savedVoiceOk ||
      // Covers the documented default plus custom/future video ids
      // (never a TTS voice id — those are rejected for video below).
      (cap.id === "video" &&
        isVideoPassthroughId(saved) &&
        !isVoiceProviderId(saved)))
      ? saved
      : undefined;
  // Video prefers the documented default when it is among the synced
  // entries (modelsForCap already synthesizes it when none are synced).
  const videoDefault =
    cap.id === "video"
      ? models.find((m) => m.id === VIDEO_DEFAULT_MODEL)?.id
      : undefined;
  // Capability-aware auto default: first rich row (live caps) wins over
  // a thin first entry when the user omits `model` and no default is set.
  const auto = pickAutoDefaultModel(models)?.id;
  return { id: usable || videoDefault || auto, usable: Boolean(usable), saved };
}

export type ModelResolution =
  { ok: true; id: string; note?: string } | { ok: false; message: string };

/**
 * Turn whatever the caller passed for `model` into a real catalog id.
 */
export function resolveModel(
  cfg: ToolsConfigSlice,
  cap: CapDef,
  override?: string,
): ModelResolution {
  const models = modelsForCap(cfg, cap);
  const want = override?.trim();

  if (!want) {
    const { id: fallback, usable, saved } = effectiveDefault(cfg, cap);
    if (!fallback) {
      return {
        ok: false,
        message: `No ${cap.label.toLowerCase()} model available. Run /9router → Sync models, then set a default in /9router-tools.`,
      };
    }
    return {
      ok: true,
      id: fallback,
      note:
        saved && !usable
          ? `default "${saved}" is no longer in the catalog — used ${fallback}`
          : isAutoRichDefault(cfg, cap)
            ? `auto default ${fallback} (rich caps)`
            : undefined,
    };
  }

  const exact = models.find((m) => m.id === want);
  if (exact) return { ok: true, id: exact.id };

  const ci = models.find((m) => m.id.toLowerCase() === want.toLowerCase());
  if (ci) return { ok: true, id: ci.id, note: `matched "${want}"` };

  const key = normalizeId(want);
  if (key) {
    const keyed = models.filter(
      (m) =>
        normalizeId(m.id) === key ||
        normalizeId(leafOf(m.id)) === key ||
        (m.name ? normalizeId(m.name) === key : false),
    );
    if (keyed.length === 1) {
      return {
        ok: true,
        id: keyed[0].id,
        note: `resolved "${want}" → ${keyed[0].id}`,
      };
    }
    if (keyed.length > 1) return { ok: false, message: ambiguous(want, keyed) };

    const partial = models.filter(
      (m) =>
        normalizeId(m.id).includes(key) ||
        (m.name ? normalizeId(m.name).includes(key) : false),
    );
    if (partial.length === 1) {
      return {
        ok: true,
        id: partial[0].id,
        note: `resolved "${want}" → ${partial[0].id}`,
      };
    }
    if (partial.length > 1)
      return { ok: false, message: ambiguous(want, partial) };
  }

  // The documented video id works even when it was never synced (no list endpoint).
  if (cap.id === "video") {
    if (want === VIDEO_DEFAULT_MODEL)
      return { ok: true, id: VIDEO_DEFAULT_MODEL };
    const defaultKey = normalizeId(VIDEO_DEFAULT_MODEL);
    const wantKey = normalizeId(want);
    if (
      want.toLowerCase() === VIDEO_DEFAULT_MODEL.toLowerCase() ||
      (wantKey !== "" &&
        (wantKey === defaultKey ||
          wantKey === normalizeId(leafOf(VIDEO_DEFAULT_MODEL))))
    ) {
      return {
        ok: true,
        id: VIDEO_DEFAULT_MODEL,
        note: `resolved "${want}" → ${VIDEO_DEFAULT_MODEL}`,
      };
    }
  }

  // Custom/future video models pass through verbatim (no list endpoint to
  // sync them from) — bare names fall through to reject-with-candidates.
  // TTS voice ids are excluded: provider/voice also has one slash, but a
  // voice id as the video model would waste a billed create.
  if (
    cap.id === "video" &&
    isVideoPassthroughId(want) &&
    !isVoiceProviderId(want)
  ) {
    return {
      ok: true,
      id: want,
      note: `passthrough video model "${want}" (not in catalog — billed if valid)`,
    };
  }

  // Voice-provider ids are TTS-only — never a video model (billed create).
  if (cap.id !== "video" && isVoiceProviderId(want))
    return { ok: true, id: want };

  return {
    ok: false,
    message: [
      `Unknown ${cap.label.toLowerCase()} model "${want}".`,
      models.length
        ? `Available: ${models.map((m) => m.id).join(", ")}`
        : "No models in the catalog — run /9router → Sync models.",
      "Omit `model` to use the configured default.",
    ].join("\n"),
  };
}

const MAX_LISTED_MODELS = 14;

/**
 * Render available ids (+ optional params) for the tool description.
 */
export function describeModels(cfg: ToolsConfigSlice, cap: CapDef): string {
  const models = modelsForCap(cfg, cap);
  if (!models.length)
    return "No models synced yet — run /9router → Sync models.";

  const listed = models.filter((m) => !m.synthetic);
  const synthetic = models.filter((m) => m.synthetic);
  const parts: string[] = [];

  const head = listed.slice(0, MAX_LISTED_MODELS);
  if (head.length) {
    parts.push(
      head
        .map((m) => {
          const label =
            m.name && m.name !== m.id ? `${m.id} (${m.name})` : m.id;
          const p = m.params?.length ? ` [${m.params.join(", ")}]` : "";
          return label + p;
        })
        .join(", ") +
        (listed.length > head.length
          ? `, +${listed.length - head.length} more`
          : ""),
    );
  }

  const byProvider = new Map<string, string[]>();
  for (const m of synthetic) {
    const p = m.ownedBy || leafOf(m.id);
    byProvider.set(p, [...(byProvider.get(p) || []), leafOf(m.id)]);
  }
  for (const [provider, voices] of byProvider) {
    parts.push(
      `${provider}/<voice> — e.g. ${voices.slice(0, 3).join(", ")} (${voices.length} listed, any ${provider} voice id works)`,
    );
  }

  return `Available: ${parts.join("; ")}.`;
}

/**
 * Compact per-tool model hint for descriptions. Intentionally does NOT embed
 * the full catalog (repeating ~14 ids + voice lists in every tool description
 * bloats the system prompt). Models are resolved at execution time; unknown
 * ids are rejected with the available list (see resolveModel), and
 * /9router-tools browses the catalog interactively.
 */
export function withModelHint(
  cfg: ToolsConfigSlice,
  cap: CapDef,
  base: string,
): string {
  const n = modelsForCap(cfg, cap).length;
  // Mirrors resolveModel's no-override path via effectiveDefault — the hint
  // must name the model that actually runs.
  const def = effectiveDefault(cfg, cap).id;
  // A billed auto pick is announced, never silent — pin it in /9router-tools.
  const autoNote = isAutoRichDefault(cfg, cap)
    ? "; auto default — set a model in /9router-tools to pin it"
    : "";

  const lines = [base, ""];
  lines.push(
    n
      ? `Default model: ${def ?? "(none set)"} (${n} available${autoNote}).`
      : "No models synced yet — run /9router → Sync models first.",
  );
  lines.push(
    "Omit `model` to use the default. When the user names a specific model, pass its exact catalog id (browse via /9router-tools); a fuzzy name is resolved or rejected with the available list.",
  );
  if (cap.id === "tts") {
    lines.push(
      "edge-tts and google-tts accept arbitrary voice ids, e.g. edge-tts/en-US-AriaNeural, google-tts/en.",
    );
  }
  return lines.join("\n");
}

function ambiguous(want: string, matches: CatalogEntry[]): string {
  return [
    `"${want}" matches ${matches.length} models — pass one exactly:`,
    ...matches.map(
      (m) => `  ${m.id}${m.name && m.name !== m.id ? `  (${m.name})` : ""}`,
    ),
  ].join("\n");
}

/** All caps — re-exported so tools/TUI share one import surface. */
export { CAPS };
