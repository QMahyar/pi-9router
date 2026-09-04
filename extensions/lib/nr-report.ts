/**
 * Report helpers shared by the /9router TUI, the sync pipeline, and diagnose:
 * gated debug logging (NR_DEBUG) and the one-line triage/info formatters.
 * Pure — no config, no HTTP.
 */

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
