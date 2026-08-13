# Changelog

All notable work on **@qmahyar/pi-9router** is recorded here so agents and humans
can pick up across sessions without re-deriving git history.

Format is inspired by [Keep a Changelog](https://keepachangelog.com/).  
Versioning for this package is **patch-first** (`1.2.x`) — see `AGENTS.md`.

---

## How to use this file (agents)

| Section | What belongs here |
|---------|-------------------|
| **[Unreleased]** | Work in progress: uncommitted edits, open bugs, “do next”, session notes |
| **[X.Y.Z] — date** | What shipped in that `package.json` / npm version (after commit + publish) |

**Rules**

1. At the **start** of a session: read **[Unreleased]** and the latest version entry.
2. While working: append bullets under **[Unreleased]** (Added / Changed / Fixed / Notes).
3. Before **commit**: move finished bullets from Unreleased into a new version section (or keep under Unreleased until release if still mid-flight).
4. On **release** (`package.json` bump → commit → push → `npm publish`): create **`[X.Y.Z] — YYYY-MM-DD`**, clear finished Unreleased items, leave only truly open WIP.
5. Record **git SHAs** and **npm publish status** when known (this machine sometimes has commits on GitHub before npm OTP publish completes).

Do **not** put machine-only paths or secrets here — those stay in gitignored `AGENTS.md`.

---

## [Unreleased]

### Notes

- Nothing in flight — 1.2.5 shipped the model-metadata fix.

---

## [1.2.5] — 2026-08-13

### Fixed

- Chat model metadata (context window, max output, vision, reasoning, thinking format) was wrong for models whose `/v1/models` list row carries no `contextWindow`/`maxOutput` — live-resolver providers (kiro `kr/*`) and combos. They registered with the flat 128K/32K fallback, e.g. `kr/claude-sonnet-4` (200K) and `kr/qwen3-coder-next` (1M). Added a pattern-based fallback table mirroring 9Router's own resolver (`open-sse/providers/capabilities.js` → `getCapabilitiesForModel`, values merged over its 200K/64K floor) — `MODEL_PATTERN_CAPS` + `fillModelCaps` in `extensions/9router.ts`. Only **missing** fields are filled; explicit server caps always win. Applied to pi registration (`toPiModel`), the browse catalog, and `refreshModels`.
- Kiro reports `thinking` (not `reasoning`) in capabilities — `asCaps` in `extensions/lib/shared.ts` now maps `thinking` → `reasoning`, so `kr/*-thinking` variants register with reasoning on and plain variants keep the server's explicit `false`.

### Notes

- After update: `/reload` in pi, then re-sync via `/9router` → Sync (or `pi update --models`) so cached `~/.pi/agent/9router.json` picks up corrected metadata (already regenerated locally).
- e2e: 23/24 pass — the image failure is the known server-side `nanobanana-flash` "credits insufficient" 502, unrelated.
- Source of truth for the pattern table: `open-sse/providers/capabilities.js` in the 9router repo — re-check on server updates.

---

## [1.2.4] — 2026-08-12

**Git:** `b381da0` · **npm:** `1.2.4` published (`latest`; global npmrc token, no 2FA prompt).

### Fixed

- `filename` without an extension now gets the extension detected from the response content-type — `nr_image_generate` (`.png`/`.jpg`/`.webp`/…) and `nr_tts` (`.mp3`/`.wav`/…): `demo-bolt-icon` → `demo-bolt-icon.jpg`, `demo-tts-fa` → `demo-tts-fa.mp3`. Explicit extensions (`fix.png`, `voice.wav`) are left untouched; multi-image (`n>1`) still uses generated `img-…` names.

### Notes

- Local install is now the published npm package (`npm:@qmahyar/pi-9router` via `pi update`) — the loose-file copy steps in `AGENTS.md` are obsolete for this machine.
- Server-side at release time: `nb/nanobanana-flash` returned 502 “credits insufficient” during e2e (account/upstream, not the package); `/v1/models/web` still lists 0 web models, so `nr_web_search`/`nr_web_fetch` stay offline until the server has web providers + a full sync.

---

## [1.2.3] — 2026-08-12

**Git:** `ac8efed` · **npm:** `1.2.3` published (OTP via global npmrc token, no 2FA prompt).

### Added

- `refreshModels` hook on the `9router` chat provider — pi-side model refresh (e.g. `pi update --models`) re-fetches the live chat list and falls back to cached models on error; chat refresh no longer needs a manual /9router sync.
- `prepareArguments` on `nr_image_generate` (camelCase `imagePath` from resumed sessions folds into `image_path`); leading `@` stripped from `image_path` paths.
- Output truncation for `nr_web_search` / `nr_web_fetch` results (50KB / 2000 lines; full text saved to a temp file with a hint in the result).

### Changed

- Tool descriptions no longer embed the full model catalog — they name the configured default + count; unknown ids are still rejected at execution with the available list (browse via `/9router-tools`).
- Tool file I/O moved off sync `fs` (async `node:fs/promises`); `normalizeEndpoint` tolerates scheme-less endpoints (`localhost:20128` → `http://…`).
- `peerDependencies` now lists `@earendil-works/pi-tui` and `typebox` (both imported at runtime) alongside `@earendil-works/pi-coding-agent`.

### Fixed

- Tool errors now **throw** from `execute()` — per pi docs a returned `isError: true` never sets the error flag, so failures were not being marked as errors in the session/UI.

### Planned / ideas

- (none locked in)

---

## [1.2.2] — 2026-07-26

**Git:** `92fda79` · **npm:** patch after `1.2.1`

### Added

- Footer on/off toggle in `/9router` TUI (`showFooter` in `~/.pi/agent/9router.json`, default on).
- Single compact status-bar chip: `9router(95 Models · 3/5 Tools)` (+ `· stale` when last sync >24h).
- Shared footer helpers in `extensions/lib/shared.ts` (`formatFooterText`, `paintFooterStatus`, `isFooterEnabled`, `setFooterEnabled`).

### Changed

- Removed dual footer chips (`tools N/M · stale` + long `9router · N models · stale — re-sync`).
- Legacy status id `9router-tools` is cleared on paint so older sessions drop the second chip.
- Docs: `docs/usage.md` documents footer toggle and chip format.

---

## [1.2.1] — 2026-07-26

**Git:** `33f7249`

### Added

- `extensions/lib/shared.ts` — shared HTTP, timeouts, config merge, concurrency.
- Full vs **quick** sync (chat-only; preserves previous non-chat catalog).
- **Diagnose** in `/9router` (health, list latency, sample `/models/info`, voice probes).
- Smart `/v1/models/info` enrich (skip rows that already have rich list capabilities).
- Request timeouts (health / list / info / probe / tools).
- Image tool: honor `n` (1–4) on binary path; optional `image_path` for edit/img2img.
- TTS: binary audio first, JSON fallback.
- Catalog dedupe by `(kind, id)`; slim persisted capabilities.
- Stale-catalog warning (>24h) in status/UI.
- `scripts/e2e-test.ts` for live 9Router checks (not shipped in npm tarball).

### Changed

- STT no longer fetched (no STT tools).
- `package.json` `pi.extensions` lists explicit entry files.
- Docs: setup / usage / dev / README for sync modes and diagnose.

### Fixed

- Image `n` forced to `1` on the happy-path binary request.
- Dead auth-header branch (always send Bearer).
- Config merge preserved across both extensions more consistently.

---

## [1.2.0] — 2026-07-25

**Git:** includes `9879b7b`, `46ae50b`, `cc89691` (and related polish)

### Added

- Real model names via `/v1/models/info` enrichment.
- Catalog-aware `resolveModel` / tool descriptions with available ids.
- Voice TTS discovery (edge-tts / google-tts probes).
- Image path-only results by default (`attachImages` opt-in) to avoid context blowups.

### Fixed

- Web search/fetch: send bare **provider** name on the wire (`exa`), not catalog id (`exa/search`).
- Generated images returned as file path instead of embedding base64 by default.

---

## [1.1.0] — earlier

### Added

- `9router-tools`: image, TTS, embed, web search/fetch; capability toggles.
- Package polish, branding, scoped npm name `@qmahyar/pi-9router`.

### Removed

- STT / voice-input tooling from the package surface (OS dictation preferred).

---

## [1.0.0] — earlier

### Added

- Initial `/9router` extension: sync 9Router chat models into pi as provider `9router`.

---

## Commit map (recent)

| SHA | Summary |
|-----|---------|
| `92fda79` | Release 1.2.2: cleaner footer chip and on/off toggle |
| `33f7249` | Release 1.2.1: smarter sync, image n fix, diagnose, shared HTTP |
| `cc89691` | Return the image path instead of embedding the image |
| `46ae50b` | Send the provider name, not the catalog id, to search and fetch |
| `3bf30e9` | Ignore AGENTS.md |
| `9879b7b` | Fetch real model names and resolve model ids against the catalog |
| `d8c53dd` | Release polish: clean agent tools, branding, scoped npm package |
| `4540ddd` | Remove STT and voice input; document package cleanly |
| `405107f` | Add 9router-tools |
| `e28c005` | Add pi-9router extension |
