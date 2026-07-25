# Developer guide

## Layout

```
pi-9router/
├── extensions/9router.ts   # extension (command + provider registration)
├── docs/
├── package.json            # pi package manifest
├── README.md
└── LICENSE
```

## Architecture

```
/9router TUI
    │
    ├─ config  →  ~/.pi/agent/9router.json
    │
    ├─ fetch   →  9Router REST
    │               GET /api/health
    │               GET /v1/models
    │               GET /v1/models/{image,tts,stt,embedding,web,image-to-text}
    │               GET /v1/models/info?id=…   (sparse enrich)
    │
    └─ register → pi.registerProvider("9router", {
                     baseUrl: endpoint + "/v1",
                     api: "openai-completions",
                     models: [ …chat only… ]
                  })
```

Startup: if `chatModels` are cached in config, register them immediately (async factory not required for network).

## Local test

```bash
cp extensions/9router.ts ~/.pi/agent/extensions/9router.ts
# in pi:
/reload
/9router
```

Or:

```bash
pi -e ./extensions/9router.ts
```

## References

- 9Router skills: https://github.com/decolua/9router/tree/master/skills
- Pi custom providers: `@earendil-works/pi-coding-agent` → `docs/custom-provider.md`
- Pi models.json: `docs/models.md`
