# Usage — @qmahyar/pi-9router

## Commands

### `/9router`

| Item | Action |
|------|--------|
| Sync models | Fetch catalogs; register chat models as provider `9router` |
| Connection | Endpoint, API key, test, clear key |
| Browse catalog | chat / image / tts / embedding / web / … |
| Status | Summary |
| Unregister chat models | Drop provider models |

### `/9router-tools`

| Item | Action |
|------|--------|
| Capability rows | On/off · default model · browse |
| Output folder | Where images and TTS files are saved |
| Status | Summary |

## Tools (agent-facing)

| Tool | Label | Purpose |
|------|-------|---------|
| `nr_image_generate` | Image | Generate and save an image |
| `nr_tts` | Speech | Text → audio file |
| `nr_web_search` | Search | Live web search |
| `nr_web_fetch` | Fetch | URL → markdown |
| `nr_embed` | Embed | Vectors (off by default) |

**On** → schema + short guidelines in the system prompt.  
**Off** → removed from active tools; no mention in agent context.

## Related

[pi-exa-search](https://github.com/QMahyar/pi-exa-search) for Exa-native search if you prefer that over 9Router web tools.
