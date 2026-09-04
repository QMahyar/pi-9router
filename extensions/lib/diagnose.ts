/**
 * Diagnose: health check, per-kind list latency, a sample /v1/models/info
 * probe (reusing the chat list's first id — no second fetch), and voice-TTS
 * probes. Used by the /9router → Diagnose menu item and the e2e script.
 */

import type { RemoteModel } from "./shared.ts";
import {
  healthCheck,
  isSyncStale,
  normalizeEndpoint,
  resolveApiKey,
} from "./shared.ts";
import {
  debugLog,
  DIAGNOSE_PROBE_KINDS,
  formatTriageLine,
} from "./nr-report.ts";
import {
  fetchKind,
  fetchModelInfo,
  probeSpeech,
  VOICE_TTS_PROVIDERS,
  type SyncConfig,
} from "./sync.ts";

export interface DiagnoseResult {
  endpoint: string;
  health: { ok: boolean; error?: string; ms?: number };
  kinds: Array<{
    kind: string;
    ok: boolean;
    count?: number;
    ms: number;
    error?: string;
  }>;
  sampleInfo?: {
    id: string;
    ok: boolean;
    ms: number;
    name?: string;
    error?: string;
  };
  voiceProbes: Array<{
    provider: string;
    ok: boolean;
    ms?: number;
    error?: string;
  }>;
  lastSync?: string;
  lastSyncMode?: string;
  counts?: Partial<Record<string, number>>;
  infoMissingCount?: number;
  stale: boolean;
}

export async function diagnoseConnection(
  config: SyncConfig,
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
  debugLog(
    "timing",
    `diagnose health: ${out.health.ms ?? 0}ms ${out.health.ok ? "OK" : `FAIL ${out.health.error ?? ""}`}`,
  );

  // Reuse the first chat list for the sample info id — no second fetch.
  let chatSampleId: string | undefined;
  for (const kind of DIAGNOSE_PROBE_KINDS) {
    opts.onProgress?.(`List ${kind}…`);
    const r = await fetchKind(endpoint, apiKey, kind, opts.signal);
    debugLog(
      "timing",
      `diagnose list ${kind}: ${r.ms}ms ${r.ok ? `${r.models.length} models` : `FAIL ${r.error}`}`,
    );
    if (r.ok) {
      out.kinds.push({ kind, ok: true, count: r.models.length, ms: r.ms });
      if (kind === "chat" && chatSampleId === undefined)
        chatSampleId = r.models[0]?.id;
    } else out.kinds.push({ kind, ok: false, ms: r.ms, error: r.error });
  }

  if (chatSampleId) {
    opts.onProgress?.(`Info ${chatSampleId}…`);
    const t0 = Date.now();
    const { info } = await fetchModelInfo(
      endpoint,
      apiKey,
      chatSampleId,
      opts.signal,
    );
    const ms = Date.now() - t0;
    debugLog(
      "timing",
      `diagnose info ${chatSampleId}: ${ms}ms ${info ? "OK" : "miss"}`,
    );
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
    debugLog(
      "timing",
      `diagnose voice ${p.provider}: ${probe.ms ?? 0}ms ${probe.ok ? "OK" : `FAIL ${probe.error ?? ""}`}`,
    );
    out.voiceProbes.push({
      provider: p.provider,
      ok: probe.ok,
      ms: probe.ms,
      error: probe.error,
    });
  }

  return out;
}

/** formatDiagnose is intentionally pure over a DiagnoseResult — kept next to
 *  the shape it renders. */
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
