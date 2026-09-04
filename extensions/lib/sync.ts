/**
 * Sync pipeline: per-kind list fetching, /v1/models/info enrichment with the
 * 7 d positive / 24 h negative caches, voice-TTS discovery (edge/google),
 * quick-sync stale aging, and fetchAllAndBuild (the full/quick sync used by
 * the /9router TUI). 9router.ts wires the result into pi + config.
 */

import {
  type CatalogEntry,
  type InfoCacheEntry,
  type ModelCapabilities,
  type RemoteModel,
  INFO_MISSING_TTL,
  TIMEOUT,
  asCaps,
  baseV1,
  healthCheck,
  httpGetJson,
  isInfoCacheFresh,
  listRowIsRich,
  loadJsonFile,
  mapConcurrent,
  normalizeEndpoint,
  postBinary,
  resolveApiKey,
  sanitizeInfoCache,
  sanitizeInfoMissing,
} from "./shared.ts";
import { debugLog } from "./nr-report.ts";
import {
  type PiModelDef,
  buildModelNames,
  fillModelCaps,
  inferName,
  looksReasoning,
  toPiModelWithCachedName,
} from "./model-caps.ts";

const INFO_CONCURRENCY = 8;

/** Full multi-kind catalog (tools + browse). Video has no list endpoint —
 *  its tool uses the documented `xai/grok-imagine-video` id directly. */
export const FULL_CATALOG_KINDS = [
  "chat",
  "image",
  "tts",
  "stt",
  "embedding",
  "web",
  "image-to-text",
] as const;

