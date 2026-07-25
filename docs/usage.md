# Usage

## `/9router` — connection & chat models

Clean main menu:

| Item | Action |
|------|--------|
| **Sync models** | Fetch all catalogs; register chat models as provider `9router` |
| **Connection** | Endpoint, API key, test, clear key |
| **Browse catalog** | chat / image / tts / stt / web / … |
| **Status** | Full summary |
| **Unregister chat models** | Drop provider models |

After sync: **`/model`** → **9router**.

## `/9router-tools` — capabilities

Main list is columnar (no emoji soup):

```
Image generation    On   gemini/…preview          6 models
Text to speech      On   openrouter/openai/…      8 models
Speech to text      On   groq/whisper-…           4 models
…
Output folder
Voice input
Status
Close
```

Select a row → **Turn on/off**, **Default model**, **Browse models**.

### Voice input (settings only — no extra slash command)

| Setting | Meaning |
|---------|---------|
| Shortcut | `Ctrl+Shift+V` (always registered; **no-ops if STT is Off**) |
| Duration | 3–60 seconds (default 8) |
| Editor | replace or append transcribed text |
| Microphone | Windows dshow device (auto-pick / list) |
| ffmpeg | PATH, `ffmpeg-static`, config path, or `FFMPEG_PATH` |

Flow: press shortcut → record → STT via 9Router → text in the editor.

## Model context (on vs off)

When a capability is **On**:

- Tool is in `setActiveTools`
- Model sees tool schema + `promptSnippet` + `promptGuidelines`

When **Off**:

- Tool removed from active set
- **No** snippet/guidelines for that tool in the system prompt

## Typical loop

```
/9router        → Sync models
/9router-tools  → defaults + voice mic
Ctrl+Shift+V    → speak a prompt into the editor
Enter           → send to the agent
```
