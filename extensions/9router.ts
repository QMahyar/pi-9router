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
 * This is the entry/wiring file: sync lives in `lib/sync.ts`, chat-model
 * mapping in `lib/model-caps.ts`, report formatters in `lib/nr-report.ts`,
 * diagnose in `lib/diagnose.ts`. The bottom of this file re-exports the
 * documented test/script seam.
 *
 * Config: ~/.pi/agent/9router.json
 * Env:    NINEROUTER_URL, NINEROUTER_KEY
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  CONFIG_PATH,
  DEFAULT_ENDPOINT,
  INFO_CACHE_TTL,
  INFO_MISSING_TTL,
  type CatalogEntry,
  type RemoteModel,
  authHeaders,
  baseV1,
  capsBadgeOf,
  capsClassOf,
  footerFromConfig,
  formatUsageByTool,
  formatUsageSummary,
  healthCheck,
  inferNameFromId,
  isFooterEnabled,
  isSyncStale,
  loadJsonFile,
  maskedKey,
  normalizeEndpoint,
  paintFooterStatus,
  resolveApiKey,
  sanitizeInfoCache,
  sanitizeInfoMissing,
  sanitizeModelNames,
  saveJsonMerge,
  setFooterEnabled,
  STALE_SYNC_MS,
  withTimeout,
} from "./lib/shared.ts";
import {
  ageAbsentEntries,
  catalogKey,
  enrichCatalog,
  fetchAllAndBuild,
  fetchKind,
  isInfoMissingCached,
  lookupInfo,
  QUICK_STALE_AFTER_ABSENT,
  type SyncConfig,
  type SyncResult,
} from "./lib/sync.ts";
import {
  buildModelNames,
  fillModelCaps,
  globMatch,
  mapThinkingCompat,
  pruneModelNamesToListed,
  toPiModelWithCachedName,
  type PiModelDef,
} from "./lib/model-caps.ts";
import {
  DIAGNOSE_PROBE_KINDS,
  debugLog,
  formatInfoLine,
  formatTriageLine,
  isDebugTopic,
} from "./lib/nr-report.ts";
import { diagnoseConnection, formatDiagnose } from "./lib/diagnose.ts";

// ── Config ──────────────────────────────────────────────────────

interface Config extends SyncConfig {}

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
    lastSyncMode:
      raw.lastSyncMode === "quick" || raw.lastSyncMode === "full"
        ? raw.lastSyncMode
        : undefined,
    chatModels: Array.isArray(raw.chatModels) ? raw.chatModels : undefined,
    catalog: Array.isArray(raw.catalog) ? raw.catalog : undefined,
    counts:
      raw.counts !== null &&
      typeof raw.counts === "object" &&
      !Array.isArray(raw.counts)
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

// ── Provider registration ───────────────────────────────────────

function registerWithPi(
  pi: ExtensionAPI,
  config: Config,
  models: PiModelDef[],
): void {
  const endpoint = normalizeEndpoint(config.endpoint);
  const apiKey = resolveApiKey(config.apiKey);
  let chatModels = models;
  // Last-known friendly chat names — explicit map first, then fall back to
  // the registered models + chat catalog entries (pre-map configs).
  // Chat-kind only so image/chat twins never donate the wrong kind's name.
  const cachedNames = new Map<string, string>();
  if (config.modelNames) {
    for (const [id, name] of Object.entries(config.modelNames)) {
      if (typeof name === "string" && name.trim())
        cachedNames.set(id, name.trim());
    }
  }
  for (const m of models) {
    if (cachedNames.has(m.id)) continue;
    if (
      typeof m.name === "string" &&
      m.name.trim() &&
      m.name.trim() !== inferNameFromId(m.id)
    ) {
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
    async refreshModels(context: {
      signal: AbortSignal;
      allowNetwork?: boolean;
    }) {
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
        pruneModelNamesToListed(
          cachedNames,
          list.models.map((m) => m.id),
        );
        for (const m of list.models) {
          if (m.name?.trim()) cachedNames.set(m.id, m.name.trim());
        }
        chatModels = next;
        saveJsonMerge({
          chatModels,
          modelNames: Object.fromEntries(cachedNames),
        });
        return chatModels;
      } catch {
        return chatModels;
      }
    },
  });
}

const PROVIDER_ID = "9router";
const PROVIDER_NAME = "9Router";

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
function describeKey(
  apiKey?: string,
  notSetText = "(not set — ok if 9Router auth off)",
): string {
  if (apiKey) return maskedKey(apiKey);
  if (process.env.NINEROUTER_KEY)
    return maskedKey(process.env.NINEROUTER_KEY) + " (env)";
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
  const extras = (
    ["image", "tts", "stt", "embedding", "web", "image-to-text"] as const
  )
    .map((k) => (counts[k] ? `${k}:${counts[k]}` : null))
    .filter(Boolean);
  if (extras.length) lines.push(`Catalog:   ${extras.join("  ")}`);
  const usage = formatUsageSummary();
  if (usage) lines.push(usage);
  const byTool = formatUsageByTool();
  if (byTool?.length) lines.push("By tool:", ...byTool);
  const staleN = (config.catalog || []).filter((e) => e.stale).length;
  if (staleN)
    lines.push(
      `Stale:     ${staleN} unconfirmed (quick sync) — run full sync to confirm`,
    );
  lines.push(`Config:    ${CONFIG_PATH}`);
  return lines;
}

