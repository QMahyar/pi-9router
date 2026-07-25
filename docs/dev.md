# Developer guide

## Layout

```
pi-9router/
├── extensions/
│   ├── 9router.ts         # connection, catalog sync, chat provider
│   └── 9router-tools.ts   # capability tools + /9router-tools TUI
├── docs/
├── package.json
├── README.md
└── LICENSE
```

## Split of responsibility

```
9router.ts
  config core: endpoint, apiKey, catalog, chatModels
  registerProvider("9router", chat models)
  emit pi.events "9router:synced"
  saveConfig merges existing file (preserves capabilities/outputDir)

9router-tools.ts
  reads same ~/.pi/agent/9router.json
  registers nr_* tools
  capabilities[id].enabled + .model
  setActiveTools to toggle
  listens for 9router:synced
```

## Adding a capability

1. Add a `CapDef` in `CAPS` (id, tool name, catalog filter).
2. Implement `registerXTool(pi)`.
3. Call it from the default export.
4. Document in README / usage.

## Local test

```bash
cp extensions/*.ts ~/.pi/agent/extensions/
# in pi:
/reload
/9router
/9router-tools
```

## References

- 9Router skills: https://github.com/decolua/9router/tree/master/skills
- Pi tools / setActiveTools: coding-agent `docs/extensions.md`
