# pi-9router

[Pi](https://pi.dev) extensions for **[9Router](https://github.com/decolua/9router)**.

| Command | Role |
|---------|------|
| **`/9router`** | Endpoint, API key, **sync catalogs**, register **chat** models |
| **`/9router-tools`** | Enable tools, default models, output folder, **voice input** |

| Shortcut | Role |
|----------|------|
| **`Ctrl+Shift+V`** | Mic → STT → editor text (only when **Speech to text** is On) |

## Install

```bash
pi install git:github.com/QMahyar/pi-9router
```

This package depends on **`ffmpeg-static`** for voice recording when system ffmpeg is missing.  
`postinstall` checks for ffmpeg (PATH or bundled) and prints setup hints if neither is found.

You already have system ffmpeg? That is preferred automatically.

## Quick start

1. Run 9Router (`9router` → port **20128**)
2. **`/9router`** → **Sync models**
3. **`/model`** → provider **9router**
4. **`/9router-tools`** → turn capabilities on/off, set defaults
5. Optional: **Voice input** row → duration / mic / test via **Ctrl+Shift+V**

## Tools (model-facing)

Only **On** tools appear in the model context (schema + guidelines). **Off** tools are removed from the active tool list.

| Tool | Default | API |
|------|---------|-----|
| `nr_image_generate` | On | `/v1/images/generations` |
| `nr_tts` | On | `/v1/audio/speech` |
| `nr_stt` | On | `/v1/audio/transcriptions` (file path) |
| `nr_embed` | Off | `/v1/embeddings` |
| `nr_web_search` | On | `/v1/search` |
| `nr_web_fetch` | On | `/v1/web/fetch` |

Live mic is **not** an LLM tool — it is **Ctrl+Shift+V** → editor.

## Config

`~/.pi/agent/9router.json` — shared by both extensions.

Outputs default to `~/.pi/agent/9router-output/`.

Env: `NINEROUTER_URL`, `NINEROUTER_KEY`, optional `FFMPEG_PATH`.

## Docs

- [docs/setup.md](docs/setup.md)
- [docs/usage.md](docs/usage.md)
- [docs/dev.md](docs/dev.md)

## License

MIT
