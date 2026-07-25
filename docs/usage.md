# Usage — @qmahyar/pi-9router

## Commands

### `/9router`

| Item | Action |
|------|--------|
| Sync models | Fetch catalogs; look up each model's real metadata; probe voice TTS; register chat models as provider `9router` |
| Connection | Endpoint, API key, test, clear key |
| Browse catalog | chat / image / tts / embedding / web / … |
| Status | Summary |
| Unregister chat models | Drop provider models |

Sync reports how many display names came from the server versus how many had to be
derived from the id. Ids with no `/v1/models/info` record keep a derived name, and
Browse marks them.

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

Nothing is sent upstream until a model resolves, so a wrong name fails fast and
locally with the real options rather than as a provider-routing error.

## Free TTS

`edge-tts/<voice>` and `google-tts/<lang>` need no API key. They have no entry in
`/v1/models/tts`, so sync probes them and adds a verified sample set when they work.
Any valid voice id is accepted, not only the listed ones:

```text
edge-tts/en-US-AriaNeural      edge-tts/fa-IR-DilaraNeural
google-tts/en                  google-tts/vi
```

`google-tts` takes plain 2-letter codes — region-qualified ones like `en-GB` fail upstream.

## Related

[pi-exa-search](https://github.com/QMahyar/pi-exa-search) for Exa-native search if you prefer that over 9Router web tools.
