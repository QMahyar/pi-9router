/**
 * Tool execution helpers shared by every nr_* tool: ToolError + gate
 * rejections, bounded usage logging, output-file naming/writing, reference
 * image loading, result truncation, and the compact TUI renderer.
 */

import {
  truncateHead,
  truncateTail,
  formatSize,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import {
  type CapDef,
  type UsageRecord,
  logUsage,
  safeFilename,
} from "./shared.ts";

// ── Errors / gates ──────────────────────────────────────────────

/**
 * Thrown from execute() so pi marks the tool result as failed. Per the pi
 * docs, returning `{ isError: true }` never sets the error flag — only
 * throwing does. Details are folded into the message so they still reach the
 * model (e.g. `requested`, `model`, `url`).
 */
export class ToolError extends Error {
  readonly details: Record<string, unknown>;
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "ToolError";
    this.details = details;
  }
}

/** Latency/cost tracking for the bounded usage log (9router-usage.jsonl). */
export interface ToolUsageCtx {
  tool: string;
  model: string;
  t0: number;
  status?: number;
  bytes?: number;
  count?: number;
}

export function usageRec(u: ToolUsageCtx): {
  tool: string;
  model: string;
  ms: number;
  status?: number;
  bytes?: number;
  count?: number;
} {
  const rec: {
    tool: string;
    model: string;
    ms: number;
    status?: number;
    bytes?: number;
    count?: number;
  } = {
    tool: u.tool,
    model: u.model,
    ms: Date.now() - u.t0,
  };
  if (u.status != null) rec.status = u.status;
  if (u.bytes != null) rec.bytes = u.bytes;
  if (u.count != null) rec.count = u.count;
  return rec;
}

export function toolError(
  message: string,
  details: Record<string, unknown> = {},
  usage?: ToolUsageCtx,
): never {
  if (usage) logUsage({ ...usageRec(usage), ok: false });
  const keys = Object.keys(details);
  const suffix = keys.length
    ? ` — ${keys.map((k) => `${k}: ${String(details[k])}`).join(", ")}`
    : "";
  throw new ToolError(message + suffix, details);
}

export function toolOk(
  text: string,
  details: Record<string, unknown> = {},
  usage?: ToolUsageCtx,
) {
  if (usage) logUsage({ ...usageRec(usage), ok: true });
  return { content: [{ type: "text" as const, text }], details };
}

/**
 * Usage record for gate rejections (cap off / no catalog / unknown model).
 * Gates throw before t0/model exist, so they never build a ToolUsageCtx —
 * without this record they bypassed the usage log entirely. Every
 * `blocked` / `!picked.ok` branch logs one before throwing.
 */
export function gateUsageRec(
  tool: string,
  note: string,
  model?: string,
): UsageRecord {
  const trimmed = model?.trim();
  return {
    tool,
    ...(trimmed ? { model: trimmed } : {}),
    ms: 0,
    ok: false,
    note,
  };
}

export function needSyncHint(): string {
  return "No 9Router catalog yet. Open /9router → Sync models first.";
}

export function needCap(
  cfg: {
    catalog?: unknown[];
    capabilities?: Record<string, { enabled?: boolean }>;
  },
  cap: CapDef,
): string | null {
  // Original semantics: getCapState spread-merges the stored per-cap object
  // over { enabled: cap.defaultEnabled } and needCap checks !state.enabled —
  // so a stored `enabled: null` (hand-edited config) resolves falsy = OFF.
  // `?? defaultEnabled` would turn that null into ON. Reproduce the merge:
  const stored = cfg.capabilities?.[cap.id];
  const enabled =
    stored && "enabled" in stored
      ? // Truthy check mirrors `!state.enabled` on the merged object
        // (null/undefined/false → off; true → on).
        stored.enabled === true
      : cap.defaultEnabled;
  if (!enabled) {
    return `${cap.label} is off. Enable it in /9router-tools.`;
  }
  if (!cfg.catalog?.length) return needSyncHint();
  return null;
}

// ── Output files ────────────────────────────────────────────────

export async function ensureDir(dir: string) {
  await mkdir(dir, { recursive: true });
}

export function slug(s: string, max = 40): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, max) || "out"
  );
}

export function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Write bytes without ever clobbering an existing file (numeric suffix on collision). */
export async function writeBytes(
  dir: string,
  name: string,
  bytes: Uint8Array,
): Promise<string> {
  await ensureDir(dir);
  const ext = extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  for (let attempt = 0; ; attempt++) {
    const candidate = attempt === 0 ? name : `${stem}-${attempt}${ext}`;
    try {
      const path = join(dir, candidate);
      await writeFile(path, bytes, { flag: "wx" });
      return path;
    } catch (err: any) {
      if (err?.code === "EEXIST") continue;
      throw err;
    }
  }
}

