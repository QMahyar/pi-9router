/**
 * Tool registration wrappers for the nr_* tools: schemas, descriptions
 * (withModelHint), gate checks, execute glue over the run* implementations
 * in tools-media.ts / tools-web.ts, renderers, and the /9router-tools TUI.
 * 9router-tools.ts (the pi entry) wires these into the ExtensionAPI.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { basename, extname } from "node:path";
import {
  CAPS,
  type CapDef,
  CONFIG_PATH,
  formatUsageByTool,
  isSyncStale,
  logUsage,
} from "./shared.ts";
import {
  type ToolsConfigSlice,
  getCapState,
  isAutoRichDefault,
  loadRaw,
  modelsForCap,
  resolveModel,
  saveRaw,
  withModelHint,
} from "./model-resolve.ts";
import { pickAutoDefaultModel } from "./shared.ts";
import {
  gateUsageRec,
  needCap,
  textFromResult,
  toolError,
  toolOk,
  compactResult,
  loadImageRef,
} from "./toolkit.ts";
import {
  generateImages as runImageJob,
  planImageBatch,
  runStt,
  runTts,
  runVideoGeneration,
  VIDEO_POLL_INTERVAL_MS,
} from "./tools-media.ts";
import { runEmbed, runWebFetch, runWebSearch } from "./tools-web.ts";
import {
  VIDEO_DEFAULT_MODEL,
  endpointOf,
  apiKeyOf,
  outputDirOf,
  shouldAttachImage,
} from "./model-resolve.ts";

// ── Small display helpers ───────────────────────────────────────

function shortModel(id?: string, max = 36): string {
  if (!id) return "auto";
  return id.length <= max ? id : "…" + id.slice(-(max - 1));
}

function padLabel(label: string, width: number): string {
  if (label.length >= width) return label.slice(0, width);
  return label + " ".repeat(width - label.length);
}

// ── Active tools ────────────────────────────────────────────────

export function applyToolActivation(
  pi: ExtensionAPI,
  cfg: ToolsConfigSlice,
): void {
  const active = new Set(pi.getActiveTools());
  const allKnown = new Set(pi.getAllTools().map((t) => t.name));

  for (const cap of CAPS) {
    if (!allKnown.has(cap.tool)) continue;
    if (getCapState(cfg, cap).enabled) active.add(cap.tool);
    else active.delete(cap.tool);
  }
  pi.setActiveTools([...active]);
}

// ── Image tool ──────────────────────────────────────────────────

function registerImageTool(pi: ExtensionAPI, cfg: ToolsConfigSlice) {
  const cap = CAPS.find((c) => c.id === "image")!;
  pi.registerTool({
    name: cap.tool,
    label: "Image",
    description: withModelHint(
      cfg,
      cap,
      "Generate an image through 9Router and save it to disk. Best for icons, logos, illustrations, UI mockups, and concept art. Optional image_path / image_paths enable edit/img2img with 1–4 reference images when the model supports it. Pass prompts (up to 4) for a batch — one image per prompt. Returns the saved file path; the image itself is not embedded in the result by default.",
    ),
    promptSnippet: "Generate an image (9Router) and save the file path",
    promptGuidelines: [
      "Call nr_image_generate to create images, icons, logos, illustrations, or mockups.",
      "Write a detailed prompt (subject, style, colors, composition).",
      "Omit model unless the user names a specific image model; when they do, pass its exact catalog id (browse via /9router-tools if unsure). Optional size, quality, n (1–4), filename, image_path (single reference image for edit/img2img), image_paths (up to 4 references), prompts (batch of up to 4 prompts — one image each, n is ignored).",
      "Tell the user the saved file path from the tool result.",
      "The image is not embedded in the result — read the returned path if you need to see it.",
    ],
    parameters: Type.Object({
      prompt: Type.String({
        description: "Image prompt: subject, style, colors, composition",
      }),
      prompts: Type.Optional(
        Type.Array(Type.String(), {
          maxItems: 4,
          description:
            "Batch presets: up to 4 prompts, one image per preset (n is ignored when set)",
        }),
      ),
      model: Type.Optional(
        Type.String({
          description: "Image model id (optional; uses /9router-tools default)",
        }),
      ),
      size: Type.Optional(
        Type.String({ description: "Size if supported, e.g. 1024x1024" }),
      ),
      n: Type.Optional(
        Type.Integer({
          description: "Number of images, 1–4 (default 1)",
          minimum: 1,
          maximum: 4,
        }),
      ),
      quality: Type.Optional(
        Type.String({ description: "standard or hd when supported" }),
      ),
      filename: Type.Optional(
        Type.String({ description: "Output file name only, no folders" }),
      ),
      image_path: Type.Optional(
        Type.String({
          description:
            "Local path (or data URL) of a reference image for edit/img2img when the model supports it",
        }),
      ),
      image_paths: Type.Optional(
        Type.Array(Type.String(), {
          maxItems: 4,
          description:
            "Multiple reference images for edit/img2img (1–4); use image_path for a single one",
        }),
      ),
    }),
    prepareArguments(args) {
      if (!args || typeof args !== "object") return args as never;
      const input = args as Record<string, unknown>;
      // Resumed/legacy sessions may pass camelCase — fold into the schema.
      if (
        input.image_path === undefined &&
        typeof input.imagePath === "string"
      ) {
        const rest: Record<string, unknown> = { ...input };
        delete rest.imagePath;
        rest.image_path = input.imagePath;
        return rest as never;
      }
      if (
        input.image_paths === undefined &&
        Array.isArray(input.imagePaths) &&
        input.imagePaths.every((p) => typeof p === "string")
      ) {
        const rest: Record<string, unknown> = { ...input };
        delete rest.imagePaths;
        rest.image_paths = input.imagePaths;
        return rest as never;
      }
      return args as never;
    },
    async execute(_id, params, signal, onUpdate, ctx) {
      const cfgNow = loadRaw();
      const blocked = needCap(cfgNow, cap);
      if (blocked) {
        logUsage(gateUsageRec(cap.tool, blocked, params.model));
        return toolError(blocked);
      }
      const picked = resolveModel(cfgNow, cap, params.model);
      if (!picked.ok) {
        logUsage(gateUsageRec(cap.tool, picked.message, params.model));
        return toolError(picked.message, { requested: params.model });
      }
      const model = picked.id;
      const t0 = Date.now();
      const use = makeUsage(cap.tool, model, t0);

      const ep = endpointOf(cfgNow);
      const key = apiKeyOf(cfgNow);
      const outDir = outputDirOf(cfgNow);
      // Batch presets: one image per prompt (n is ignored); else n images of prompt.
      const { batch, n, jobs } = planImageBatch(params);

      const refsRaw = [
        ...(params.image_path?.trim() ? [params.image_path] : []),
        ...(Array.isArray(params.image_paths)
          ? params.image_paths.filter((p) => p?.trim())
          : []),
      ].slice(0, 4);
      const imageUrls: string[] = [];
      for (const ref of refsRaw) {
        const loaded = await loadImageRef(ref, ctx.cwd);
        if (!loaded) {
          return toolError(
            `Could not read reference image: ${ref}`,
            { image_path: ref },
            use(),
          );
        }
        imageUrls.push(loaded);
      }

      onUpdate?.({
        content: [
          {
            type: "text",
            text: batch.length
              ? `Generating batch of ${batch.length} images with ${model}…`
              : `Generating ${n} image(s) with ${model}${imageUrls.length ? ` (${imageUrls.length} ref image${imageUrls.length > 1 ? "s" : ""})` : ""}…`,
          },
        ],
        details: {},
      });

      const saved: string[] = [];
      let firstError: string | undefined;
      for (const [i, job] of jobs.entries()) {
        if (signal?.aborted) break;
        if (jobs.length > 1)
          onUpdate?.({
            content: [{ type: "text", text: `Batch ${i + 1}/${jobs.length}…` }],
            details: {},
          });
        const r = await runImageJob({
          ep,
          key,
          outDir,
          model,
          prompt: job.prompt,
          n,
          size: params.size,
          quality: params.quality,
          filename: job.filename,
          imageUrls,
          signal,
        });
        saved.push(...r.saved);
        if (r.error && !firstError) firstError = r.error;
      }

      if (firstError && !saved.length)
        return toolError(firstError, { model }, use());
      if (!saved.length)
        return toolError("No image data returned.", { model }, use());

      const text = [
        `Generated ${saved.length} image(s) · ${model}`,
        picked.note ? `Model ${picked.note}` : "",
        refsRaw.length
          ? `Reference${refsRaw.length > 1 ? "s" : ""}: ${refsRaw.join(", ")}`
          : "",
        ...(batch.length
          ? batch.map((p) => `Prompt: ${p}`)
          : [`Prompt: ${params.prompt}`]),
        firstError ? `Note: ${firstError}` : "",
        ...saved.map((p) => `File: ${p}`),
      ]
        .filter(Boolean)
        .join("\n");

      const content: Array<
        | { type: "text"; text: string }
        | { type: "image"; data: string; mimeType: string }
      > = [{ type: "text", text }];

      let attached = false;
      if (shouldAttachImage(cfgNow)) {
        try {
          const first = saved[0];
          const st = await statFile(first);
          if (st.size > 0) {
            const bytes = await readFile(first);
            const ext = extname(first).toLowerCase();
            const mediaType =
              ext === ".jpg" || ext === ".jpeg"
                ? "image/jpeg"
                : ext === ".webp"
                  ? "image/webp"
                  : "image/png";
            content.push({
              type: "image",
              data: bytes.toString("base64"),
              mimeType: mediaType,
            });
            attached = true;
          }
        } catch {
          /* path is already in text */
        }
      }

      logUsage({
        tool: cap.tool,
        model,
        ms: Date.now() - t0,
        ok: true,
        count: saved.length,
      });
      return {
        content,
        details: {
          model,
          files: saved,
          prompt: params.prompt,
          n: saved.length,
          cwd: ctx.cwd,
          attached,
          imageRefs: refsRaw.length ? refsRaw : undefined,
        },
      };
    },
    renderResult(result, { expanded }, theme) {
      const d = (result.details || {}) as { files?: string[]; model?: string };
      return compactResult(
        "nr_image_generate",
        `${d.files?.length || 0} file(s)${d.model ? ` · ${d.model}` : ""}`,
        theme,
        expanded,
        textFromResult(result),
      );
    },
  });
}

