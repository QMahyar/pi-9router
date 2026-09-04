# Dev — @qmahyar/pi-9router

```text
extensions/
  9router.ts         # /9router entry — config, provider registration, TUI, re-exports
  9router-tools.ts   # /9router-tools entry — session wiring, re-exports
  lib/
    shared.ts        # HTTP, timeouts, config merge, CAPS, usage log, footer
    nr-report.ts     # NR_DEBUG gating + triage/info report formatters
    model-caps.ts    # MODEL_PATTERN_CAPS + pi model mapping + name merge
    sync.ts          # list fetch, enrich (caches), voice TTS, fetchAllAndBuild
    diagnose.ts      # diagnoseConnection + formatDiagnose
    model-resolve.ts # tools config slice, resolveModel, description hints
    toolkit.ts       # ToolError, usage ctx, output files, truncation, render
    tools-media.ts   # image/tts/video/stt implementations
    tools-web.ts     # embed/search/fetch implementations
    tools-register.ts# tool registration wrappers + /9router-tools TUI
tests/               # offline unit tests (bun test)
scripts/
  e2e-test.ts        # live E2E against local 9Router
  dev-install.ts     # copy the extension tree into pi's package path
CHANGELOG.md         # cross-session WIP + release history (update every session)
```

**Handoff:** keep `[Unreleased]` in `CHANGELOG.md` current while you work; on release,
move bullets into a `[X.Y.Z]` section. Local machine install/publish steps live in
gitignored `AGENTS.md` when present.

- Core emits `9router:synced` after catalog refresh.
- Tools call `setActiveTools` so only enabled tools hit the model prompt.
- Shared config: `~/.pi/agent/9router.json`

**Catalog enrichment.** `infoById` is keyed by `kind\0id` (`catalogKey` +
`lookupInfo`: kind-qualified hit, unambiguous bare-id fallback only) so
cross-kind twins never donate the wrong kind's info name. `/v1/models/info`
results persist merge-safe in `9router.json`: positive `infoCache` (7d TTL,
`isInfoCacheFresh`) + negative `infoMissing` (24h TTL, `isInfoMissingCached`);
`saveJsonMerge` union-merges both maps key-wise and prunes expired entries on
write. `MODEL_PATTERN_CAPS` fills only absent fields and reports hits via
`fillModelCaps(id, caps, onHit)` → `patternHits` (sync report + `NR_DEBUG=sync`);
`capsClassOf`/`capsBadgeOf` expose the provenance (rich/thin/missing) to browse.
Chat+image twins sharing a bare id burn one info probe (both entries named,
each keeping its kind-qualified record); an aborted enrich fails the sync
instead of reporting partial success; enrich progress notifies scale with the
total (~10 `Metadata n/N` updates at any size, floor 1 per model).

**Sync modes.** Full catalog (default) fetches chat/image/tts/stt/embedding/web/
image-to-text, enriches, probes voice TTS. Quick sync fetches chat only and keeps
previous non-chat catalog entries so tools keep working — entries unseen twice
are flagged `stale` (`absentSyncs`, `QUICK_STALE_AFTER_ABSENT=2`, synthetic voice
entries exempt); full sync rebuilds from fresh lists and clears/prunes them.

**STT** is synced from `/v1/models/stt` (may be empty when no provider is
connected). `nr_stt` ships **off** by default — enable in `/9router-tools`.

**Video** has no `/v1/models` list endpoint; `nr_video_generate` resolves `model`
through the shared `resolveModel` path against synced video entries and falls
back to the documented `xai/grok-imagine-video` when none are synced. A
`provider/model` id not in the catalog passes through verbatim
(`isVideoPassthroughId` — billed if valid); bare unknown names are rejected
with the video-only candidate list. Create → poll `GET
/v1/videos/{request_id}` (echoing the create response's
`x-9router-connection-id` header) → download MP4. Creation is never retried
(billing); 401/402/403 abort immediately in both create and polls
(`isFatalMediaStatus`, shared with the image path) and the 403 keeps up to 2KB of
server detail (`videoCreateError`, `fullError` transport — bounded, not the 400-char default).
Poll failures are tolerated until the 10-minute deadline; polls toast only
when status/progress advances (`videoPollChanged` lastProgress dedup — a
full-length job polls ~200 times).

**Synthetic entries.** `edge-tts` / `google-tts` are added locally (`synthetic: true`)
after a `/v1/audio/speech` probe returns real audio.

**Tool descriptions** stay compact (configured default model + count, not the
full catalog); `registerAllTools()` re-runs on `9router:synced` and after a
default-model change in `/9router-tools`. Tool failures
**throw** from `execute()` (a returned `isError: true` is ignored by pi — only
throwing sets the error flag). `nr_web_search`/`nr_web_fetch` results are
truncated to 50KB/2000 lines with the full text saved to a temp file. The chat
provider also exposes a live `refreshModels` hook (thin refresh rows map through
`toPiModelWithCachedName` against persisted `modelNames` from `buildModelNames`,
chat-kind only; persists successful refreshes; falls back to cached models on
error or `allowNetwork: false`), so pi-side refresh flows like
`pi update --models` re-fetch the chat list without a manual /9router sync.