/** Chat-only quick sync — skips tool catalogs and voice probes. */
export const QUICK_CATALOG_KINDS = ["chat"] as const;

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
export const VOICE_TTS_PROVIDERS: Array<{
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

// ── Config shape ────────────────────────────────────────────────

/** One registered pi chat model (provider `9router`). Re-exported for the
 *  9router.ts config type. */
export type { PiModelDef } from "./model-caps.ts";

/** The persisted sync config (9router.json as seen by the sync side). */
export interface SyncConfig {
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

// ── Catalog mapping ─────────────────────────────────────────────

/** Keep only fields tools/browse need — shrinks ~/.pi/agent/9router.json. */
function slimCaps(
  caps?: ModelCapabilities | string[],
): ModelCapabilities | string[] | undefined {
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

export async function fetchKind(
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
  if (!res.ok)
    return { ok: false, error: `${kind}: HTTP ${res.status} ${res.error}`, ms };
  const models = Array.isArray(res.data.data) ? res.data.data : [];
  return { ok: true, models, ms };
}

export async function fetchModelInfo(
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
  if (!res.data || typeof res.data !== "object" || (res.data as any).error)
    return { info: null, status: 200 };
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

export function catalogKey(kind: string, id: string): string {
  return `${kind}\0${id}`;
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
export function lookupInfo(
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
export function isInfoMissingCached(
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
export async function enrichCatalog(
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
  const infoMissing: Record<string, number> =
    sanitizeInfoMissing(opts.infoMissing, now) ?? {};
  const infoCache: Record<string, InfoCacheEntry> =
    sanitizeInfoCache(opts.infoCache, now) ?? {};
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
    if (Array.isArray(info.params) && info.params.length)
      entry.params = info.params;
    const caps = fillModelCaps(
      entry.id,
      asCaps(info.capabilities) || {},
      (pattern) => {
        entry.capsFromPattern = true;
        countPatternHit(pattern);
      },
    );
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
    if (
      !remotesByKey.has(`${entry.kind}\0${entry.id}`) &&
      (entry.namedByServer || entry.params?.length || entry.detailKind)
    ) {
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
      const caps = fillModelCaps(
        entry.id,
        asCaps(remote.capabilities) || {},
        (pattern) => {
          entry.capsFromPattern = true;
          countPatternHit(pattern);
        },
      );
      if (Object.keys(caps).length) applyCapsToEntry(entry, caps);
      if (remote.kind?.trim()) entry.detailKind = remote.kind.trim();
      if (Array.isArray(remote.params) && remote.params.length)
        entry.params = remote.params;
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
      const { info, status } = await fetchModelInfo(
        endpoint,
        apiKey,
        entry.id,
        opts.signal,
      );
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
  if (aborted)
    debugLog("sync", "enrich aborted — partial results discarded by caller");

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

export async function probeSpeech(
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
  if (!res.ok)
    return { ok: false, error: `HTTP ${res.status} ${res.error}`, ms };
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
  const res = await httpGetJson<{
    data?: Array<{ model?: string; id?: string; name?: string }>;
  }>(url, apiKey, { signal, timeoutMs: TIMEOUT.info });
  if (!res.ok) return null;
  const rows = Array.isArray(res.data?.data) ? res.data.data : [];
  const ids = rows
    .map((v) => (v.model || v.id || v.name || "").trim())
    .filter(Boolean)
    .map((v) =>
      v.startsWith(`${provider}/`) ? v.slice(provider.length + 1) : v,
    );
  return ids.length ? ids : null;
}

export async function discoverVoiceTts(
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
        const listed = await fetchVoices(
          endpoint,
          apiKey,
          p.provider,
          opts.signal,
        );
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

export type SyncMode = "quick" | "full";

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
  config: SyncConfig,
  opts: {
    signal?: AbortSignal;
    mode?: SyncMode;
    onProgress?: (msg: string) => void;
  } = {},
): Promise<SyncResult> {
  const mode: SyncMode = opts.mode || "full";
  const kinds = mode === "quick" ? ["chat" as const] : FULL_CATALOG_KINDS;
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
        r.ok
          ? `Listed ${kind}: ${r.models.length} models (${r.ms}ms)…`
          : `List ${kind} failed: ${r.error}`,
      );
      return { kind, r };
    }),
  );
  timings.lists = Date.now() - tList;

  const errors: string[] = [];
  let chatRemotes: RemoteModel[] = [];

  for (const { kind, r } of results) {
    timings[`list:${kind}`] = r.ms;
    debugLog(
      "timing",
      `list ${kind}: ${r.ms}ms ${r.ok ? `${r.models.length} models` : `FAIL ${r.error}`}`,
    );
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
    const rawCatalog = loadJsonFile().catalog;
    const prev = (
      Array.isArray(rawCatalog) ? rawCatalog : ([] as CatalogEntry[])
    ).filter((e: CatalogEntry) => e.kind !== "chat");
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
  const enriched = await enrichCatalog(
    endpoint,
    apiKey,
    catalog,
    remotesByKey,
    {
      signal: opts.signal,
      onProgress: opts.onProgress,
      infoMissing: config.infoMissing,
      infoCache: config.infoCache,
    },
  );
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
      error:
        "Sync aborted during metadata fetch — partial results discarded (config unchanged).",
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
  const namedByServer = enriched.named;
  const infoFetched = enriched.fetched;
  const infoSkipped = enriched.skipped;
  const infoCached = enriched.cachedInfo;
  const infoMissed = enriched.missing;
  const infoSkippedNegative = enriched.skippedNegative;
  patternHits += enriched.patternHits;
  debugLog(
    "sync",
    `pattern fallback hits=${patternHits} (list+enrich) of ${catalog.length} catalog rows`,
  );

  let voiceSkipped: string[] = [];
  let voiceAdded = 0;
  if (mode === "full") {
    const tVoice = Date.now();
    const voice = await discoverVoiceTts(endpoint, apiKey, {
      signal: opts.signal,
      onProgress: opts.onProgress,
    });
    timings.voice = Date.now() - tVoice;
    debugLog(
      "timing",
      `voice: ${timings.voice}ms added=${voice.entries.length} skipped=${voice.skipped.length}`,
    );
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
    namesDerived: catalog.filter((c) => !c.namedByServer && !c.synthetic)
      .length,
    infoFetched,
    infoSkipped,
    infoCached,
    infoMissed,
    infoSkippedNegative,
    patternHits,
    voiceSkipped,
    voiceAdded,
    infoMissing: enriched.infoMissing,
    infoCache: enriched.infoCache,
    modelNames,
    timings,
  };
}
