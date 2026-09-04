/**
 * Media tool implementations: image generation (batch + edit refs), TTS,
 * async video generation (Grok Imagine), and speech-to-text. The registration
 * wrappers (schema, description, render) live in tools-register.ts; this
 * module holds the HTTP execution logic.
 */

import { readFile, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import {
  TIMEOUT,
  downloadUrl,
  httpGetJson,
  postBinary,
  postJson,
  postMultipart,
} from "./shared.ts";
import {
  extFromContentType,
  loadImageRef,
  slug,
  stamp,
  writeBytes,
  withExt,
  type ToolUsageCtx,
} from "./toolkit.ts";
import { safeFilename } from "./shared.ts";
import { truncateResult } from "./toolkit.ts";

// ── Image generation (n + optional edit ref) ────────────────────

/** Definitive failures — retrying with another response_format cannot help. */
const FATAL_STATUSES = [401, 402, 403];

/**
 * True for definitive HTTP failures (bad/unauthorized key, unpaid/plan-gated
 * account). Callers must abort immediately — retrying cannot help. Shared by
 * the image and video paths.
 */
export function isFatalMediaStatus(status: number): boolean {
  return FATAL_STATUSES.includes(status);
}

/**
 * Full create-error text for video generation. A 403 keeps the
 * account-access explanation plus the server detail (bounded 2KB at the
 * transport — never silently truncated to the 400-char default); every
 * other status reports `Video job submission failed (status): detail`.
 */
export function videoCreateError(status: number, serverError: string): string {
  if (status === 0) {
    // No HTTP response (network/timeout/abort) — the create POST may still
    // have landed server-side (billed) but no request_id came back to poll.
    return `Video job submission failed before a response (status 0): ${serverError} — the job may still have been created but no request_id was returned, so it cannot be polled; check the 9Router dashboard.`;
  }
  if (status === 403) {
    const tail = serverError ? ` Server: ${serverError}` : "";
    return `Video generation refused (403): the connected xAI account has no video access (needs SuperGrok/X Premium+ or an xAI API key with video quota).${tail}`;
  }
  return `Video job submission failed (${status}): ${serverError}`;
}

/** One image-generation job: prompt plus an optional output filename. */
export interface ImageBatchJob {
  prompt: string;
  filename?: string;
}

/**
 * Batch-preset planning for nr_image_generate (ticket 7): up to 4
 * non-blank prompts, one image each (`n` is ignored when a batch is
 * present); otherwise `n` (clamped 1–4) images of the single prompt.
 * Pure — locked by regression tests.
 */
export function planImageBatch(params: {
  prompt: string;
  prompts?: string[];
  n?: number;
  filename?: string;
}): { batch: string[]; n: number; jobs: ImageBatchJob[] } {
  const batch = (params.prompts || [])
    .map((p) => p.trim())
    .filter(Boolean)
    .slice(0, 4);
  const n = batch.length ? 1 : Math.min(params.n ?? 1, 4);
  const jobs: ImageBatchJob[] = batch.length
    ? batch.map((prompt) => ({
        prompt,
        filename: undefined as string | undefined,
      }))
    : [{ prompt: params.prompt, filename: params.filename }];
  return { batch, n, jobs };
}

/** True when a 200 body is actually JSON (error or b64/url payload), not raw bytes. */
export function bodyIsJson(contentType: string, bytes: Uint8Array): boolean {
  return (
    contentType.toLowerCase().includes("json") || bytes[0] === 0x7b
  ); /* { */
}

/**
 * Image generation loop — behavior-identical to the 1.2.9 implementation
 * (three-stage format chain: binary → b64_json → url; per-iteration loop for
 * n; multi-row url/b64 responses and the i===0 url fallback break the loop so
 * extra billed requests are never issued). Only the final error branch was
 * cleaned: the reported failure is now the FIRST stage failure that actually
 * happened (binary, then b64_json, then url) instead of the confusing
 * precedence the original nesting produced.
 */
export async function generateImages(opts: {
  ep: string;
  key: string;
  outDir: string;
  model: string;
  prompt: string;
  n: number;
  size?: string;
  quality?: string;
  filename?: string;
  /** data URL(s) for edit/img2img — 1 sends `image`, 2+ sends `images[]` */
  imageUrls?: string[];
  signal?: AbortSignal;
}): Promise<{ saved: string[]; error?: string }> {
  const {
    ep,
    key,
    outDir,
    model,
    prompt,
    n,
    size,
    quality,
    filename,
    imageUrls,
    signal,
  } = opts;
  const saved: string[] = [];
  const count = Math.min(Math.max(1, n), 4);

  const baseBody: Record<string, unknown> = { model, prompt, n: 1 };
  if (size) baseBody.size = size;
  if (quality) baseBody.quality = quality;
  if (imageUrls?.length === 1) baseBody.image = imageUrls[0];
  else if (imageUrls && imageUrls.length > 1) baseBody.images = imageUrls;

  for (let i = 0; i < count; i++) {
    // Stage 1: prefer binary (raw bytes) — matches skill default for saving files
    const bin = await postBinary(
      `${ep}/v1/images/generations?response_format=binary`,
      key,
      baseBody,
      { signal, timeoutMs: TIMEOUT.tool },
    );
    if (!bin.ok && FATAL_STATUSES.includes(bin.status)) {
      return {
        saved,
        error: `Image generation failed (${bin.status}): ${bin.error}`,
      };
    }
    if (
      bin.ok &&
      bin.bytes.length > 100 &&
      !bodyIsJson(bin.contentType, bin.bytes)
    ) {
      const ext = extFromContentType(bin.contentType, ".png");
      const cleanName = filename ? safeFilename(filename) : "";
      const name =
        (cleanName && count === 1 ? withExt(cleanName, ext) : null) ||
        `img-${stamp()}-${slug(prompt)}-${i}-${randomSuffix()}${ext}`;
      saved.push(await writeBytes(outDir, name, bin.bytes));
      continue;
    }

    // Stage 2: fallback b64_json
    const res = await postJson(
      `${ep}/v1/images/generations`,
      key,
      { ...baseBody, response_format: "b64_json" },
      { signal, timeoutMs: TIMEOUT.tool },
    );
    if (!res.ok && FATAL_STATUSES.includes(res.status)) {
      return {
        saved,
        error: `Image generation failed (${res.status}): ${res.error}`,
      };
    }
    if (res.ok) {
      const rows = Array.isArray(res.data?.data) ? res.data.data : [];
      if (!rows.length && i === 0) {
        // try url format once
        const res2 = await postJson(
          `${ep}/v1/images/generations`,
          key,
          { ...baseBody, response_format: "url" },
          { signal, timeoutMs: TIMEOUT.tool },
        );
        if (!res2.ok) {
          return {
            saved,
            error: `Image generation failed (${res2.status}): ${res2.error}`,
          };
        }
        for (let j = 0; j < (res2.data?.data || []).length; j++) {
          const url = res2.data.data[j].url;
          if (!url) continue;
          const dl = await downloadUrl(url, { signal });
          if (!dl.ok) continue;
          const ext = extFromContentType(dl.contentType, ".png");
          const nm = `img-${stamp()}-${slug(prompt)}-${j}-${randomSuffix()}${ext}`;
          saved.push(await writeBytes(outDir, nm, dl.bytes));
        }
        // url response may already include n images — done
        break;
      }
      for (let j = 0; j < rows.length; j++) {
        const b64 = rows[j].b64_json;
        if (!b64) continue;
        const dec = decodeDataUrlOrB64(b64);
        if (!dec) continue;
        const nm =
          filename && rows.length === 1 && count === 1
            ? withExt(safeFilename(filename), dec.ext)
            : `img-${stamp()}-${slug(prompt)}-${i}-${j}-${randomSuffix()}${dec.ext}`;
        saved.push(await writeBytes(outDir, nm, dec.bytes));
      }
      // If b64 returned multiple for n:1, we still only wanted one iteration worth
      if (rows.length > 1) break;
      continue;
    }

    // Stage 3: last resort url
    const res2 = await postJson(
      `${ep}/v1/images/generations`,
      key,
      { ...baseBody, response_format: "url" },
      { signal, timeoutMs: TIMEOUT.tool },
    );
    if (!res2.ok) {
      return {
        saved,
        // The first-stage failure is the cause; the later fallback's
        // status only tells us the retries also failed. Report the
        // deepest stage that actually failed first (binary), falling
        // back to the b64/url failure when binary succeeded but was
        // unusable (JSON payload / too small).
        error: !bin.ok
          ? `Image generation failed (${bin.status}): ${bin.error}`
          : `Image generation failed (${res.status}): ${res.error}`,
      };
    }
    for (let j = 0; j < (res2.data?.data || []).length; j++) {
      const url = res2.data.data[j].url;
      if (!url) continue;
      const dl = await downloadUrl(url, { signal });
      if (!dl.ok) continue;
      const ext = extFromContentType(dl.contentType, ".png");
      const nm = `img-${stamp()}-${slug(prompt)}-${i}-${j}-${randomSuffix()}${ext}`;
      saved.push(await writeBytes(outDir, nm, dl.bytes));
    }
    if ((res2.data?.data || []).length > 1) break;
  }

  return { saved };
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 6);
}