// ── TTS tool ────────────────────────────────────────────────────

function registerTtsTool(pi: ExtensionAPI, cfg: ToolsConfigSlice) {
  const cap = CAPS.find((c) => c.id === "tts")!;
  pi.registerTool({
    name: cap.tool,
    label: "Speech",
    description: withModelHint(
      cfg,
      cap,
      "Convert text to speech through 9Router and save an audio file. Use for narration or voiceover.",
    ),
    promptSnippet: "Text-to-speech (9Router) — saves an audio file",
    promptGuidelines: [
      "Call nr_tts to turn text into spoken audio (narration, voiceover, read-aloud).",
      "Pass the full text in input. Omit model unless the user picks a specific voice/model.",
      "Report the saved audio file path from the tool result.",
    ],
    parameters: Type.Object({
      input: Type.String({ description: "Text to speak" }),
      model: Type.Optional(
        Type.String({ description: "TTS model/voice id (optional)" }),
      ),
      filename: Type.Optional(
        Type.String({ description: "Output file name only" }),
      ),
    }),
    async execute(_id, params, signal, onUpdate) {
      const cfgNow = loadRaw();
      const blocked = needCap(cfgNow, cap);
      if (blocked) {
        logUsage(gateUsageRec(cap.tool, blocked, params.model));
        return toolError(blocked);
      }
      const picked = resolveModel(cfgNow, cap, params.model);
      if (!picked.ok) {
        logUsage(gateUsageRec(cap.tool, picked.message, params.model));
        return toolError(picked.message, { requested: params.model });
      }
      const model = picked.id;
      const t0 = Date.now();
      const use = makeUsage(cap.tool, model, t0);
      onUpdate?.({
        content: [{ type: "text", text: `Synthesizing · ${model}` }],
        details: {},
      });

      const r = await runTts({
        ep: endpointOf(cfgNow),
        key: apiKeyOf(cfgNow),
        outDir: outputDirOf(cfgNow),
        model,
        input: params.input,
        filename: params.filename,
        signal,
        modelNote: picked.note,
      });
      if (r.details.error)
        return toolError(
          r.text,
          stripErrorFlag(r.details),
          use(
            r.usageStatus != null
              ? { status: r.usageStatus as number }
              : undefined,
          ),
        );
      return toolOk(
        r.text,
        r.details,
        use({ bytes: r.details.bytes as number }),
      );
    },
    renderResult(result, { expanded }, theme) {
      const d = (result.details || {}) as { file?: string };
      return compactResult(
        "nr_tts",
        d.file ? basename(d.file) : "",
        theme,
        expanded,
        textFromResult(result),
      );
    },
  });
}

