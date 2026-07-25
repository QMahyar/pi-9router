# Setup

## Prerequisites

1. **9Router** installed and running:

```bash
npm install -g 9router
9router
```

Health check:

```bash
curl http://localhost:20128/api/health
# {"ok":true}
```

2. **Pi** with this extension:

```bash
pi install git:github.com/QMahyar/pi-9router
```

## First-time configure

In pi:

```
/9router
```

1. **Set endpoint** — default `http://localhost:20128` (no `/v1` suffix)
2. **Set API key** — only if 9Router requires keys (Dashboard → Keys)
3. **Test connection** — health + chat model list
4. **Fetch all & register chat models**

Then:

```
/model
```

Pick provider **9router** or search by model id (`kr/claude-sonnet-4.5`, …).

## Environment variables

| Variable | Purpose |
|----------|---------|
| `NINEROUTER_URL` | Default endpoint if config empty |
| `NINEROUTER_KEY` | API key fallback |

## Avoid double-loading

Use **either** the git package **or** a copy in `~/.pi/agent/extensions/9router.ts`, not both.
