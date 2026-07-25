# pi-9router

[Pi](https://pi.dev) extensions for **[9Router](https://github.com/decolua/9router)**:

| Extension | Command | Role |
|-----------|---------|------|
| **`9router`** | `/9router` | Endpoint, API key, fetch catalogs, **register chat models** in pi |
| **`9router-tools`** | `/9router-tools` | Toggle & configure **capability tools** (image, TTS, STT, embeddings, web) |

Both share `~/.pi/agent/9router.json`. Tools depend on a catalog sync from the core extension.

## Install

```bash
pi install git:github.com/QMahyar/pi-9router
```

Or copy for local dev:

```bash
cp extensions/*.ts ~/.pi/agent/extensions/
```

Requires [9Router](https://www.npmjs.com/package/9router) running (default `http://localhost:20128`).

## Quick start

1. Start 9Router: `9router`
2. In pi: **`/9router`** → set endpoint/key if needed → **Fetch all & register chat models**
3. **`/model`** → provider **9router** for chat
4. **`/9router-tools`** → enable capabilities and pick default models
5. Ask the agent to search, generate an image, etc.

## Capability tools

| Tool | Capability | 9Router API | Default |
|------|------------|-------------|---------|
| `nr_image_generate` | Text → Image | `POST /v1/images/generations` | ON |
| `nr_tts` | Text → Speech | `POST /v1/audio/speech` | ON |
| `nr_stt` | Speech → Text | `POST /v1/audio/transcriptions` | ON |
| `nr_embed` | Embeddings | `POST /v1/embeddings` | OFF |
| `nr_web_search` | Web Search | `POST /v1/search` | ON |
| `nr_web_fetch` | Web Fetch | `POST /v1/web/fetch` | ON |

Each can be **enabled/disabled** and given a **default model** from the synced catalog via `/9router-tools`.

Generated files (images, audio) go to `~/.pi/agent/9router-output/` (configurable).

> **Video:** listed in some 9Router UIs but not exposed as a public `/v1/models/video` catalog yet — reserved for a later version.

## Config

`~/.pi/agent/9router.json` (written by both extensions):

```json
{
  "endpoint": "http://localhost:20128",
  "apiKey": "sk-…",
  "lastSync": "…",
  "chatModels": [ ],
  "catalog": [ ],
  "counts": { "chat": 95, "image": 6, "tts": 8, "stt": 4, "embedding": 13, "web": 2 },
  "capabilities": {
    "image": { "enabled": true, "model": "gemini/gemini-3-pro-image-preview" },
    "web_search": { "enabled": true, "model": "exa/search" }
  },
  "outputDir": "C:/Users/you/.pi/agent/9router-output"
}
```

Env fallbacks: `NINEROUTER_URL`, `NINEROUTER_KEY`.

## Docs

- [docs/setup.md](docs/setup.md)
- [docs/usage.md](docs/usage.md)
- [docs/dev.md](docs/dev.md)

## License

MIT
