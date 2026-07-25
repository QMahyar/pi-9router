# Setup — @qmahyar/pi-9router

## 1. 9Router

```bash
npm install -g 9router
9router
curl http://localhost:20128/api/health
```

Create a key in the 9Router dashboard if auth is enabled.

## 2. This package

```bash
pi install npm:@qmahyar/pi-9router
```

Alternatives:

```bash
pi install git:github.com/QMahyar/pi-9router
```

## 3. First run in pi

1. **`/9router`** → **Connection** (endpoint / key) → **Sync models**  
2. **`/model`** → provider **9router**  
3. **`/9router-tools`** → enable tools and set defaults  

## Env (optional)

| Variable | Meaning |
|----------|---------|
| `NINEROUTER_URL` | Default base URL |
| `NINEROUTER_KEY` | API key fallback |

Config file: `~/.pi/agent/9router.json`

## Related

- [pi-exa-search](https://github.com/QMahyar/pi-exa-search) — Exa-only search/fetch  
- [9Router](https://9router.com) · [pi.dev/packages](https://pi.dev/packages)