// ── Embed tool ──────────────────────────────────────────────────

function registerEmbedTool(pi: ExtensionAPI, cfg: ToolsConfigSlice) {
  const cap = CAPS.find((c) => c.id === "embed")!;
  pi.registerTool({
    name: cap.tool,
    label: "Embed",
    description: withModelHint(
      cfg,
      cap,
      "Create text embeddings through 9Router for RAG or similarity. Returns dimensions and a short preview by default. Set full=true only when full vector arrays are required.",
    ),
    promptSnippet: "Create text embeddings (9Router)",
    promptGuidelines: [
      "Call nr_embed for embeddings, vectors, similarity, or RAG chunk encoding.",
      "Pass one string, or several chunks separated by a line that is only --- .",
      "Omit model unless specified. Avoid full=true unless the user needs complete vectors.",
    ],
    parameters: Type.Object({
      input: Type.String({
        description: "Text to embed, or chunks split by a --- line",
      }),
      model: Type.Optional(
        Type.String({ description: "Embedding model id (optional)" }),
      ),
      dimensions: Type.Optional(
        Type.Integer({ description: "Vector size when supported", minimum: 1 }),
      ),
      full: Type.Optional(
        Type.Boolean({ description: "Return full vectors (default false)" }),
      ),
    }),
    async execute(_id, params, signal, onUpdate) {
      const cfgNow = loadRaw();
      const blocked = needCap(cfgNow, cap);
      if (blocked) {
        logUsage(gateUsageRec(cap.tool, blocked, params.model));
        return toolError(blocked);
      }
      const picked = resolveModel(cfgNow, cap, params.model);
      if (!picked.ok) {
        logUsage(gateUsageRec(cap.tool, picked.message, params.model));
        return toolError(picked.message, { requested: params.model });
      }
      const model = picked.id;
      const t0 = Date.now();
      const use = makeUsage(cap.tool, model, t0);

      const r = await runEmbed({
        ep: endpointOf(cfgNow),
        key: apiKeyOf(cfgNow),
        model,
        input: params.input,
        dimensions: params.dimensions,
        full: params.full,
        signal,
        onUpdate: (msg) =>
          onUpdate?.({ content: [{ type: "text", text: msg }], details: {} }),
      });
      if (r.error)
        return toolError(r.error, r.errorDetails ?? {}, use(r.usage));
      return toolOk(r.text ?? "", r.details ?? {}, use(r.usage));
    },
    renderResult(result, { expanded }, theme) {
      const d = (result.details || {}) as {
        count?: number;
        dimensions?: number;
        model?: string;
      };
      return compactResult(
        "nr_embed",
        `${d.count || "?"}×${d.dimensions || "?"} · ${d.model || ""}`,
        theme,
        expanded,
        textFromResult(result),
      );
    },
  });
}

