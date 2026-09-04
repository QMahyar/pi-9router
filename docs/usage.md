# Usage — @qmahyar/pi-9router

## Commands

### `/9router`

| Item | Action |
|------|--------|
| Sync models (full catalog) | All kinds + smart metadata + voice TTS probes; register chat |
| Quick sync (chat only) | Fast chat refresh; keeps previous tool catalog (non-chat entries unseen twice are flagged `stale` — run a full sync to confirm) |
| Connection | Endpoint, API key, test, clear key |
| Diagnose | Health, per-kind list latency, sample `/models/info`, voice probes |
| Browse catalog | chat / image / tts / embedding / web / … |
| Footer on/off | Toggle the status-bar chip (`showFooter` in `9router.json`) |
| Status | Summary (flags stale sync >24h) + `Triage:` line (mode, per-kind counts, fresh/stale, missing-info count) |
| Unregister chat models | Drop provider models |

**Footer chip** (when on): `9router(95 Models · 3/5 Tools)` — adds `· stale` if last sync is >24h.

Sync reports names from server vs derived, info fetched vs skipped (already rich)
vs 7-day cache hits, pattern-fallback fills, and total timing. Long syncs
stream progress (`Fetching metadata…`, `Metadata n/N…`) so the run stays alive.

### Catalog enrichment: rich rows, live info, pattern fallback

Sync builds the catalog in three stages — the browse detail view shows each
entry's provenance as a `caps source:` badge:

- **Rich list row** (`listRowIsRich`): a `/v1/models/<kind>` list row already
  carries enough metadata to skip `/v1/models/info` — numeric
  `contextWindow`/`maxOutput`, a non-empty capabilities array, or capability
  flags (vision/reasoning/imageOutput/tools) plus a name or kind. Rich rows
  keep their live server caps with no extra fetch.
- **Live info**: thin rows (`{ id, owned_by }` only, typical for image/web
  lists) are enriched via `/v1/models/info`. Badge: `caps source: live
  server info`.
- **Pattern fallback**: when the list row *and* the info record both leave
  caps gaps, the local `MODEL_PATTERN_CAPS` table fills the missing fields
  (server caps always win — only absent fields are filled). Badge: `caps
  source: pattern fallback (local estimate — live list/info had gaps)`.

The sync report's `Pattern fallback: N of M rows` line counts these fills.
A rising count across syncs signals table drift — server lists going thin or
new models missing from the table. `NR_DEBUG=sync` logs the per-sync hit
count (`pattern fallback hits=N (list+enrich)`) for the same signal.

### Info cache (persistent, TTL, merge-safe)

`/v1/models/info` results persist in `9router.json` so re-syncs stay fast:

- **Positive cache** (`infoCache`, `kind\0id` → `{ fetchedAt, info }`):
  a fetched record is reused for **7 days** without HTTP; expired ids are
  re-probed. Keys are kind-qualified so a chat-cached name is never reused
  for another kind's twin.
- **Negative cache** (`infoMissing`, bare-id → timestamp): ids the server has
  no info record for are skipped for **24 hours**, then re-probed.
- Both maps union-merge key-wise on every config write, so the two
  extensions never wipe each other's fresh entries; expired entries are
  pruned on write to keep the blob bounded.