export function extFromContentType(ct: string, fallback: string): string {
  const c = ct.toLowerCase();
  if (c.includes("png")) return ".png";
  if (c.includes("jpeg") || c.includes("jpg")) return ".jpg";
  if (c.includes("webp")) return ".webp";
  if (c.includes("gif")) return ".gif";
  if (c.includes("mp3") || c.includes("mpeg")) return ".mp3";
  if (c.includes("wav")) return ".wav";
  if (c.includes("ogg")) return ".ogg";
  return fallback;
}

/** Append `ext` to a user-provided file name when it lacks any extension. */
export function withExt(name: string, ext: string): string {
  return ext && extname(name) === "" ? name + ext : name;
}

/** Max size for a reference image — caps memory and upstream payload. */
export const MAX_IMAGE_REF_BYTES = 20 * 1024 * 1024;

/**
 * Resolve a local image path for edit/reference; return base64 data URL or null.
 * Strips a leading "@" (some models paste @ into path args) before resolving.
 */
export async function loadImageRef(
  pathOrData: string,
  cwd: string,
): Promise<string | null> {
  const raw = pathOrData.trim();
  if (!raw) return null;
  if (raw.startsWith("data:image/")) return raw;
  // bare base64
  if (/^[A-Za-z0-9+/=\s]+$/.test(raw) && raw.replace(/\s/g, "").length > 64) {
    const cleaned = raw.replace(/\s/g, "");
    try {
      const buf = Buffer.from(cleaned, "base64");
      if (buf.length > 32 && buf.length <= MAX_IMAGE_REF_BYTES) {
        const ext =
          buf[0] === 0xff && buf[1] === 0xd8
            ? "jpeg"
            : buf[0] === 0x89 && buf[1] === 0x50
              ? "png"
              : "png";
        return `data:image/${ext};base64,${cleaned}`;
      }
    } catch {
      /* fall through to path */
    }
  }
  const target = raw.startsWith("@") ? raw.slice(1) : raw;
  const abs = isAbsolute(target) ? target : resolve(cwd, target);
  try {
    const st = await stat(abs);
    if (st.size > MAX_IMAGE_REF_BYTES) return null;
    const bytes = await readFile(abs);
    const ext = extname(abs).toLowerCase();
    const media =
      ext === ".jpg" || ext === ".jpeg"
        ? "image/jpeg"
        : ext === ".webp"
          ? "image/webp"
          : ext === ".gif"
            ? "image/gif"
            : "image/png";
    return `data:${media};base64,${bytes.toString("base64")}`;
  } catch {
    return null;
  }
}

// ── Result truncation (docs-mandated: default 50KB / 2000 lines) ──────

async function writeTempArtifact(
  text: string,
  prefix: string,
): Promise<string> {
  const name = `${prefix}-${stamp()}-${randomBytes(8).toString("hex")}.txt`;
  const path = join(tmpdir(), name);
  await writeFile(path, text, "utf8");
  return path;
}

/** Keep head/tail within the default limits; save the full text to a temp file when cut. */
export async function truncateResult(
  text: string,
  prefix: string,
  mode: "head" | "tail",
): Promise<string> {
  const t = mode === "head" ? truncateHead(text) : truncateTail(text);
  if (!t.truncated) return text;
  const fullPath = await writeTempArtifact(text, prefix);
  return (
    t.content +
    `\n\n[Output truncated: ${t.outputLines} of ${t.totalLines} lines (${formatSize(t.outputBytes)} of ${formatSize(t.totalBytes)}). Full output saved to: ${fullPath}]`
  );
}

// ── Render ──────────────────────────────────────────────────────

export function compactResult(
  title: string,
  detail: string,
  theme: Theme,
  expanded: boolean,
  full: string,
): Text {
  if (!expanded) {
    return new Text(
      theme.fg("toolTitle", title) +
        (detail ? theme.fg("dim", ` · ${truncateToWidth(detail, 56)}`) : ""),
      0,
      0,
    );
  }
  return new Text(full || detail || title, 0, 0);
}

export function textFromResult(result: {
  content?: Array<{ type: string; text?: string }>;
}): string {
  return (
    result.content
      ?.filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n") || ""
  );
}

// Type re-export for tool modules that take a config slice through toolkit helpers.
export type { ToolsConfigSlice } from "./model-resolve.ts";