// ── Web search tool ─────────────────────────────────────────────

function registerWebSearchTool(pi: ExtensionAPI, cfg: ToolsConfigSlice) {
  const cap = CAPS.find((c) => c.id === "web_search")!;
  pi.registerTool({
    name: cap.tool,
    label: "Search",
    description: withModelHint(
      cfg,
      cap,
      "Search the web through 9Router. Returns titles, URLs, and snippets. For full page text of a known URL, use nr_web_fetch.",
    ),
    promptSnippet: "Search the web (9Router)",
    promptGuidelines: [
      "Call nr_web_search for current web info, docs, news, or sources.",
      "Write a clear natural-language query. Omit model unless the user names a provider (e.g. exa/search).",
      "Optional: max_results (default 5), search_type (web|news), country, language, time_range (day|week|month|year), domain_filter (comma-separated domains).",
      "Follow up with nr_web_fetch on the best URLs when you need full page content.",
      "Do not use nr_web_search for local codebase questions.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "What to search for" }),
      model: Type.Optional(
        Type.String({ description: "Search model id (optional)" }),
      ),
      max_results: Type.Optional(
        Type.Integer({
          description: "Result count, 1–20 (default 5)",
          minimum: 1,
          maximum: 20,
        }),
      ),
      search_type: Type.Optional(
        Type.String({ description: "web or news when supported" }),
      ),
      country: Type.Optional(
        Type.String({ description: "Country bias when supported" }),
      ),
      language: Type.Optional(
        Type.String({ description: "Language bias when supported" }),
      ),
      time_range: Type.Optional(
        Type.String({
          description:
            "Restrict by recency when supported, e.g. day, week, month, year",
        }),
      ),
      domain_filter: Type.Optional(
        Type.String({
          description: "Comma-separated domains to restrict to, when supported",
        }),
      ),
    }),
    async execute(_id, params, signal, onUpdate) {
      const cfgNow = loadRaw();
      const blocked = needCap(cfgNow, cap);
      if (blocked) {
        logUsage(gateUsageRec(cap.tool, blocked, params.model));
        return toolError(blocked);
      }
      const picked = resolveModel(cfgNow, cap, params.model);
      if (!picked.ok) {
        logUsage(gateUsageRec(cap.tool, picked.message, params.model));
        return toolError(picked.message, { requested: params.model });
      }
      const model = picked.id;
      const t0 = Date.now();
      const use = makeUsage(cap.tool, model, t0);

      const r = await runWebSearch({
        ep: endpointOf(cfgNow),
        key: apiKeyOf(cfgNow),
        model,
        query: params.query,
        max_results: params.max_results,
        search_type: params.search_type,
        country: params.country,
        language: params.language,
        time_range: params.time_range,
        domain_filter: params.domain_filter,
        signal,
        onUpdate: (msg) =>
          onUpdate?.({ content: [{ type: "text", text: msg }], details: {} }),
      });
      if (r.error)
        return toolError(r.error, r.errorDetails ?? {}, use(r.usage));
      return toolOk(r.text ?? "", r.details ?? {}, use(r.usage));
    },
    renderResult(result, { expanded }, theme) {
      const d = (result.details || {}) as {
        query?: string;
        resultCount?: number;
      };
      return compactResult(
        "nr_web_search",
        `${d.resultCount ?? "?"} · ${d.query || ""}`,
        theme,
        expanded,
        textFromResult(result),
      );
    },
  });
}