async function browseCatalog(
  ui: ExtensionContext["ui"],
  config: Config,
): Promise<void> {
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
    const kindEntries = catalog
      .filter((e) => e.kind === kind)
      .sort((a, b) => a.id.localeCompare(b.id));

    // Caps filter: rich (live server caps) / thin (pattern fallback) / missing.
    const nRich = kindEntries.filter((e) => capsClassOf(e) === "rich").length;
    const nThin = kindEntries.filter((e) => capsClassOf(e) === "thin").length;
    const nMissing = kindEntries.filter(
      (e) => capsClassOf(e) === "missing",
    ).length;
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
    const entries = cls
      ? kindEntries.filter((e) => capsClassOf(e) === cls)
      : kindEntries;
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
        if (e.contextWindow)
          bits.push(`${Math.round(e.contextWindow / 1000)}k`);
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
        entry.synthetic
          ? `source: added locally${entry.note ? ` — ${entry.note}` : ""}`
          : "",
        entry.ownedBy ? `owned_by: ${entry.ownedBy}` : "",
        entry.endpoint ? `endpoint: ${entry.endpoint}` : "",
        entry.contextWindow ? `contextWindow: ${entry.contextWindow}` : "",
        entry.maxTokens ? `maxTokens: ${entry.maxTokens}` : "",
        entry.reasoning != null ? `reasoning: ${entry.reasoning}` : "",
        entry.input ? `input: ${entry.input.join(", ")}` : "",
        entry.registered
          ? "registered in pi: yes"
          : "registered in pi: no (non-chat or not synced)",
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

async function runSync(
  pi: ExtensionAPI,
  ui: ExtensionContext["ui"],
  config: Config,
  mode: "quick" | "full",
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
    sync.voiceSkipped?.length
      ? `Voice TTS unavailable: ${sync.voiceSkipped.join(", ")}`
      : "",
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

async function runNineRouterUI(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<void> {
  const ui = ctx.ui;
  let config = loadConfig();

  while (true) {
    const chatN = config.chatModels?.length ?? 0;
    const synced = config.lastSync
      ? new Date(config.lastSync).toLocaleString()
      : "never";
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
      footerOn
        ? "Footer: on  (hide from status bar)"
        : "Footer: off  (show in status bar)",
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
          const next = await ui.input(
            "Base URL (no /v1)",
            config.endpoint || DEFAULT_ENDPOINT,
          );
          if (next?.trim()) {
            config = { ...config, endpoint: normalizeEndpoint(next.trim()) };
            saveConfig(config);
            if (config.chatModels?.length)
              registerWithPi(pi, config, config.chatModels);
            ui.notify("Endpoint saved", "info");
          }
          continue;
        }

        if (sub.startsWith("API key")) {
          const next = await ui.input(
            "API key (Dashboard → Keys)",
            config.apiKey || "",
          );
          if (next !== undefined) {
            config = { ...config, apiKey: next.trim() || undefined };
            saveConfig(config);
            if (config.chatModels?.length)
              registerWithPi(pi, config, config.chatModels);
            ui.notify(
              config.apiKey ? "API key saved" : "API key cleared",
              "info",
            );
          }
          continue;
        }

        if (sub === "Clear API key") {
          const ok = await ui.confirm(
            "Clear API key?",
            "Env NINEROUTER_KEY still works if set.",
          );
          if (ok) {
            config = { ...config, apiKey: undefined };
            saveConfig(config);
            if (config.chatModels?.length)
              registerWithPi(pi, config, config.chatModels);
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
          const chat = await fetchKind(
            config.endpoint,
            resolveApiKey(config.apiKey),
            "chat",
          );
          if (!chat.ok) {
            ui.notify(`Health OK, /v1/models failed: ${chat.error}`, "warning");
            continue;
          }
          ui.notify(
            `OK · health ${health.ms}ms · ${chat.models.length} chat models · ${chat.ms}ms`,
            "info",
          );
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
        catalog: (config.catalog || []).map((c) => ({
          ...c,
          registered: false,
        })),
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
      console.error(
        "[pi-9router] failed to register cached models:",
        err?.message || err,
      );
    }
  }

  pi.registerCommand("9router", {
    description:
      "9Router — connect, sync models, register chat providers in pi",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI && ctx.mode !== "tui") {
        ctx.ui.notify("/9router needs interactive mode", "error");
        return;
      }
      await runNineRouterUI(pi, ctx);
    },
  });

  const refreshFooter = (ctx: {
    hasUI?: boolean;
    ui: ExtensionContext["ui"];
  }) => {
    if (!ctx.hasUI) return;
    paintFooterStatus(ctx.ui, footerFromConfig());
  };

  pi.on("session_start", async (_event, ctx) => {
    refreshFooter(ctx);
  });
}

// re-export for tests
export {
  isSyncStale,
  STALE_SYNC_MS,
  withTimeout,
  authHeaders,
  lookupInfo,
  catalogKey,
  INFO_MISSING_TTL,
  INFO_CACHE_TTL,
  isInfoMissingCached,
  enrichCatalog,
  ageAbsentEntries,
  buildModelNames,
  pruneModelNamesToListed,
  fetchAllAndBuild,
  fillModelCaps,
  globMatch,
  mapThinkingCompat,
  toPiModelWithCachedName,
  QUICK_STALE_AFTER_ABSENT,
  formatInfoLine,
  formatTriageLine,
  isDebugTopic,
  debugLog,
  DIAGNOSE_PROBE_KINDS,
  diagnoseConnection,
  formatDiagnose,
};
export type { SyncResult, SyncConfig, CatalogEntry, RemoteModel };