function decodeDataUrlOrB64(
  raw: string,
): { bytes: Uint8Array; ext: string } | null {
  const m = raw.match(/^data:(image\/[-a-z0-9.+]+);base64,(.+)$/i);
  if (m) {
    return {
      bytes: Buffer.from(m[2], "base64"),
      ext: extFromContentType(m[1], ".png"),
    };
  }
  try {
    const bytes = Buffer.from(raw, "base64");
    if (bytes.length < 32) return null;
    let ext = ".png";
    if (bytes[0] === 0xff && bytes[1] === 0xd8) ext = ".jpg";
    else if (bytes[0] === 0x89 && bytes[1] === 0x50) ext = ".png";
    return { bytes, ext };
  } catch {
    return null;
  }
}

// ── TTS ─────────────────────────────────────────────────────────

export async function runTts(opts: {
  ep: string;
  key: string;
  outDir: string;
  model: string;
  input: string;
  filename?: string;
  signal?: AbortSignal;
  /** resolveModel note (e.g. resolved "x" → y) — shown under the model */
  modelNote?: string;
}): Promise<{
  text: string;
  details: Record<string, unknown>;
  /** HTTP status for the usage log when the JSON fallback fails (never in details). */
  usageStatus?: number;
}> {
  const { ep, key, outDir, model, input, filename, signal, modelNote } = opts;

  // Prefer raw audio bytes (skill default); JSON is fallback
  let bytes: Uint8Array | null = null;
  let ext = ".mp3";
  const bin = await postBinary(
    `${ep}/v1/audio/speech`,
    key,
    { model, input },
    {
      signal,
      timeoutMs: TIMEOUT.tool,
    },
  );
  if (bin.ok && bin.bytes.length > 64) {
    if (bodyIsJson(bin.contentType, bin.bytes)) {
      // 200 with a JSON body: {audio, format} payload or an error —
      // parse it instead of paying for a second synthesis request.
      try {
        const parsed = JSON.parse(Buffer.from(bin.bytes).toString("utf8")) as {
          audio?: string;
          format?: string;
          error?: unknown;
        };
        if (parsed.audio) {
          bytes = Buffer.from(parsed.audio, "base64");
          if (parsed.format)
            ext = `.${String(parsed.format).replace(/^\./, "")}`;
        } else if (parsed.error) {
          const msg =
            typeof parsed.error === "object" &&
            parsed.error !== null &&
            "message" in parsed.error
              ? String((parsed.error as { message: unknown }).message)
              : String(parsed.error);
          return {
            text: `TTS failed (200 JSON body): ${msg}`,
            details: { model, error: true },
          };
        }
      } catch {
        /* fall through to the json request below */
      }
    } else {
      bytes = bin.bytes;
      ext = extFromContentType(bin.contentType, ".mp3");
    }
  }

  if (!bytes) {
    const res = await postJson(
      `${ep}/v1/audio/speech?response_format=json`,
      key,
      { model, input },
      { signal, timeoutMs: TIMEOUT.tool },
    );
    if (res.ok && res.data?.audio) {
      bytes = Buffer.from(res.data.audio, "base64");
      if (res.data.format)
        ext = `.${String(res.data.format).replace(/^\./, "")}`;
    } else {
      const detail = !bin.ok
        ? `binary HTTP ${bin.status}: ${bin.error}`
        : !res.ok
          ? `json HTTP ${res.status}: ${res.error}`
          : "no audio field in json response";
      return {
        text: `TTS failed (${detail})`,
        details: { model, error: true },
        usageStatus: !bin.ok ? bin.status : !res.ok ? res.status : undefined,
      };
    }
  }

  if (!bytes?.length) {
    return { text: "Empty audio.", details: { model, error: true } };
  }
  const name =
    (filename && withExt(safeFilename(filename), ext)) ||
    `tts-${stamp()}-${slug(input)}${ext}`;
  const path = await writeBytes(outDir, name, bytes);
  return {
    text: [
      "Speech saved.",
      `Model: ${model}`,
      modelNote ? `Model ${modelNote}` : "",
      `File: ${path}`,
      `Chars: ${input.length}`,
    ]
      .filter(Boolean)
      .join("\n"),
    details: { model, file: path, bytes: bytes.length },
  };
}