// ── Web fetch tool ──────────────────────────────────────────────

function registerWebFetchTool(pi: ExtensionAPI, cfg: ToolsConfigSlice) {
  const cap = CAPS.find((c) => c.id === "web_fetch")!;
  pi.registerTool({
    name: cap.tool,
    label: "Fetch",
    description: withModelHint(
      cfg,
      cap,
      "Fetch a URL as markdown, text, or HTML through 9Router. Use when you already have a URL. For discovery, use nr_web_search first.",
    ),
    promptSnippet: "Fetch a URL as markdown (9Router)",
    promptGuidelines: [
      "Call nr_web_fetch for absolute http(s) URLs when you need page content.",
      "Default format is markdown. Use max_characters to cap long pages.",
      "Omit model unless the user names a fetch provider (e.g. exa/fetch).",
      "For local files use the read tool, not nr_web_fetch.",
    ],
    parameters: Type.Object({
      url: Type.String({ description: "Absolute http(s) URL to fetch" }),
      model: Type.Optional(
        Type.String({ description: "Fetch model id (optional)" }),
      ),
      format: Type.Optional(
        Type.String({
          description: "markdown, text, or html (default markdown)",
        }),
      ),
      max_characters: Type.Optional(
        Type.Integer({ description: "Max characters to return", minimum: 0 }),
      ),
    }),
    async execute(_id, params, signal, onUpdate) {
      const cfgNow = loadRaw();
      const blocked = needCap(cfgNow, cap);
      if (blocked) {
        logUsage(gateUsageRec(cap.tool, blocked, params.model));
        return toolError(blocked);
      }
      const picked = resolveModel(cfgNow, cap, params.model);
      if (!picked.ok) {
        logUsage(gateUsageRec(cap.tool, picked.message, params.model));
        return toolError(picked.message, { requested: params.model });
      }
      const model = picked.id;
      const t0 = Date.now();
      const use = makeUsage(cap.tool, model, t0);

      const r = await runWebFetch({
        ep: endpointOf(cfgNow),
        key: apiKeyOf(cfgNow),
        model,
        url: params.url,
        format: params.format,
        max_characters: params.max_characters,
        signal,
        onUpdate: (msg) =>
          onUpdate?.({ content: [{ type: "text", text: msg }], details: {} }),
      });
      if (r.error)
        return toolError(r.error, r.errorDetails ?? {}, use(r.usage));
      return toolOk(r.text ?? "", r.details ?? {}, use(r.usage));
    },
    renderResult(result, { expanded }, theme) {
      const d = (result.details || {}) as { url?: string; title?: string };
      return compactResult(
        "nr_web_fetch",
        d.title || d.url || "",
        theme,
        expanded,
        textFromResult(result),
      );
    },
  });
}

// ── Video tool ──────────────────────────────────────────────────

