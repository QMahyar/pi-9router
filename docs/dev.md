# Dev — @qmahyar/pi-9router

```text
extensions/
  9router.ts         # /9router — sync + chat provider
  9router-tools.ts   # /9router-tools + nr_* tools
```

- Core emits `9router:synced` after catalog refresh.  
- Tools call `setActiveTools` so only enabled tools hit the model prompt.  
- Shared config: `~/.pi/agent/9router.json`  

Publish: `npm publish --access public` from package root (name `@qmahyar/pi-9router`).