// ── Video (Grok Imagine) ────────────────────────────────────────

/**
 * Video creation is billed per generation — the create call below runs
 * exactly once (never retried); only the status polls tolerate transient
 * failures. FATAL 401/402/403 aborts immediately in both create and poll
 * (same set as image generation). Timeouts: 600s overall deadline
 * (TIMEOUT.video), 3s abort-aware poll interval, 60s MP4 download
 * (TIMEOUT.download). A 403 means the connected account has no video access.
 */
export const VIDEO_POLL_INTERVAL_MS = 3_000;

/**
 * Dedup predicate for video-poll progress toasts. A 10-minute generation
 * polls every 3 s (~200 polls/job) — notifying on every poll spams the chat
 * with toasts, so only status/progress advances toast (lastProgress dedup).
 * Pure test seam: fold a poll sequence through it and count the `true`
 * returns to get the toast count (see tests/tools.test.ts).
 */
export function videoPollChanged(
  last: { status?: string; progress?: number },
  job: { status?: string; progress?: number },
): boolean {
  if (job.progress != null && job.progress !== last.progress) return true;
  return job.status !== last.status;
}

interface VideoJob {
  status: string;
  progress?: number;
  video?: { url?: string; duration?: number };
  error?: { code?: string; message?: string };
}

export interface VideoRunResult {
  text?: string;
  details?: Record<string, unknown>;
  error?: string;
  errorDetails?: Record<string, unknown>;
  usage?: Partial<Omit<ToolUsageCtx, "tool" | "model" | "t0">>;
}

