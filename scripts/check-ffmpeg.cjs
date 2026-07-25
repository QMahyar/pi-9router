#!/usr/bin/env node
/**
 * postinstall: ensure an ffmpeg binary is reachable.
 * Prefer system ffmpeg on PATH; otherwise rely on the ffmpeg-static dependency.
 */
const { existsSync } = require("node:fs");
const { execFileSync } = require("node:child_process");

function onPath() {
  try {
    if (process.platform === "win32") {
      const out = execFileSync("where.exe", ["ffmpeg"], { encoding: "utf8" })
        .trim()
        .split(/\r?\n/)[0];
      return out || null;
    }
    const out = execFileSync("which", ["ffmpeg"], { encoding: "utf8" }).trim();
    return out || null;
  } catch {
    return null;
  }
}

function bundled() {
  try {
    const bin = require("ffmpeg-static");
    if (bin && existsSync(bin)) return bin;
  } catch {
    /* not installed yet / optional */
  }
  return null;
}

const sys = onPath();
const pack = bundled();

if (sys) {
  console.log(`[pi-9router] ffmpeg (PATH): ${sys}`);
} else if (pack) {
  console.log(`[pi-9router] ffmpeg (ffmpeg-static): ${pack}`);
} else {
  console.warn(
    "[pi-9router] ffmpeg not found. Voice input (Ctrl+Shift+V) needs ffmpeg.\n" +
      "  • Windows: winget install Gyan.FFmpeg\n" +
      "  • macOS:   brew install ffmpeg\n" +
      "  • Linux:   sudo apt install ffmpeg\n" +
      "  • Or:      npm install ffmpeg-static  (in this package)\n" +
      "  • Or set FFMPEG_PATH / configure path in /9router-tools → Voice input",
  );
}