**Diagnose** (`diagnoseConnection`) reuses the first chat list for the sample
info id (one fetch, not two), probes every `DIAGNOSE_PROBE_KINDS` entry
(chat/image/tts/stt/embedding/web/image-to-text/video — video has no list
endpoint so its FAIL row still carries latency) plus the `edge-tts`/`google-tts`
speech probes, and shares `formatTriageLine` with Status. `NR_DEBUG=sync,timing`
gates debug logging (`isDebugTopic`/`debugLog`).

**Images.** `nr_image_generate` loops `n` times on the binary path, supports optional
`image_path` for edit/img2img (20 MB cap), and returns a path by default
(`attachImages` opts in). Batch presets (`prompts`, up to 4) are planned by the
pure `planImageBatch` helper (one image per prompt, `n` ignored). 200-with-JSON responses are never saved as image
files, and 401/402/403 aborts the fallback chain instead of retrying paid
requests. Existing output files are never overwritten (numeric suffix on
collision). Omitted `model` with no default auto-picks the first rich row
(`pickAutoDefaultModel`) and says so in the result note, the tool description,
and the status rows (`isAutoRichDefault` — `(auto)` marker); saved defaults
always win, all-thin catalogs fall back to the first entry with no marker.

**TTS.** Binary audio first; a JSON body on the binary path is parsed in place
(`{audio, format}`), with `?response_format=json` only as a re-request fallback.

**`model` on the wire** is not always the catalog id: search/fetch take a bare
provider name (`exa`, not `exa/search`).

**Timeouts** (shared): health 8s · list 45s · info 12s · probe 20s · tools 120s ·
video (async, polled) 10min.

**Stale catalog:** lastSync older than 24h shows a warning in status / session footer.

Exported for testing: `fetchAllAndBuild`, `enrichCatalog`, `diagnoseConnection`, `resolveModel`,
`describeModels`, `planImageBatch`, `isFatalMediaStatus`, `videoCreateError`, `CAPS`, `generateImages`,
`catalogKey`, `lookupInfo`, `isInfoMissingCached`, `buildModelNames`, `pruneModelNamesToListed`,
`toPiModelWithCachedName`, `ageAbsentEntries`, `formatTriageLine`, `formatInfoLine`,
`statusLines`, `formatDiagnose`, `isDebugTopic`/`debugLog`, `DIAGNOSE_PROBE_KINDS`,
`QUICK_STALE_AFTER_ABSENT`, `VIDEO_DEFAULT_MODEL`, `VIDEO_POLL_INTERVAL_MS`,
`videoPollChanged`, `isVideoPassthroughId`, `isAutoRichDefault`, `withModelHint`, `gateUsageRec`,
plus pure helpers from
`lib/shared.ts` (`isInfoCacheFresh`, `sanitizeInfoMissing`/`sanitizeInfoCache`/`sanitizeModelNames`,
`pickAutoDefaultModel`, `capsClassOf`/`capsBadgeOf`, `footerFromConfig`,
`logUsage`/`readUsageRecords`/`formatUsageSummary`/`formatUsageByTool`, `fullError` transport) and
`globMatch`/`fillModelCaps`/`mapThinkingCompat` from `lib/model-caps.ts` (all
re-exported from the entry files — tests/scripts import from
`extensions/9router.ts` / `extensions/9router-tools.ts` and stay stable across
internal refactors).

**Usage log.** Every tool call appends one JSON line to `9router-usage.jsonl`
(`logUsage`, never throws; gate rejections log too); the file is bounded
(an append past 256KB rewrites just the last 1000 lines).
`formatUsageSummary` feeds the Status summary line and
`formatUsageByTool` renders the per-tool breakdown (count, ok-rate, avg
latency, most recently used tool first) shown under both Status surfaces;
corrupt lines are skipped on read.

```bash
# typecheck (strict, no emit)
bun run typecheck

# offline unit tests
bun test

# optional bundle smoke check
bun build extensions/9router.ts extensions/9router-tools.ts \
  --target=node --external '*' --outdir "$LOCALAPPDATA/Temp/nrbuild"

# live E2E (9Router must be running); video creation is opt-in: NR_E2E_VIDEO=1
bun run e2e
```

CI (`.github/workflows/ci.yml`) runs install + typecheck + unit tests on every
push/PR; the live E2E stays local by design.

**Release pipeline.** Publishing is automatic via npm OIDC trusted publishing
— no tokens, no OTP. Bump `package.json`, update `CHANGELOG.md`, commit, push,
then cut a GitHub Release tagged `vX.Y.Z` matching the version:
`.github/workflows/publish.yml` re-runs typecheck + tests, verifies the tag,
and `npm publish --access public` (provenance automatic). One-time maintainer
setup in the browser: npmjs.com → package Settings → Trusted Publisher →
GitHub Actions (`QMahyar` / `pi-9router` / `publish.yml`, allow publish).

**Local install (this machine):** the package loads from
`~/.pi/agent/npm/node_modules/@qmahyar/pi-9router` (installed via
`pi install npm:@qmahyar/pi-9router`). To test local changes, copy the tree
with the dev script (bundle-checks first, copies every entry + lib file), then
`/reload` in pi:

```bash
bun run dev-install
```

`pi update` restores the published npm version. Do not mix in loose-file
copies — two registration paths for the same commands conflict.

Publishing is tag-driven (see Release pipeline above) — never manual `npm publish`.