/**
 * Async video generation: billed create (exactly once) → abort-aware 3 s
 * poll loop → MP4 download. Split out of the registration wrapper so the
 * polling loop is testable without a pi session.
 */
export async function runVideoGeneration(opts: {
  ep: string;
  key: string;
  outDir: string;
  model: string;
  prompt: string;
  duration?: number;
  aspectRatio?: string;
  resolution?: string;
  imageUrl?: string;
  filename?: string;
  signal?: AbortSignal;
  /** resolveModel note — shown under the model */
  modelNote?: string;
  onUpdate?: (msg: string) => void;
}): Promise<VideoRunResult> {
  const { ep, key, outDir, model, prompt, signal, onUpdate, modelNote } = opts;

  const body: Record<string, unknown> = { model, prompt };
  if (opts.duration) body.duration = opts.duration;
  if (opts.aspectRatio) body.aspect_ratio = opts.aspectRatio;
  if (opts.resolution) body.resolution = opts.resolution;
  if (opts.imageUrl) body.image = { url: opts.imageUrl };

  onUpdate?.(`Submitting video job · ${model}…`);
  const create = await postJson(`${ep}/v1/videos/generations`, key, body, {
    signal,
    timeoutMs: TIMEOUT.tool,
    // Bounded 2KB detail (FULL_ERROR_MAX) — videoCreateError relays it.
    fullError: true,
  });
  if (!create.ok) {
    // Create runs exactly once (billed) — every failure aborts
    // immediately; FATAL statuses keep the full 403 explanation.
    return {
      error: videoCreateError(create.status, create.error),
      errorDetails: { model },
      usage: { status: create.status },
    };
  }
  const requestId = create.data?.request_id;
  if (!requestId) {
    return {
      error: `Video job submission returned no request_id: ${JSON.stringify(create.data).slice(0, 200)}`,
      errorDetails: { model },
    };
  }
  // Jobs are account-bound — polls must carry the creating connection id.
  const connectionId =
    create.headers["x-9router-connection-id"] ||
    create.headers["x-connection-id"];

  const deadline = Date.now() + TIMEOUT.video;
  const tPollStart = Date.now();
  let polls = 0;
  let lastProgress: number | undefined;
  let lastStatus: string | undefined;
  while (Date.now() < deadline) {
    if (signal?.aborted) {
      return {
        error: "Video generation aborted.",
        errorDetails: { model, request_id: requestId },
      };
    }
    try {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, VIDEO_POLL_INTERVAL_MS);
        if (signal) {
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(t);
              reject(signal.reason ?? new Error("aborted"));
            },
            { once: true },
          );
          if (signal.aborted) {
            clearTimeout(t);
            reject(signal.reason ?? new Error("aborted"));
          }
        }
      });
    } catch {
      return {
        error: "Video generation aborted.",
        errorDetails: { model, request_id: requestId },
      };
    }
    const poll = await httpGetJson<VideoJob>(
      `${ep}/v1/videos/${encodeURIComponent(requestId)}`,
      key,
      {
        signal,
        timeoutMs: TIMEOUT.info,
        // FATAL poll errors surface poll.error — bounded 2KB detail.
        fullError: true,
        ...(connectionId
          ? { headers: { "x-connection-id": connectionId } }
          : {}),
      },
    );
    if (!poll.ok) {
      // FATAL poll failures abort immediately (mirrors generateImages);
      // transient poll failures are tolerated until the deadline.
      if (isFatalMediaStatus(poll.status)) {
        return {
          error: `Video job poll refused (${poll.status}): ${poll.error}`,
          errorDetails: { model, request_id: requestId },
          usage: { status: poll.status },
        };
      }
      polls++;
      onUpdate?.(
        `Video pending · poll ${polls} · ${Math.round((Date.now() - tPollStart) / 1000)}s (retrying)…`,
      );
      continue;
    }
    const job = poll.data || ({} as VideoJob);
    // Dedup: a full-length job polls ~200 times — toast only when
    // status/progress actually advanced (lastProgress dedup). Abort
    // stays effective via the loop-top check and the abort-aware sleep.
    polls++;
    if (videoPollChanged({ status: lastStatus, progress: lastProgress }, job)) {
      lastStatus = job.status;
      lastProgress = job.progress;
      onUpdate?.(
        `Video ${job.status || "pending"} · ${job.progress ?? "?"}% · ${Math.round((Date.now() - tPollStart) / 1000)}s (poll ${polls})`,
      );
    }
    if (job.status === "done" && job.video?.url) {
      const dl = await downloadUrl(job.video.url, {
        signal,
        timeoutMs: TIMEOUT.download,
      });
      if (!dl.ok) {
        return {
          error: `Video completed but the MP4 download failed (${dl.status}): ${dl.error}`,
          errorDetails: { model, request_id: requestId, url: job.video.url },
          usage: { status: dl.status },
        };
      }
      const name = withExt(
        opts.filename
          ? safeFilename(opts.filename)
          : `video-${stamp()}-${slug(prompt)}`,
        ".mp4",
      );
      const path = await writeBytes(outDir, name, dl.bytes);
      return {
        text: [
          "Video saved.",
          `Model: ${model}`,
          modelNote ? `Model ${modelNote}` : "",
          `File: ${path}`,
          job.video.duration ? `Duration: ${job.video.duration}s` : "",
          `Prompt: ${prompt}`,
        ]
          .filter(Boolean)
          .join("\n"),
        details: {
          model,
          file: path,
          url: job.video.url,
          duration: job.video.duration,
          request_id: requestId,
        },
        usage: { bytes: dl.bytes.byteLength },
      };
    }
    if (job.status === "failed") {
      return {
        error: `Video generation failed${job.error?.code ? ` (${job.error.code})` : ""}: ${job.error?.message || "no error detail"}`,
        errorDetails: { model, request_id: requestId },
      };
    }
  }
  return {
    error: `Video generation timed out after ${Math.round(TIMEOUT.video / 1000)}s — the job may still finish; check the 9Router dashboard.`,
    errorDetails: { model, request_id: requestId },
  };
}

