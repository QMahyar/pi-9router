# Developer guide

## Layout

```
extensions/
  9router.ts         # /9router — sync + chat provider
  9router-tools.ts   # /9router-tools + Ctrl+Shift+V + nr_* tools
scripts/
  check-ffmpeg.cjs   # postinstall hint
```

## UI conventions

- Prefer plain labels (`Sync models`, `Turn on`) over emoji-heavy rows
- Column-aligned capability list in `/9router-tools`
- Nested **Connection** / **Voice input** submenus keep the root short

## Voice shortcut

`pi.registerShortcut("ctrl+shift+v")` is always registered.  
Handler checks STT `enabled` and returns a notify if off — no separate `/voice` command.

## ffmpeg

`resolveFfmpeg()` searches config → env → PATH → `ffmpeg-static` (walk package roots under `~/.pi`).

## Events

`9router.ts` emits `9router:synced` after catalog refresh; tools re-apply activation.
