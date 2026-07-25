# pi-9router

[Pi](https://pi.dev) extension that connects to a local/remote **[9Router](https://github.com/decolua/9router)** gateway, fetches model catalogs (chat, image, TTS, STT, …), and **registers chat models** in pi with context window, vision, and reasoning metadata.

## Install

```bash
pi install git:github.com/QMahyar/pi-9router
```

Or copy for local dev:

```bash
cp extensions/9router.ts ~/.pi/agent/extensions/
```

Requires [9Router](https://www.npmjs.com/package/9router) running (default `http://localhost:20128`).

## Quick start

1. Start 9Router: `9router` (dashboard at port 20128)
2. In pi, run **`/9router`**
3. **Set endpoint** if not `http://localhost:20128`
4. **Set API key** if 9Router has `requireApiKey` (Dashboard → Keys)  
   Or export `NINEROUTER_KEY` / `NINEROUTER_URL`
5. **Fetch all & register chat models**
6. Open **`/model`** → provider **9router**

## What it does

| Action | Result |
|--------|--------|
| Fetch catalogs | `GET /v1/models`, `/v1/models/image`, `/tts`, `/stt`, `/embedding`, `/web`, `/image-to-text` |
| Read metadata | Uses each chat model’s `capabilities` (contextWindow, maxOutput, vision, reasoning, thinkingFormat) |
| Register in pi | `pi.registerProvider("9router", { api: "openai-completions", baseUrl: "<endpoint>/v1", models: [...] })` |
| Browse | TUI browser for all kinds (image/TTS/STT are cataloged; only **chat** is registered for `/model`) |

Non-chat models stay in the local catalog for inspection. Pi’s model picker is for LLM chat; image/TTS/STT are different APIs.

## Config

`~/.pi/agent/9router.json`

```json
{
  "endpoint": "http://localhost:20128",
  "apiKey": "sk-…",
  "lastSync": "2026-07-25T12:00:00.000Z",
  "chatModels": [ ],
  "catalog": [ ],
  "counts": { "chat": 95, "image": 4, "tts": 8, "stt": 4 }
}
```

Environment fallbacks: `NINEROUTER_URL`, `NINEROUTER_KEY`.

## Docs

- [docs/setup.md](docs/setup.md)
- [docs/usage.md](docs/usage.md)
- [docs/dev.md](docs/dev.md)

## License

MIT
