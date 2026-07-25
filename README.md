# pi-9router

[Pi](https://pi.dev) extensions for **[9Router](https://github.com/decolua/9router)** — one local gateway, many providers.

| Command | Purpose |
|---------|---------|
| **`/9router`** | Connect to 9Router, sync model catalogs, register **chat** models in pi |
| **`/9router-tools`** | Turn non-chat tools on/off, pick default models, set output folder |

> **Speech-to-text / dictation is not part of this package.**  
> Use a dedicated app (e.g. [Superwhisper](https://superwhisper.com), Spokenly, or OS dictation) to put voice into the editor. That keeps pi’s shortcut keys free and avoids fragile mic capture in the terminal.

## Install

```bash
pi install git:github.com/QMahyar/pi-9router
```

Requires a running 9Router instance (default `http://localhost:20128`).

```bash
npm install -g 9router
9router
```

## Quick start

1. Start 9Router  
2. In pi: **`/9router`** → **Sync models**  
3. **`/model`** → provider **9router** (chat)  
4. **`/9router-tools`** → enable tools and set defaults  

## Architecture

```
┌─────────────┐   OpenAI-compatible HTTP    ┌──────────────┐
│     pi      │ ──────────────────────────► │   9Router    │
│             │   /v1/chat/completions      │  :20128      │
│  extensions │   /v1/images/generations    │              │
│             │   /v1/audio/speech          │  → providers │
│             │   /v1/embeddings            │              │
│             │   /v1/search  /v1/web/fetch │              │
└─────────────┘                             └──────────────┘
       │
       ▼
 ~/.pi/agent/9router.json
```

| Extension | File | Responsibility |
|-----------|------|----------------|
| Core | `extensions/9router.ts` | Endpoint, API key, catalog sync, `registerProvider("9router")` for chat |
| Tools | `extensions/9router-tools.ts` | LLM tools + `/9router-tools` settings UI |

Both share **`~/.pi/agent/9router.json`**.

## Chat models (`/9router`)

**Sync models** pulls:

| Kind | Endpoint |
|------|----------|
| chat | `GET /v1/models` |
| image | `GET /v1/models/image` |
| tts | `GET /v1/models/tts` |
| embedding | `GET /v1/models/embedding` |
| web | `GET /v1/models/web` |
| … | plus stt / image-to-text for browsing only |

Only **chat** models are registered with pi’s model picker (`provider: 9router`, `api: openai-completions`, `baseUrl: {endpoint}/v1`), using each model’s `capabilities` (context window, vision, reasoning, …).

Menu:

```
Sync models
Connection          # endpoint, API key, test
Browse catalog
Status
Unregister chat models
Close
```

## Tools (`/9router-tools`)

| Tool | Default | 9Router API | Use for |
|------|---------|-------------|---------|
| `nr_image_generate` | On | `POST /v1/images/generations` | Icons, illustrations, mockups |
| `nr_tts` | On | `POST /v1/audio/speech` | Narration → audio file |
| `nr_embed` | Off | `POST /v1/embeddings` | RAG / vectors |
| `nr_web_search` | On | `POST /v1/search` | Live web search |
| `nr_web_fetch` | On | `POST /v1/web/fetch` | URL → markdown |

### On vs off (model context)

When a tool is **On**:

- It is in pi’s active tool list  
- The model sees its **schema**, **promptSnippet**, and **promptGuidelines**

When **Off**:

- Removed via `setActiveTools`  
- **Nothing** about that tool is injected into the system prompt  

Settings list (columnar):

```
Image generation    On   model-id…          N models
Text to speech      On   …
Embeddings          Off  —
Web search          On   …
Web fetch           On   …
────────────────
Output folder
Status
Close
```

Generated files go to `~/.pi/agent/9router-output/` (configurable).

## Config

`~/.pi/agent/9router.json` (example):

```json
{
  "endpoint": "http://localhost:20128",
  "apiKey": "sk-…",
  "lastSync": "2026-07-25T12:00:00.000Z",
  "chatModels": [],
  "catalog": [],
  "counts": { "chat": 95, "image": 6, "tts": 8, "embedding": 13, "web": 2 },
  "capabilities": {
    "image": { "enabled": true, "model": "gemini/gemini-3-pro-image-preview" },
    "web_search": { "enabled": true, "model": "exa/search" }
  },
  "outputDir": "C:/Users/you/.pi/agent/9router-output"
}
```

Environment fallbacks: `NINEROUTER_URL`, `NINEROUTER_KEY`.

## Docs

| Doc | Contents |
|-----|----------|
| [docs/setup.md](docs/setup.md) | Install, first run |
| [docs/usage.md](docs/usage.md) | Menus, tools, on/off behavior |
| [docs/dev.md](docs/dev.md) | Extension layout for contributors |

## License

MIT
