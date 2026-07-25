# Setup

## 1. 9Router

```bash
npm install -g 9router
9router
curl http://localhost:20128/api/health
```

## 2. This package

```bash
pi install git:github.com/QMahyar/pi-9router
```

Installs extensions + **`ffmpeg-static`**. `postinstall` reports whether ffmpeg was found.

### ffmpeg (voice input)

Resolution order:

1. `ffmpegPath` in `~/.pi/agent/9router.json` (set in /9router-tools → Voice input)
2. `FFMPEG_PATH` or `FFMPEG_BINARY` env
3. `ffmpeg` on **PATH**
4. Bundled **`ffmpeg-static`**

If none work, Ctrl+Shift+V shows an error. System install examples:

```bash
winget install Gyan.FFmpeg
brew install ffmpeg
sudo apt install ffmpeg
```

## 3. First run in pi

1. `/9router` → **Connection** (if needed) → **Sync models**
2. `/9router-tools` → enable tools / set defaults
3. Voice: **Voice input** → pick mic (Windows) → **Ctrl+Shift+V**

## Avoid double-loading

Use either `pi install` **or** copies in `~/.pi/agent/extensions/`, not both.
