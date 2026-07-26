<p align="center">
  <a href="https://9router.com"><strong>9Router</strong></a>
  &nbsp;×&nbsp;
  <a href="https://pi.dev"><strong>pi</strong></a>
</p>

<h1 align="center">@qmahyar/pi-9router</h1>

<p align="center">
  <strong>One gateway. Many providers. Full tool suite for pi.</strong><br />
  Sync chat models from <a href="https://9router.com">9Router</a> into pi, then turn on image, speech, search, and fetch tools when you need them.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@qmahyar/pi-9router"><img alt="npm" src="https://img.shields.io/npm/v/@qmahyar/pi-9router?style=flat-square" /></a>
  <a href="https://pi.dev/packages"><img alt="pi-package" src="https://img.shields.io/badge/pi.dev-package-111?style=flat-square" /></a>
  <a href="https://github.com/QMahyar/pi-9router/blob/master/LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" /></a>
</p>

---

## Install

```bash
pi install npm:@qmahyar/pi-9router
```

Or from git:

```bash
pi install git:github.com/QMahyar/pi-9router
```

Requires a running [9Router](https://9router.com) instance (`npm i -g 9router` → default `http://localhost:20128`).

## What you get

| Command | Role |
|---------|------|
| **`/9router`** | Connect · full/quick sync · diagnose · register **chat** models as provider `9router` |
| **`/9router-tools`** | Enable tools · set default models · output folder |

| Tool | On by default | Does |
|------|---------------|------|
| `nr_image_generate` | Yes | Text → image file |
| `nr_tts` | Yes | Text → speech file |
| `nr_web_search` | Yes | Live web search |
| `nr_web_fetch` | Yes | URL → markdown |
| `nr_embed` | No | Text → embeddings |

**Off tools leave the model context.** Only enabled tools expose schema + usage guidelines to the agent.

## Model names

Sync uses **smart enrich**: when a list row already has name + capabilities (common
for chat), it skips `/v1/models/info`. Thin rows still get a lookup so display names
are real — `openrouter/openai/tts-1-hd` shows as **TTS-1 HD**, not *"Openai/Tts 1 Hd"*.

- **Full sync** — all tool catalogs + voice TTS probes  
- **Quick sync** — chat only (keeps previous image/tts/web catalog)  
- **Diagnose** — health, per-kind latency, sample info, voice probes  

Each tool description lists available ids (and params when known). A `model`
argument is resolved locally first — `nano-banana` maps to a real id or fails with
candidates listed, instead of `No credentials for provider: nano`.

**edge-tts** / **google-tts** are free and absent from `/v1/models/tts`. Full sync
probes them and only adds live ones.

## 60-second start

```text
1. 9router                          # start the gateway
2. /9router  →  Sync models (full catalog)
3. /model    →  provider 9router
4. /9router-tools  →  pick defaults
```

Optional: **Quick sync** when you only need chat models refreshed; **Diagnose**
when something is slow or voice TTS is missing.

## Pair with Exa (optional)

For dedicated **Exa** neural search with multi-key rotation (separate from 9Router’s web tools):

```bash
pi install npm:@qmahyar/pi-exa-search
```

→ [**@qmahyar/pi-exa-search**](https://github.com/QMahyar/pi-exa-search) · [npm](https://www.npmjs.com/package/@qmahyar/pi-exa-search)

Use **one** search stack at a time if you want to avoid overlapping tools.

## Docs

| Doc | |
|-----|--|
| [Setup](docs/setup.md) | Install, first run, env vars |
| [Usage](docs/usage.md) | Menus, tools, on/off behavior |
| [Dev](docs/dev.md) | Layout for contributors |

## Links

- [9Router](https://9router.com) · [9Router on GitHub](https://github.com/decolua/9router)
- [pi.dev](https://pi.dev) · [Package gallery](https://pi.dev/packages)
- [This package on npm](https://www.npmjs.com/package/@qmahyar/pi-9router)

## License

MIT
