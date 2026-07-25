# Developer guide

## Layout

```text
pi-9router/
├── extensions/
│   ├── 9router.ts         # /9router — connection, sync, chat provider
│   └── 9router-tools.ts   # /9router-tools + nr_* tools
├── docs/
│   ├── setup.md
│   ├── usage.md
│   └── dev.md
├── package.json           # pi package manifest
├── README.md
└── LICENSE
```

## Responsibilities

| Module | Owns |
|--------|------|
| `9router.ts` | `endpoint`, `apiKey`, `catalog`, `chatModels`, `registerProvider("9router")`, event `9router:synced` |
| `9router-tools.ts` | `capabilities`, `outputDir`, `registerTool` / `setActiveTools`, settings UI |

`saveConfig` in the core extension **merges** into the existing JSON so tools keys are not wiped.

## Tool activation

```ts
pi.setActiveTools(names)
```

Pi rebuilds the system prompt from **active** tools only (`promptSnippet` + `promptGuidelines`).  
Disabled tools must not appear in that list.

## Events

After a successful sync:

```ts
pi.events.emit("9router:synced", { endpoint, counts, chatCount, at })
```

Tools listen and re-apply activation.

## Local test

```bash
cp extensions/*.ts ~/.pi/agent/extensions/
# in pi:
/reload
/9router
/9router-tools
```

## Out of scope

- STT / microphone / ffmpeg / voice shortcuts  
- Video generation tools  

## References

- [9Router skills](https://github.com/decolua/9router/tree/master/skills)  
- Pi: `docs/extensions.md`, `docs/custom-provider.md` (in `@earendil-works/pi-coding-agent`)  
