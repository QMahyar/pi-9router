# Usage — @qmahyar/pi-9router

## Commands

### `/9router`

| Item | Action |
|------|--------|
| Sync models (full catalog) | All kinds + smart metadata + voice TTS probes; register chat |
| Quick sync (chat only) | Fast chat refresh; keeps previous tool catalog |
| Connection | Endpoint, API key, test, clear key |
| Diagnose | Health, per-kind list latency, sample `/models/info`, voice probes |
| Browse catalog | chat / image / tts / embedding / web / … |
| Footer on/off | Toggle the status-bar chip (`showFooter` in `9router.json`) |
| Status | Summary (flags stale sync >24h) |
| Unregister chat models | Drop provider models |

**Footer chip** (when on): `9router(95 Models · 3/5 Tools)` — adds `· stale` if last sync is >24h.

Sync reports names from server vs derived, info fetched vs skipped (already rich),
and total timing.

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

## Image options

| Param | Notes |
|-------|--------|
| `n` | 1–4; each image is requested (binary path loops) |
| `size` / `quality` | When the model supports them (see params in description) |
| `image_path` | Local path or data URL for edit/img2img (single reference) |
| `image_paths` | Up to 4 references for multi-image edit (sends `images[]`) |
| `filename` | Output name only (single image) |

## Video (Grok Imagine)

`nr_video_generate` creates a job via `/v1/videos/generations`, polls until
done, and saves the MP4 next to the other media output. There is no video
model list endpoint — the default is the documented `xai/grok-imagine-video`
and `model` overrides pass through verbatim. Requires an xAI account with
video access (SuperGrok / X Premium+ or an xAI API key); a 403 means the
connected account lacks it. Each generation is billed — the tool is described
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