function registerVideoTool(pi: ExtensionAPI, cfg: ToolsConfigSlice) {
  const cap = CAPS.find((c) => c.id === "video")!;
  pi.registerTool({
    name: cap.tool,
    label: "Video",
    description: withModelHint(
      cfg,
      cap,
      "Generate a short video through 9Router (Grok Imagine) and save it as an MP4. Text-to-video, or image-to-video with an optional image_path reference. Generation is async — the tool polls until done (up to 10 minutes) and returns the saved file path. Expensive per generation; use deliberately, not for experiments.",
    ),
    promptSnippet: "Generate a video (9Router/Grok Imagine) and save the MP4",
    promptGuidelines: [
      "Call nr_video_generate only when the user explicitly asks for a video.",
      "Write a concrete prompt (subject, motion, style, scene). Optional duration (seconds), aspect_ratio, resolution, image_path for image-to-video. Omit model unless the user names a specific video model; when they do, pass its exact catalog id (browse via /9router-tools if unsure).",
      "Generation takes tens of seconds to minutes — set expectations, do not spam retries.",
      "Report the saved MP4 path when done.",
    ],
    parameters: Type.Object({
      prompt: Type.String({
        description: "Video description: subject, motion, style, scene",
      }),
      model: Type.Optional(
        Type.String({
          description: `Video model id (optional; default ${VIDEO_DEFAULT_MODEL})`,
        }),
      ),
      duration: Type.Optional(
        Type.Integer({
          description: "Length in seconds when supported",
          minimum: 1,
          maximum: 60,
        }),
      ),
      aspect_ratio: Type.Optional(
        Type.Union(
          ["16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3"].map((v) =>
            Type.Literal(v),
          ),
          { description: "Aspect ratio when supported" },
        ),
      ),
      resolution: Type.Optional(
        Type.Union(
          ["480p", "720p", "1080p"].map((v) => Type.Literal(v)),
          {
            description: "Resolution when supported",
          },
        ),
      ),
      image_path: Type.Optional(
        Type.String({
          description:
            "Local path (or data URL) of a reference image for image-to-video",
        }),
      ),
      filename: Type.Optional(
        Type.String({
          description: "Output file name only, no folders (.mp4 appended)",
        }),
      ),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const cfgNow = loadRaw();
      const blocked = needCap(cfgNow, cap);
      if (blocked) {
        logUsage(gateUsageRec(cap.tool, blocked, params.model));
        return toolError(blocked);
      }
      const picked = resolveModel(cfgNow, cap, params.model);
      if (!picked.ok) {
        logUsage(gateUsageRec(cap.tool, picked.message, params.model));
        return toolError(picked.message, { requested: params.model });
      }
      const model = picked.id;
      const t0 = Date.now();
      const use = makeUsage(cap.tool, model, t0);

      let imageUrl: string | undefined;
      if (params.image_path?.trim()) {
        imageUrl =
          (await loadImageRef(params.image_path, ctx.cwd)) ?? undefined;
        if (!imageUrl) {
          return toolError(
            `Could not read image_path: ${params.image_path}`,
            { image_path: params.image_path },
            use(),
          );
        }
      }

      const r = await runVideoGeneration({
        ep: endpointOf(cfgNow),
        key: apiKeyOf(cfgNow),
        outDir: outputDirOf(cfgNow),
        model,
        prompt: params.prompt,
        duration: params.duration,
        aspectRatio: params.aspect_ratio,
        resolution: params.resolution,
        imageUrl,
        filename: params.filename,
        signal,
        onUpdate: (msg) =>
          onUpdate?.({ content: [{ type: "text", text: msg }], details: {} }),
      });
      if (r.error)
        return toolError(r.error, r.errorDetails ?? {}, use(r.usage));
      return toolOk(r.text ?? "", r.details ?? {}, use(r.usage));
    },
    renderResult(result, { expanded }, theme) {
      const d = (result.details || {}) as {
        file?: string;
        request_id?: string;
      };
      return compactResult(
        "nr_video_generate",
        d.file || d.request_id || "",
        theme,
        expanded,
        textFromResult(result),
      );
    },
  });
}

// ── STT tool ────────────────────────────────────────────────────

function registerSttTool(pi: ExtensionAPI, cfg: ToolsConfigSlice) {
  const cap = CAPS.find((c) => c.id === "stt")!;
  pi.registerTool({
    name: cap.tool,
    label: "Transcribe",
    description: withModelHint(
      cfg,
      cap,
      "Transcribe an audio file (mp3/wav/m4a/webm/ogg/flac) through 9Router. Returns the transcript text; srt/vtt formats include timestamps. Off by default — enable in /9router-tools.",
    ),
    promptSnippet: "Transcribe an audio file (9Router)",
    promptGuidelines: [
      "Call nr_stt when the user wants an audio or video soundtrack file transcribed.",
      "Pass a local file path in file_path. Optional language hint and response_format (json default; srt/vtt for subtitles).",
      "Omit model unless the user names one.",
    ],
    parameters: Type.Object({
      file_path: Type.String({
        description:
          "Local path to the audio file (mp3, wav, m4a, webm, ogg, flac; ≤25 MB)",
      }),
      model: Type.Optional(
        Type.String({ description: "STT model id (optional)" }),
      ),
      language: Type.Optional(
        Type.String({ description: "ISO-639-1 language hint, e.g. en, vi" }),
      ),
      prompt: Type.Optional(
        Type.String({ description: "Hint text to guide transcription" }),
      ),
      response_format: Type.Optional(
        Type.Union(
          ["json", "text", "verbose_json", "srt", "vtt"].map((v) =>
            Type.Literal(v),
          ),
          { description: "Output format (default json)" },
        ),
      ),
      temperature: Type.Optional(
        Type.Number({
          description: "0–1 sampling temperature",
          minimum: 0,
          maximum: 1,
        }),
      ),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const cfgNow = loadRaw();
      const blocked = needCap(cfgNow, cap);
      if (blocked) {
        logUsage(gateUsageRec(cap.tool, blocked, params.model));
        return toolError(blocked);
      }
      const picked = resolveModel(cfgNow, cap, params.model);
      if (!picked.ok) {
        logUsage(gateUsageRec(cap.tool, picked.message, params.model));
        return toolError(picked.message, { requested: params.model });
      }
      const model = picked.id;
      const t0 = Date.now();
      const use = makeUsage(cap.tool, model, t0);

      const r = await runStt({
        ep: endpointOf(cfgNow),
        key: apiKeyOf(cfgNow),
        model,
        filePath: params.file_path,
        cwd: ctx.cwd || process.cwd(),
        language: params.language,
        prompt: params.prompt,
        responseFormat: params.response_format,
        temperature: params.temperature,
        modelNote: picked.note,
        signal,
        onUpdate: (msg) =>
          onUpdate?.({ content: [{ type: "text", text: msg }], details: {} }),
      });
      if (r.error)
        return toolError(r.error, r.errorDetails ?? {}, use(r.usage));
      return toolOk(r.text ?? "", r.details ?? {}, use(r.usage));
    },
    renderResult(result, { expanded }, theme) {
      const d = (result.details || {}) as { file?: string; chars?: number };
      return compactResult(
        "nr_stt",
        `${d.chars ?? "?"} chars · ${d.file ? basename(d.file) : ""}`,
        theme,
        expanded,
        textFromResult(result),
      );
    },
  });
}

// ── Registration entry ──────────────────────────────────────────

export function registerAllTools(
  pi: ExtensionAPI,
  cfg: ToolsConfigSlice,
): void {
  registerImageTool(pi, cfg);
  registerTtsTool(pi, cfg);
  registerVideoTool(pi, cfg);
  registerSttTool(pi, cfg);
  registerEmbedTool(pi, cfg);
  registerWebSearchTool(pi, cfg);
  registerWebFetchTool(pi, cfg);
}

// ── TUI ─────────────────────────────────────────────────────────

function capRow(cfg: ToolsConfigSlice, cap: CapDef): string {
  const st = getCapState(cfg, cap);
  const n = modelsForCap(cfg, cap).length;
  const status = st.enabled ? "On " : "Off";
  // An auto-picked billed default is marked — pin it via Default model.
  const auto = st.enabled && !st.model && isAutoRichDefault(cfg, cap);
  const picked = st.model || pickAutoDefaultModel(modelsForCap(cfg, cap))?.id;
  const model = st.enabled ? shortModel(picked) + (auto ? " (auto)" : "") : "—";
  return `${padLabel(cap.label, 18)}  ${status}  ${padLabel(model, 34)}  ${n ? n + " models" : "no models"}`;
}

async function pickModel(
  ui: ExtensionContext["ui"],
  cfg: ToolsConfigSlice,
  cap: CapDef,
): Promise<string | undefined> {
  const models = modelsForCap(cfg, cap);
  if (!models.length) {
    ui.notify(needSyncHintText(), "warning");
    return undefined;
  }
  const current = getCapState(cfg, cap).model;
  const items = models.map((m) => {
    const star = m.id === current ? "* " : "  ";
    const name = m.name && m.name !== m.id ? `  ${m.name}` : "";
    const params = m.params?.length ? `  [${m.params.join(",")}]` : "";
    return `${star}${m.id}${name}${params}`;
  });
  items.push("Use first available (clear default)");
  items.push("Back");
  const pick = await ui.select(`${cap.label} — default model`, items);
  if (!pick || pick === "Back") return undefined;
  if (pick.startsWith("Use first")) return "";
  return pick
    .replace(/^\*\s/, "")
    .replace(/^\s\s/, "")
    .split(/\s{2,}/)[0]
    .trim();
}

async function configureCap(
  pi: ExtensionAPI,
  ui: ExtensionContext["ui"],
  cfg: ToolsConfigSlice,
  cap: CapDef,
): Promise<ToolsConfigSlice> {
  while (true) {
    const st = getCapState(cfg, cap);
    const n = modelsForCap(cfg, cap).length;
    const def =
      st.model ||
      (n ? pickAutoDefaultModel(modelsForCap(cfg, cap))?.id : undefined);
    const auto = !st.model && isAutoRichDefault(cfg, cap);
    const choice = await ui.select(cap.label, [
      st.enabled ? "Turn off" : "Turn on",
      `Default model: ${shortModel(def, 48)}${auto ? " (auto)" : ""}`,
      "Browse models",
      "Back",
    ]);
    if (!choice || choice === "Back") return cfg;

    if (choice === "Turn on" || choice === "Turn off") {
      const enabled = choice === "Turn on";
      cfg = saveRaw({
        capabilities: { [cap.id]: { ...getCapState(cfg, cap), enabled } },
      });
      applyToolActivation(pi, cfg);
      ui.notify(`${cap.label}: ${enabled ? "on" : "off"}`, "info");
      continue;
    }

    if (choice.startsWith("Default model")) {
      const model = await pickModel(ui, cfg, cap);
      if (model === undefined) continue;
      cfg = saveRaw({
        capabilities: {
          [cap.id]: { ...getCapState(cfg, cap), model: model || undefined },
        },
      });
      // Descriptions bake in the default model — re-register so they stay true.
      registerAllTools(pi, cfg);
      applyToolActivation(pi, cfg);
      ui.notify(
        model ? `Default: ${model}` : "Default cleared (use first available)",
        "info",
      );
      continue;
    }

    if (choice === "Browse models") {
      const models = modelsForCap(cfg, cap);
      if (!models.length) {
        ui.notify(needSyncHintText(), "warning");
        continue;
      }
      const text = models
        .map((m, i) => {
          const p = m.params?.length ? `  params: ${m.params.join(", ")}` : "";
          return `${String(i + 1).padStart(2)}. ${m.id}${m.name && m.name !== m.id ? `  (${m.name})` : ""}${p}`;
        })
        .join("\n");
      await ui.confirm(`${cap.label} (${models.length})`, text);
    }
  }
}

async function showStatus(
  ui: ExtensionContext["ui"],
  cfg: ToolsConfigSlice,
): Promise<void> {
  const on = CAPS.filter((c) => getCapState(cfg, c).enabled).length;
  const stale = isSyncStale(cfg.lastSync);
  const lines = [
    `Endpoint     ${endpointOf(cfg)}`,
    `Catalog      ${cfg.lastSync ? new Date(cfg.lastSync).toLocaleString() : "never synced"}${cfg.lastSyncMode ? ` (${cfg.lastSyncMode})` : ""}${stale ? "  ⚠ stale" : ""}`,
    `Output       ${outputDirOf(cfg)}`,
    `Inline image ${shouldAttachImage(cfg) ? "on (base64 in tool result)" : "off — path only"}`,
    `Tools on     ${on} / ${CAPS.length}`,
    `Config       ${CONFIG_PATH}`,
    "",
    ...CAPS.map((cap) => {
      const st = getCapState(cfg, cap);
      const n = modelsForCap(cfg, cap).length;
      // Status must name the model that actually runs (auto pick),
      // marked so a billed auto default is never silent.
      const auto = !st.model && isAutoRichDefault(cfg, cap);
      const picked =
        st.model || pickAutoDefaultModel(modelsForCap(cfg, cap))?.id;
      return `${st.enabled ? "ON " : "off"}  ${padLabel(cap.tool, 18)}  ${shortModel(picked, 40)}${auto ? " (auto)" : ""}  (${n})`;
    }),
  ];
  await ui.confirm("Status", lines.join("\n"));
}

async function runToolsUI(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<void> {
  const ui = ctx.ui;
  let cfg = loadRaw();

  while (true) {
    const stale = isSyncStale(cfg.lastSync);
    const header = cfg.catalog?.length
      ? `Synced · ${Object.entries(cfg.counts || {})
          .map(([k, v]) => `${k} ${v}`)
          .join(" · ")}${stale ? " · ⚠ stale" : ""}`
      : "Catalog empty — run /9router → Sync models";

    const rows = CAPS.map((c) => capRow(cfg, c));
    const attLabel = `Inline generated images: ${shouldAttachImage(cfg) ? "on" : "off (recommended)"}`;
    const menu = [
      ...rows,
      "─".repeat(48),
      attLabel,
      "Output folder",
      "Status",
      "Close",
    ];

    const choice = await ui.select(`9Router Tools\n${header}`, menu);
    if (!choice || choice === "Close") break;
    if (choice.startsWith("─")) continue;

    if (choice.startsWith("Inline generated images")) {
      const pick = await ui.select(
        "Embed generated images in the conversation?",
        [
          "Off — return the file path only (recommended)",
          "On — embed base64 in the tool result",
          "Back",
        ],
      );
      if (!pick || pick === "Back") continue;
      const on = pick.startsWith("On");
      cfg = saveRaw({ attachImages: on });
      ui.notify(
        on
          ? "Images embedded — large generations can exceed the chat model's context"
          : "Images saved to disk; pi reads the file when the model supports it",
        on ? "warning" : "info",
      );
      continue;
    }

    if (choice === "Output folder") {
      const next = await ui.input(
        "Folder for generated images/audio",
        outputDirOf(cfg),
      );
      if (next?.trim()) {
        cfg = saveRaw({ outputDir: next.trim() });
        ui.notify("Output folder saved", "info");
      }
      continue;
    }

    if (choice === "Status") {
      await showStatus(ui, cfg);
      continue;
    }

    const cap = CAPS.find(
      (c) =>
        choice.startsWith(padLabel(c.label, 18)) || choice.includes(c.label),
    );
    if (cap) cfg = await configureCap(pi, ui, cfg, cap);
  }
}

export async function runNineRouterToolsUI(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<void> {
  return runToolsUI(pi, ctx);
}

// ── Local glue helpers ──────────────────────────────────────────

function makeUsage(tool: string, model: string, t0: number) {
  return (extra?: { status?: number; bytes?: number; count?: number }) => ({
    tool,
    model,
    t0,
    ...extra,
  });
}

function stripErrorFlag(
  details: Record<string, unknown>,
): Record<string, unknown> {
  const rest = { ...details };
  delete rest.error;
  return rest;
}

import { readFile, stat as statFile } from "node:fs/promises";
import { needSyncHint as needSyncHintText } from "./toolkit.ts";
