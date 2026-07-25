# Setup

## Prerequisites

1. **Node.js** 18+  
2. **9Router** running  
3. **Pi** coding agent  

## Install 9Router

```bash
npm install -g 9router
9router
```

Dashboard / API: `http://localhost:20128`  
Health check:

```bash
curl http://localhost:20128/api/health
# {"ok":true}
```

If 9Router requires API keys, create one in the dashboard (**Keys**).

## Install this package

```bash
pi install git:github.com/QMahyar/pi-9router
```

Or for local development:

```bash
git clone https://github.com/QMahyar/pi-9router.git
cp pi-9router/extensions/*.ts ~/.pi/agent/extensions/
```

Do **not** install both the git package and a manual copy, or tools will double-register.

## First run

1. Start 9Router  
2. Open pi  
3. **`/9router`**
   - **Connection** — set endpoint (default `http://localhost:20128`) and API key if needed  
   - **Test connection**  
   - **Sync models**  
4. **`/model`** — pick provider **9router** and a chat model  
5. **`/9router-tools`** — enable the tools you want and set default models  

## Environment variables (optional)

| Variable | Meaning |
|----------|---------|
| `NINEROUTER_URL` | Default base URL if not set in config |
| `NINEROUTER_KEY` | API key fallback |

## Config file

All settings live in:

```text
~/.pi/agent/9router.json
```

Created on first save from `/9router` or `/9router-tools`.

## Voice / dictation

This package does **not** capture the microphone.  
Use Superwhisper, Spokenly, Windows/macOS dictation, or similar, and type or paste into pi’s editor as usual.
