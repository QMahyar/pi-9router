# Dev — @qmahyar/pi-9router

```text
extensions/
  9router.ts         # /9router — sync + chat provider
  9router-tools.ts   # /9router-tools + nr_* tools
```

- Core emits `9router:synced` after catalog refresh.  
- Tools call `setActiveTools` so only enabled tools hit the model prompt.  
- Shared config: `~/.pi/agent/9router.json`  

**Catalog shape.** `/v1/models[/kind]` returns only `{ id, object, owned_by }`, so sync
follows up with `/v1/models/info?id=` per model (concurrency 8, best-effort) for `name`,
`kind`, `endpoint`, and `params`. Entries record `namedByServer` when the name is the
server's; the derived slug is only a fallback. The list `kind` stays the grouping bucket
(`web`) and the server's precise kind lands in `detailKind` (`webSearch` / `webFetch`),
which is what the web tool filters match on.

**Synthetic entries.** `edge-tts` / `google-tts` are added locally (`synthetic: true`)
after a `/v1/audio/speech` probe returns real audio. Keep the probe — these 502 behind a
proxy, and listing dead models is worse than omitting them.

**Tool descriptions** embed the catalog ids, so `registerAll()` re-runs on
`9router:synced`; `registerTool` keys on tool name, so re-registering replaces cleanly.

Exported for testing: `fetchAllAndBuild`, `resolveModel`, `describeModels`, `CAPS`.

Publish: `npm publish --access public` from package root (name `@qmahyar/pi-9router`).