// ── STT ─────────────────────────────────────────────────────────

/** Cap on transcription uploads — matches OpenAI's Whisper limit. */
export const MAX_STT_BYTES = 25 * 1024 * 1024;
export const STT_MEDIA: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".webm": "audio/webm",
  ".ogg": "audio/ogg",
  ".flac": "audio/flac",
};

export interface SttRunResult {
  text?: string;
  details?: Record<string, unknown>;
  error?: string;
  errorDetails?: Record<string, unknown>;
  usage?: Partial<Omit<ToolUsageCtx, "tool" | "model" | "t0">>;
}

export async function runStt(opts: {
  ep: string;
  key: string;
  model: string;
  filePath: string;
  cwd: string;
  language?: string;
  prompt?: string;
  responseFormat?: string;
  temperature?: number;
  signal?: AbortSignal;
  /** resolveModel note — shown under the model */
  modelNote?: string;
  onUpdate?: (msg: string) => void;
}): Promise<SttRunResult> {
  const { ep, key, model, filePath, cwd, signal, onUpdate, modelNote } = opts;

  const target = filePath.trim().replace(/^@/, "");
  const abs = isAbsolute(target) ? target : resolve(cwd, target);
  let bytes: Buffer;
  try {
    const st = await stat(abs);
    if (st.size > MAX_STT_BYTES) {
      return {
        error: `Audio file too large (${Math.round(st.size / 1024 / 1024)} MB; limit 25 MB).`,
        errorDetails: { file_path: filePath },
      };
    }
    bytes = await readFile(abs);
  } catch {
    return {
      error: `Could not read audio file: ${filePath}`,
      errorDetails: { file_path: filePath },
    };
  }

  const ext = extname(abs).toLowerCase();
  if (!STT_MEDIA[ext]) {
    return {
      error: `Unsupported audio format "${ext}" — expected mp3, wav, m4a, webm, ogg, or flac.`,
      errorDetails: { file_path: filePath },
    };
  }

  onUpdate?.(`Transcribing · ${basename(abs)} · ${model}`);

  const form = new FormData();
  form.append("model", model);
  form.append(
    "file",
    new Blob([new Uint8Array(bytes)], { type: STT_MEDIA[ext] }),
    basename(abs),
  );
  if (opts.language) form.append("language", opts.language);
  if (opts.prompt) form.append("prompt", opts.prompt);
  if (opts.responseFormat) form.append("response_format", opts.responseFormat);
  if (opts.temperature != null)
    form.append("temperature", String(opts.temperature));

  const res = await postMultipart(`${ep}/v1/audio/transcriptions`, key, form, {
    signal,
    timeoutMs: TIMEOUT.tool,
  });
  if (!res.ok) {
    return {
      error: `Transcription failed (${res.status}): ${res.error}`,
      errorDetails: { model },
      usage: { status: res.status },
    };
  }

  // json/verbose_json bodies carry {text}; text/srt/vtt are the payload itself.
  let transcript = res.text;
  let verbose:
    { language?: string; duration?: number; segments?: unknown[] } | undefined;
  if (
    res.contentType.toLowerCase().includes("json") ||
    res.text.trimStart().startsWith("{")
  ) {
    try {
      const parsed = JSON.parse(res.text) as {
        text?: string;
        language?: string;
        duration?: number;
        segments?: unknown[];
      };
      transcript = parsed.text ?? res.text;
      verbose = parsed;
    } catch {
      /* keep raw text */
    }
  }
  if (!transcript.trim()) {
    return {
      error: "Transcription returned empty text.",
      errorDetails: { model },
    };
  }

  const header = [
    `File: ${abs}`,
    `Model: ${model}`,
    modelNote ? `Model ${modelNote}` : "",
    verbose?.language ? `Language: ${verbose.language}` : "",
    verbose?.duration ? `Duration: ${Math.round(verbose.duration)}s` : "",
    verbose?.segments?.length ? `Segments: ${verbose.segments.length}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const text = await truncateResult(
    `${header}\n\n${transcript}`,
    "stt",
    "head",
  );
  return {
    text,
    details: {
      model,
      file: abs,
      chars: transcript.length,
      format: opts.responseFormat || "json",
    },
    usage: { bytes: bytes.length },
  };
}

// modules need no second path import).
import {
  isAbsolute as isAbsoluteLocal,
  resolve as resolveLocal,
} from "node:path";
