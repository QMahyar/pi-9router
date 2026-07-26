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
| Status | Summary (flags stale sync >24h) |
| Unregister chat models | Drop provider models |

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
| `nr_image_generate` | Image | Generate (or edit via `image_path`) and save |
| `nr_tts` | Speech | Text → audio file |
| `nr_web_search` | Search | Live web search |
| `nr_web_fetch` | Fetch | URL → markdown |
| `nr_embed` | Embed | Vectors (off by default) |

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
| `image_path` | Local path or data URL for edit/img2img |
| `filename` | Output name only (single image) |

## Free TTS

`edge-tts/<voice>` and `google-tts/<lang>` need no API key. Full sync probes them
and adds a verified sample set when they work:

```text
edge-tts/en-US-AriaNeural      edge-tts/fa-IR-DilaraNeural
google-tts/en                  google-tts/vi
```
