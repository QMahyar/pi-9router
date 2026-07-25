# Usage

## `/9router` — core (chat models)

| Item | Description |
|------|-------------|
| **Status** | Endpoint, key, last sync, counts |
| **Set endpoint / API key** | Connection settings |
| **Test connection** | Health + chat list |
| **Fetch all & register chat models** | Pull all catalogs; register LLMs as provider `9router` |
| **Browse catalog** | All kinds including image/tts/stt/web |
| **Unregister** | Remove chat models from pi |

After sync, open **`/model`** → provider **9router**.

## `/9router-tools` — capabilities

| Item | Description |
|------|-------------|
| **☐/☑ each capability** | Enable or disable the matching tool |
| **Set default model** | Pick from catalog for that capability |
| **List models** | Show catalog entries |
| **Set output directory** | Where images/audio are saved |
| **Refresh tool activation** | Re-apply ON/OFF to pi’s active tool set |

### Tools exposed to the model

| Tool | When to use |
|------|-------------|
| `nr_image_generate` | Icons, illustrations, mockups, symbols |
| `nr_tts` | Narration / voice from text |
| `nr_stt` | Transcribe a local audio file path |
| `nr_embed` | Vectors for RAG (full vectors opt-in via `full: true`) |
| `nr_web_search` | Live web search |
| `nr_web_fetch` | URL → markdown/text |

Disabled tools are removed from the active tool list (`setActiveTools`) so the LLM will not call them.

### Typical flow

```
/9router            → Fetch all & register
/9router-tools      → Enable image + web_search, set defaults
Ask: "Generate a simple app icon…"
Ask: "Search for pi coding agent extensions"
```

## Re-sync

When 9Router providers change:

```
/9router → Fetch all & register chat models
```

`9router-tools` listens for `9router:synced` and refreshes activation. Defaults you already set are kept.