The sync report's `Info probed (hits · misses) / cache hits (7d) /
negative-skips / rich-skips` line shows which path each row took:
probed info HTTP calls (split into positive hits vs misses), 7-day
positive-cache reuse, 24-hour negative-cache skips, and rows skipped as
already rich — each label shows its own counter.

### Freshness: stale flags, refresh names, triage, debug

- **Quick-sync staleness:** a fast chat-only refresh can't confirm tool
  catalogs, so a non-chat entry carried over unseen for 2 consecutive syncs
  is flagged `stale` (still usable — a full sync clears or prunes it).
- **Refresh keeps friendly names:** `pi update --models` reuses the
  last-known server names persisted by full sync, so thin rows keep their
  display names without an info fetch; a failed/empty refresh never wipes
  the provider — it keeps the last-good list.
- **Triage line:** Status and diagnose both print
  `Triage: last sync <ts> (<mode>) · chat:N … · fresh|stale · missing-info: M`.
- **Debug:** `NR_DEBUG=sync,timing` logs enrich classification, pattern hits,
  and per-call latencies (off by default).

### `/9router-tools`

| Item | Action |
|------|--------|
| Capability rows | On/off · default model · browse (shows params when known) |
| Inline generated images | Embed base64 in the tool result (off by default) |
| Output folder | Where images and TTS files are saved |
| Status | Summary |

### Inline generated images

Off by default: `nr_image_generate` writes the file and returns its **path**.

A generated image is often 1–2 MB (~675k tokens if base64-embedded) and is resent
every later turn. Leave off unless you have a large-context vision model.

## Tools (agent-facing)

| Tool | Label | Purpose |
|------|-------|---------|
| `nr_image_generate` | Image | Generate (or edit via `image_path`/`image_paths`) and save |
| `nr_tts` | Speech | Text → audio file |
| `nr_video_generate` | Video | Text/image → MP4 via Grok Imagine (async, polls up to 10 min) |
| `nr_web_search` | Search | Live web search |
| `nr_web_fetch` | Fetch | URL → markdown |
| `nr_embed` | Embed | Vectors (off by default) |
| `nr_stt` | Transcribe | Audio file → transcript (off by default) |

**On** → schema + short guidelines in the system prompt.  
**Off** → removed from active tools; no mention in agent context.

## Choosing a model

Every tool takes an optional `model`. Omit it to use the default set in
`/9router-tools`. When passed, it is resolved against the synced catalog:

| Input | Result |
|-------|--------|
| `nb/nanobanana-flash` | exact id |
| `NB/NanoBanana-Flash` | case-insensitive |
| `nanobanana-pro`, `NanoBanana Pro` | matched on id leaf or server name |
| `nano-banana` | ambiguous → error listing all matching ids |
| `dall-e-3` | unknown → error listing the available ids |
| `edge-tts/pt-BR-FranciscaNeural` | accepted unlisted (voice providers take any voice id) |

When `model` is omitted and no default is set, the tool auto-picks the
first **rich** row (live server caps via `listRowIsRich`) over a thin
`{ id, owned_by }`-style entry, and says so in the result
(`auto default <id> (rich caps)`), the tool description, and the status
rows (`(auto)`). Falls back to the first entry when nothing is rich. Set
an explicit default in `/9router-tools` to pin behavior.

## Image options

| Param | Notes |
|-------|--------|
| `n` | 1–4; each image is requested (binary path loops) |
| `size` / `quality` | When the model supports them (see params in description) |
| `image_path` | Local path or data URL for edit/img2img (single reference) |
| `image_paths` | Up to 4 references for multi-image edit (sends `images[]`) |
| `filename` | Output name only (single image) |
| `prompts` | Batch presets: up to 4 prompts, one image per preset (`n` is ignored) |

## Video (Grok Imagine)

`nr_video_generate` creates a job via `/v1/videos/generations`, polls until
done, and saves the MP4 next to the other media output. There is no video
model list endpoint — the default is the documented `xai/grok-imagine-video`
and `model` overrides are resolved against synced video entries (falling back
to the documented default when none are synced). A `provider/model` id that
is not in the catalog passes through verbatim (billed if valid — the server
validates); bare unknown names are rejected with the available list.
Requires an xAI account with
video access (SuperGrok / X Premium+ or an xAI API key); a 403 means the
connected account lacks it, reported with the full server detail. Like image
generation, 401/402/403 abort immediately in both the create call and the
status polls — transient poll failures are retried until the deadline.
Timeouts: 10-minute overall deadline, 3s abort-aware poll interval, 60s MP4
download. Polls toast only when status/progress advances
(`Video <status> · <progress>% · <elapsed>s (poll N)` — a full-length job
polls ~200 times, so repeats stay silent); aborting cancels
between polls. Each generation is billed — the tool is described
to the agent as deliberate-use only.

| Param | Notes |
|-------|--------|
| `prompt` | Subject, motion, style, scene |
| `duration` / `aspect_ratio` / `resolution` | When supported (e.g. 6, `16:9`, `720p`) |
| `image_path` | Reference image for image-to-video |
| `filename` | Output name only (`.mp4` appended) |

## Transcription (STT)

`nr_stt` (off by default) uploads a local audio file — mp3, wav, m4a, webm,
ogg, or flac up to 25 MB — to `/v1/audio/transcriptions` and returns the
transcript. `response_format` `srt`/`vtt` produce timestamped subtitles.
Models come from `/v1/models/stt` (whisper, groq, gemini, deepgram, …) —
connect a provider in the 9Router dashboard, then re-sync.

## Free TTS

`edge-tts/<voice>` and `google-tts/<lang>` need no API key. Full sync probes them
and adds a verified sample set when they work:

```text
edge-tts/en-US-AriaNeural      edge-tts/fa-IR-DilaraNeural
google-tts/en                  google-tts/vi
```

## Browse filters

`/9router` → Browse catalog filters each kind by caps provenance —
**All / Rich** (live server caps) **/ Thin** (pattern fallback) **/ Missing**
(no caps) — with per-filter counts, 30 rows per page, and the same
`caps source:` badge (live vs pattern) on each detail view.

## Usage log (cost/latency)

Every tool call appends one JSON line to `9router-usage.jsonl` next to
`9router.json` (never in the repo):
`{ ts, tool, model, ms, ok, status?, bytes?, count?, note? }`. Gate rejections
(cap off, no catalog, unknown model) log a failing line too. Logging never
throws —
a failed append can't break a tool call. The file is bounded: an append past
256KB rewrites just the last 1000 lines, so Status reads stay cheap.
`/9router` → Status surfaces a
one-line summary (calls, ok %, average latency, last tool/model/latency);
corrupt lines are skipped on read.
