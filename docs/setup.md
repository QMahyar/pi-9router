# Setup

## Prerequisites

1. **9Router** running:

```bash
npm install -g 9router
9router
curl http://localhost:20128/api/health
```

2. **Pi package**:

```bash
pi install git:github.com/QMahyar/pi-9router
```

Both extensions load from the package (`extensions/9router.ts` + `extensions/9router-tools.ts`).

## First-time

1. `/9router` → endpoint (default `http://localhost:20128`) → API key if required  
2. **Fetch all & register chat models**  
3. `/9router-tools` → toggle capabilities / pick default models  
4. `/model` → provider **9router** for chat  

## Environment

| Variable | Purpose |
|----------|---------|
| `NINEROUTER_URL` | Default endpoint |
| `NINEROUTER_KEY` | API key fallback |

## Avoid double-loading

Use **either** `pi install git:…` **or** copies under `~/.pi/agent/extensions/`, not both.
