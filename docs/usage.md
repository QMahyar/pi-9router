# Usage

## `/9router` — connection & chat

| Menu item | What it does |
|-----------|----------------|
| **Sync models** | Fetch catalogs from 9Router; register chat models as provider `9router` |
| **Connection** | Edit endpoint, API key, test health + `/v1/models`, clear key |
| **Browse catalog** | Page through chat / image / tts / embedding / web / … |
| **Status** | Endpoint, key mask, sync time, counts |
| **Unregister chat models** | Remove registered chat models from pi |
| **Close** | Exit menu |

### After sync

- Open **`/model`**  
- Select provider **9router**  
- Chat goes to `{endpoint}/v1/chat/completions` with the chosen model id (e.g. `kr/claude-sonnet-4.5`)

Re-run **Sync models** when you add/remove providers in the 9Router dashboard.

---

## `/9router-tools` — non-chat capabilities

| Menu item | What it does |
|-----------|----------------|
| **Capability rows** | Select → turn on/off, set default model, browse models |
| **Output folder** | Where images and TTS audio files are written |
| **Status** | Summary of tools and defaults |
| **Close** | Exit menu |

### Tools

| Tool | When the model should use it |
|------|------------------------------|
| `nr_image_generate` | User wants an image, icon, logo, illustration, mockup |
| `nr_tts` | User wants spoken audio / voiceover from text (saves a file) |
| `nr_embed` | Embeddings / vectors / RAG (off by default) |
| `nr_web_search` | Live web search |
| `nr_web_fetch` | Full content for a known URL |

### On vs off

| State | Model context |
|-------|----------------|
| **On** | Tool schema + short usage guidelines in the system prompt; tool is callable |
| **Off** | Tool not active; **no** guidelines or schema for that tool |

Defaults are set per capability under **Default model**. If unset, the first catalog entry for that kind is used.

---

## Typical workflow

```text
/9router          → Sync models
/model            → 9router / your-chat-model
/9router-tools    → turn on web search + image if needed
```

Ask the agent normally:

- “Search for the latest Exa API search parameters” → `nr_web_search`  
- “Generate a simple app icon…” → `nr_image_generate`  
- “Read this URL as markdown: https://…” → `nr_web_fetch`  

---

## What is not included

| Feature | Status |
|---------|--------|
| Speech-to-text / mic → editor | **Not in this package** — use Superwhisper, Spokenly, etc. |
| Video generation | Not exposed (no public `/v1/models/video` catalog) |

---

## Config reference

File: `~/.pi/agent/9router.json`

| Field | Owner | Meaning |
|-------|--------|---------|
| `endpoint` | `/9router` | 9Router base URL (no `/v1`) |
| `apiKey` | `/9router` | Bearer key (optional if auth off) |
| `catalog` | sync | Last full model list |
| `chatModels` | sync | Models registered with pi |
| `counts` | sync | Per-kind counts |
| `capabilities` | `/9router-tools` | `{ image, tts, embed, web_search, web_fetch }` → `enabled` + `model` |
| `outputDir` | `/9router-tools` | Generated files directory |
