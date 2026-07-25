# Usage

## `/9router` menu

| Item | Description |
|------|-------------|
| **Status** | Endpoint, masked key, last sync, model counts |
| **Set endpoint** | Base URL without `/v1` |
| **Set / Clear API key** | Stored in `~/.pi/agent/9router.json` |
| **Test connection** | `GET /api/health` + `GET /v1/models` |
| **Fetch all & register chat models** | Pull all catalogs; register LLM models with pi |
| **Browse catalog** | Page through chat / image / tts / stt / … |
| **Unregister chat models** | `unregisterProvider("9router")` + clear cache |

## What gets registered

Only **chat** (LLM) models from `GET /v1/models` are added to pi’s model list.

For each model, pi receives:

| Field | Source |
|-------|--------|
| `id` | `data[].id` (e.g. `gc/gemini-2.5-pro`) |
| `name` | inferred / info endpoint |
| `contextWindow` | `capabilities.contextWindow` (default 128000) |
| `maxTokens` | `capabilities.maxOutput` |
| `reasoning` | `capabilities.reasoning` or id heuristics (`thinking`, …) |
| `input` | `["text","image"]` if `capabilities.vision` |
| `compat` | mapped from `thinkingFormat` for OpenAI-compat gateway |

Provider settings:

- **id:** `9router`
- **api:** `openai-completions`
- **baseUrl:** `{endpoint}/v1`
- **authHeader:** Bearer key

## Catalog kinds (browse-only except chat)

| Kind | 9Router path |
|------|----------------|
| chat | `/v1/models` |
| image | `/v1/models/image` |
| tts | `/v1/models/tts` |
| stt | `/v1/models/stt` |
| embedding | `/v1/models/embedding` |
| web | `/v1/models/web` |
| image-to-text | `/v1/models/image-to-text` |

## Re-sync after 9Router changes

When you enable/disable providers or combos in the 9Router dashboard:

```
/9router → Fetch all & register chat models
```

Cached models also load automatically on pi startup (no network). Re-fetch to refresh.

## Tips

- Combos (`owned_by: "combo"`) may lack full capabilities; the extension still registers them with safe defaults and may call `/v1/models/info` for sparse entries.
- Costs are set to `0` — 9Router billing is outside pi.
- After register, provider updates apply immediately (no `/reload` required for `registerProvider`).
