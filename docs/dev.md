# Dev — @qmahyar/pi-9router

```text
extensions/
  9router.ts         # /9router — sync + chat provider + diagnose
  9router-tools.ts   # /9router-tools + nr_* tools
  lib/
    shared.ts        # HTTP, timeouts, config merge, CAPS (not an entry point)
tests/               # offline unit tests (bun test)
scripts/
  e2e-test.ts        # live E2E against local 9Router
CHANGELOG.md         # cross-session WIP + release history (update every session)
```

**Handoff:** keep `[Unreleased]` in `CHANGELOG.md` current while you work; on release,
move bullets into a `[X.Y.Z]` section. Local machine install/publish steps live in
gitignored `AGENTS.md` when present.

- Core emits `9router:synced` after catalog refresh.
- Tools call `setActiveTools` so only enabled tools hit the model prompt.
- Shared config: `~/.pi/agent/9router.json`

**Catalog shape.** List endpoints may return only `{ id, object, owned_by }` or full
`capabilities` (chat often does). Sync uses smart enrich: rows that already look
rich skip `/v1/models/info`; thin rows (image, web, …) still get a lookup for
`name`, `detailKind`, `endpoint`, and `params`.

**Sync modes.** Full catalog (default) fetches chat/image/tts/embedding/web/
image-to-text, enriches, probes voice TTS. Quick sync fetches chat only and keeps
previous non-chat catalog entries so tools keep working.

**STT** is synced from `/v1/models/stt` (may be empty when no provider is
connected). `nr_stt` ships **off** by default — enable in `/9router-tools`.

**Video** has no `/v1/models` list endpoint; `nr_video_generate` defaults to
the documented `xai/grok-imagine-video` and passes `model` through verbatim.
Create → poll `GET /v1/videos/{request_id}` (echoing the create response's
`x-9router-connection-id` header) → download MP4. Creation is never retried
(billing); poll failures are tolerated until the 10-minute deadline.

**Synthetic entries.** `edge-tts` / `google-tts` are added locally (`synthetic: true`)
after a `/v1/audio/speech` probe returns real audio.

**Tool descriptions** stay compact (configured default model + count, not the
full catalog); `registerAllTools()` re-runs on `9router:synced` and after a
default-model change in `/9router-tools`. Tool failures
**throw** from `execute()` (a returned `isError: true` is ignored by pi — only
throwing sets the error flag). `nr_web_search`/`nr_web_fetch` results are
truncated to 50KB/2000 lines with the full text saved to a temp file. The chat
provider also exposes a live `refreshModels` hook (persists successful
refreshes; falls back to cached models on error), so pi-side refresh flows like
`pi update --models` re-fetch the chat list without a manual /9router sync.

**Images.** `nr_image_generate` loops `n` times on the binary path, supports optional
`image_path` for edit/img2img (20 MB cap), and returns a path by default
(`attachImages` opts in). 200-with-JSON responses are never saved as image
files, and 401/402/403 aborts the fallback chain instead of retrying paid
requests. Existing output files are never overwritten (numeric suffix on
collision).

**TTS.** Binary audio first; a JSON body on the binary path is parsed in place
(`{audio, format}`), with `?response_format=json` only as a re-request fallback.

**`model` on the wire** is not always the catalog id: search/fetch take a bare
provider name (`exa`, not `exa/search`).

**Timeouts** (shared): health 8s · list 45s · info 12s · probe 20s · tools 120s ·
video (async, polled) 10min.

**Stale catalog:** lastSync older than 24h shows a warning in status / session footer.

Exported for testing: `fetchAllAndBuild`, `diagnoseConnection`, `resolveModel`,
`describeModels`, `CAPS`, `generateImages`, plus pure helpers from
`lib/shared.ts` and `globMatch`/`fillModelCaps`/`mapThinkingCompat` from
`9router.ts`.

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

**Local install (this machine):** copy loose files — do not `pi install` alongside them:

```bash
mkdir -p "$USERPROFILE/.pi/agent/extensions/lib"
cp extensions/9router.ts extensions/9router-tools.ts "$USERPROFILE/.pi/agent/extensions/"
cp extensions/lib/shared.ts "$USERPROFILE/.pi/agent/extensions/lib/"
```

Then `/reload` in pi.

Publish: `npm publish --access public --otp=…` from package root.
