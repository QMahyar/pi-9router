# Dev — @qmahyar/pi-9router

```text
extensions/
  9router.ts         # /9router — sync + chat provider + diagnose
  9router-tools.ts   # /9router-tools + nr_* tools
  lib/
    shared.ts        # HTTP, timeouts, config merge (not an entry point)
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

**STT** is not fetched (no STT tools in this package).

**Synthetic entries.** `edge-tts` / `google-tts` are added locally (`synthetic: true`)
after a `/v1/audio/speech` probe returns real audio.

**Tool descriptions** embed catalog ids (+ params when known); `registerAll()`
re-runs on `9router:synced`.

**Images.** `nr_image_generate` loops `n` times on the binary path, supports optional
`image_path` for edit/img2img, and returns a path by default (`attachImages` opts in).

**TTS.** Binary audio first; JSON `?response_format=json` only as fallback.

**`model` on the wire** is not always the catalog id: search/fetch take a bare
provider name (`exa`, not `exa/search`).

**Timeouts** (shared): health 8s · list 45s · info 12s · probe 20s · tools 120s.

**Stale catalog:** lastSync older than 24h shows a warning in status / session footer.

Exported for testing: `fetchAllAndBuild`, `diagnoseConnection`, `resolveModel`,
`describeModels`, `CAPS`, `generateImages`.

```bash
# typecheck / bundle
bun build extensions/9router.ts extensions/9router-tools.ts \
  --target=node --external '*' --outdir "$LOCALAPPDATA/Temp/nrbuild"

# live E2E (9Router must be running)
bun run scripts/e2e-test.ts
```

**Local install (this machine):** copy loose files — do not `pi install` alongside them:

```bash
mkdir -p "$USERPROFILE/.pi/agent/extensions/lib"
cp extensions/9router.ts extensions/9router-tools.ts "$USERPROFILE/.pi/agent/extensions/"
cp extensions/lib/shared.ts "$USERPROFILE/.pi/agent/extensions/lib/"
```

Then `/reload` in pi.

Publish: `npm publish --access public --otp=…` from package root.
