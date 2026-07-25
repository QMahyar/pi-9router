/**
 * pi-9router-tools — Capability tools for 9Router (companion to 9router.ts)
 *
 * Depends on the core 9router extension config/catalog at:
 *   ~/.pi/agent/9router.json
 *
 * Tools (toggle individually via /9router-tools):
 *   nr_image_generate  — text-to-image   POST /v1/images/generations
 *   nr_tts             — text-to-speech  POST /v1/audio/speech
 *   nr_stt             — speech-to-text  POST /v1/audio/transcriptions
 *   nr_embed           — embeddings      POST /v1/embeddings
 *   nr_web_search      — web search      POST /v1/search
 *   nr_web_fetch       — URL → markdown  POST /v1/web/fetch
 *
 * Video is reserved (not offered by current 9Router public models API).
 *
 * /9router-tools — TUI: enable/disable each capability, pick default models,
 *                  set output directory, list available models from catalog.
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
	statSync,
} from "node:fs";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

// ── Shared config (same file as core 9router extension) ─────────

const CONFIG_PATH = join(homedir(), ".pi", "agent", "9router.json");
const DEFAULT_ENDPOINT = "http://localhost:20128";
const DEFAULT_OUTPUT_DIR = join(homedir(), ".pi", "agent", "9router-output");

type CapId = "image" | "tts" | "stt" | "embed" | "web_search" | "web_fetch";

interface CatalogEntry {
	id: string;
	name?: string;
	kind: string;
	ownedBy?: string;
	capabilities?: unknown;
	params?: string[];
}

interface CapState {
	enabled: boolean;
	/** Default model id from catalog */
	model?: string;
}

interface ToolsConfigSlice {
	endpoint?: string;
	apiKey?: string;
	catalog?: CatalogEntry[];
	counts?: Record<string, number>;
	lastSync?: string;
	/** Per-capability enable + default model */
	capabilities?: Partial<Record<CapId, CapState>>;
	/** Where generated files are written */
	outputDir?: string;
}

interface CapDef {
	id: CapId;
	/** Tool name exposed to the LLM */
	tool: string;
	label: string;
	icon: string;
	/** Catalog kind filter */
	catalogKind: string | ((e: CatalogEntry) => boolean);
	description: string;
	defaultEnabled: boolean;
}

const CAPS: CapDef[] = [
	{
		id: "image",
		tool: "nr_image_generate",
		label: "Text to Image",
		icon: "brush",
		catalogKind: "image",
		description: "Generate images via 9Router /v1/images/generations",
		defaultEnabled: true,
	},
	{
		id: "tts",
		tool: "nr_tts",
		label: "Text to Speech",
		icon: "record_voice_over",
		catalogKind: "tts",
		description: "Synthesize speech via 9Router /v1/audio/speech",
		defaultEnabled: true,
	},
	{
		id: "stt",
		tool: "nr_stt",
		label: "Speech to Text",
		icon: "mic",
		catalogKind: "stt",
		description: "Transcribe audio via 9Router /v1/audio/transcriptions",
		defaultEnabled: true,
	},
	{
		id: "embed",
		tool: "nr_embed",
		label: "Embeddings",
		icon: "data_array",
		catalogKind: "embedding",
		description: "Create vectors via 9Router /v1/embeddings",
		defaultEnabled: false,
	},
	{
		id: "web_search",
		tool: "nr_web_search",
		label: "Web Search",
		icon: "travel_explore",
		catalogKind: (e) =>
			e.kind === "web" &&
			(e.id.endsWith("/search") ||
				e.id.includes("search") ||
				String((e as any).kind) === "webSearch"),
		description: "Search the web via 9Router /v1/search",
		defaultEnabled: true,
	},
	{
		id: "web_fetch",
		tool: "nr_web_fetch",
		label: "Web Fetch",
		icon: "language",
		catalogKind: (e) =>
			e.kind === "web" &&
			(e.id.endsWith("/fetch") ||
				e.id.includes("fetch") ||
				String((e as any).kind) === "webFetch"),
		description: "Fetch URL → markdown via 9Router /v1/web/fetch",
		defaultEnabled: true,
	},
];

const TOOL_NAMES = CAPS.map((c) => c.tool);

// ── Config helpers ──────────────────────────────────────────────

function loadRaw(): ToolsConfigSlice {
	if (!existsSync(CONFIG_PATH)) return {};
	try {
		return JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as ToolsConfigSlice;
	} catch {
		return {};
	}
}

function saveRaw(patch: Partial<ToolsConfigSlice>): ToolsConfigSlice {
	const dir = dirname(CONFIG_PATH);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	const cur = loadRaw();
	const next = { ...cur, ...patch };
	// deep-merge capabilities
	if (patch.capabilities) {
		next.capabilities = { ...(cur.capabilities || {}), ...patch.capabilities };
	}
	writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2));
	return next;
}

function endpointOf(cfg: ToolsConfigSlice): string {
	return (cfg.endpoint || process.env.NINEROUTER_URL || DEFAULT_ENDPOINT).replace(/\/$/, "");
}

function apiKeyOf(cfg: ToolsConfigSlice): string {
	return (cfg.apiKey || process.env.NINEROUTER_KEY || "9router").trim();
}

function outputDirOf(cfg: ToolsConfigSlice): string {
	return cfg.outputDir || DEFAULT_OUTPUT_DIR;
}

function defaultCapState(cap: CapDef): CapState {
	return { enabled: cap.defaultEnabled };
}

function getCapState(cfg: ToolsConfigSlice, cap: CapDef): CapState {
	return { ...defaultCapState(cap), ...(cfg.capabilities?.[cap.id] || {}) };
}

function modelsForCap(cfg: ToolsConfigSlice, cap: CapDef): CatalogEntry[] {
	const catalog = cfg.catalog || [];
	const filter = cap.catalogKind;
	if (typeof filter === "function") return catalog.filter(filter);
	return catalog.filter((e) => e.kind === filter);
}

function resolveModel(cfg: ToolsConfigSlice, cap: CapDef, override?: string): string | null {
	if (override?.trim()) return override.trim();
	const state = getCapState(cfg, cap);
	if (state.model?.trim()) return state.model.trim();
	const list = modelsForCap(cfg, cap);
	return list[0]?.id || null;
}

// ── HTTP ────────────────────────────────────────────────────────

function authHeaders(apiKey: string, json = true): Record<string, string> {
	const h: Record<string, string> = {};
	if (json) h["Content-Type"] = "application/json";
	h.Accept = "*/*";
	if (apiKey) h.Authorization = `Bearer ${apiKey}`;
	return h;
}

async function postJson(
	url: string,
	apiKey: string,
	body: unknown,
	signal?: AbortSignal,
): Promise<{ ok: true; status: number; data: any } | { ok: false; status: number; error: string }> {
	try {
		const res = await fetch(url, {
			method: "POST",
			headers: authHeaders(apiKey, true),
			body: JSON.stringify(body),
			signal,
		});
		const text = await res.text();
		let data: any = null;
		try {
			data = text ? JSON.parse(text) : null;
		} catch {
			data = text;
		}
		if (!res.ok) {
			const msg =
				typeof data === "string"
					? data.slice(0, 400)
					: data?.error?.message || data?.message || JSON.stringify(data).slice(0, 400);
			return { ok: false, status: res.status, error: msg || res.statusText };
		}
		return { ok: true, status: res.status, data };
	} catch (err: any) {
		if (err?.name === "AbortError") return { ok: false, status: 0, error: "aborted" };
		return { ok: false, status: 0, error: err?.message || String(err) };
	}
}

async function postBinary(
	url: string,
	apiKey: string,
	body: unknown,
	signal?: AbortSignal,
): Promise<
	| { ok: true; status: number; bytes: Uint8Array; contentType: string }
	| { ok: false; status: number; error: string }
> {
	try {
		const res = await fetch(url, {
			method: "POST",
			headers: authHeaders(apiKey, true),
			body: JSON.stringify(body),
			signal,
		});
		if (!res.ok) {
			const text = (await res.text()).slice(0, 400);
			return { ok: false, status: res.status, error: text || res.statusText };
		}
		const buf = new Uint8Array(await res.arrayBuffer());
		const contentType = res.headers.get("content-type") || "application/octet-stream";
		return { ok: true, status: res.status, bytes: buf, contentType };
	} catch (err: any) {
		if (err?.name === "AbortError") return { ok: false, status: 0, error: "aborted" };
		return { ok: false, status: 0, error: err?.message || String(err) };
	}
}

async function postMultipart(
	url: string,
	apiKey: string,
	form: FormData,
	signal?: AbortSignal,
): Promise<{ ok: true; data: any } | { ok: false; status: number; error: string }> {
	try {
		const headers: Record<string, string> = {};
		if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
		// let fetch set multipart boundary
		const res = await fetch(url, { method: "POST", headers, body: form, signal });
		const text = await res.text();
		let data: any = text;
		try {
			data = text ? JSON.parse(text) : null;
		} catch {
			/* keep text */
		}
		if (!res.ok) {
			const msg =
				typeof data === "string"
					? data.slice(0, 400)
					: data?.error?.message || JSON.stringify(data).slice(0, 400);
			return { ok: false, status: res.status, error: msg || res.statusText };
		}
		return { ok: true, data };
	} catch (err: any) {
		if (err?.name === "AbortError") return { ok: false, status: 0, error: "aborted" };
		return { ok: false, status: 0, error: err?.message || String(err) };
	}
}

// ── File helpers ────────────────────────────────────────────────

function ensureDir(dir: string) {
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function slug(s: string, max = 40): string {
	return (
		s
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "")
			.slice(0, max) || "out"
	);
}

function stamp(): string {
	const d = new Date();
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function writeBytes(dir: string, name: string, bytes: Uint8Array): string {
	ensureDir(dir);
	const path = join(dir, name);
	writeFileSync(path, bytes);
	return path;
}

function extFromContentType(ct: string, fallback: string): string {
	const c = ct.toLowerCase();
	if (c.includes("png")) return ".png";
	if (c.includes("jpeg") || c.includes("jpg")) return ".jpg";
	if (c.includes("webp")) return ".webp";
	if (c.includes("gif")) return ".gif";
	if (c.includes("mp3") || c.includes("mpeg")) return ".mp3";
	if (c.includes("wav")) return ".wav";
	if (c.includes("ogg")) return ".ogg";
	if (c.includes("webm")) return ".webm";
	if (c.includes("mp4")) return ".mp4";
	return fallback;
}

function decodeDataUrlOrB64(raw: string): { bytes: Uint8Array; ext: string } | null {
	const m = raw.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i);
	if (m) {
		return {
			bytes: Buffer.from(m[2], "base64"),
			ext: extFromContentType(m[1], ".png"),
		};
	}
	// bare base64
	try {
		const bytes = Buffer.from(raw, "base64");
		if (bytes.length < 32) return null;
		// sniff
		let ext = ".png";
		if (bytes[0] === 0xff && bytes[1] === 0xd8) ext = ".jpg";
		else if (bytes[0] === 0x89 && bytes[1] === 0x50) ext = ".png";
		else if (bytes[0] === 0x52 && bytes[1] === 0x49) ext = ".webp";
		return { bytes, ext };
	} catch {
		return null;
	}
}

async function downloadUrl(
	url: string,
	signal?: AbortSignal,
): Promise<{ bytes: Uint8Array; contentType: string } | null> {
	try {
		const res = await fetch(url, { signal });
		if (!res.ok) return null;
		return {
			bytes: new Uint8Array(await res.arrayBuffer()),
			contentType: res.headers.get("content-type") || "application/octet-stream",
		};
	} catch {
		return null;
	}
}

function resolveUserPath(p: string, cwd?: string): string {
	if (p.startsWith("@")) p = p.slice(1);
	if (p.startsWith("~")) p = join(homedir(), p.slice(1));
	if (!isAbsolute(p)) p = resolve(cwd || process.cwd(), p);
	return p;
}

function toolError(message: string, details: Record<string, unknown> = {}) {
	return {
		content: [{ type: "text" as const, text: message }],
		details,
		isError: true as const,
	};
}

function toolOk(text: string, details: Record<string, unknown> = {}) {
	return {
		content: [{ type: "text" as const, text }],
		details,
	};
}

function needSyncHint(): string {
	return "No 9Router catalog found. Run /9router → Fetch all & register chat models first.";
}

function needCap(cfg: ToolsConfigSlice, cap: CapDef): string | null {
	const state = getCapState(cfg, cap);
	if (!state.enabled) {
		return `${cap.label} is disabled. Enable it with /9router-tools.`;
	}
	if (!cfg.catalog?.length) return needSyncHint();
	return null;
}

// ── Active-tools management ─────────────────────────────────────

/**
 * Toggle only our nr_* tools on/off without clobbering other tools.
 * Always re-reads the current active set so we don't fight /tools or presets.
 */
function applyToolActivation(pi: ExtensionAPI, cfg: ToolsConfigSlice): void {
	const active = new Set(pi.getActiveTools());
	const allKnown = new Set(pi.getAllTools().map((t) => t.name));

	for (const cap of CAPS) {
		if (!allKnown.has(cap.tool)) continue;
		const enabled = getCapState(cfg, cap).enabled;
		if (enabled) active.add(cap.tool);
		else active.delete(cap.tool);
	}
	pi.setActiveTools([...active]);
}

// ── Render helpers ──────────────────────────────────────────────

function compactResult(title: string, detail: string, theme: Theme, expanded: boolean, full: string): Text {
	if (!expanded) {
		return new Text(
			theme.fg("toolTitle", title) + (detail ? theme.fg("dim", ` · ${truncateToWidth(detail, 60)}`) : ""),
			0,
			0,
		);
	}
	return new Text(full || detail || title, 0, 0);
}

// ── TUI ─────────────────────────────────────────────────────────

async function pickModel(
	ui: ExtensionContext["ui"],
	cfg: ToolsConfigSlice,
	cap: CapDef,
): Promise<string | undefined> {
	const models = modelsForCap(cfg, cap);
	if (!models.length) {
		ui.notify(`No ${cap.label} models in catalog. Run /9router sync first.`, "warning");
		return undefined;
	}
	const current = getCapState(cfg, cap).model;
	const items = models.map((m) => {
		const mark = m.id === current ? "★ " : "  ";
		return `${mark}${m.id}${m.name && m.name !== m.id ? ` — ${m.name}` : ""}`;
	});
	items.push("← Clear default (use first available)");
	items.push("← Back");
	const pick = await ui.select(`${cap.icon} ${cap.label} — default model`, items);
	if (!pick || pick === "← Back") return undefined;
	if (pick.startsWith("← Clear")) return "";
	return pick.replace(/^★\s*/, "").replace(/^\s\s/, "").split(" — ")[0].trim();
}

async function runToolsUI(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	const ui = ctx.ui;
	let cfg = loadRaw();

	while (true) {
		const lines = CAPS.map((cap) => {
			const st = getCapState(cfg, cap);
			const n = modelsForCap(cfg, cap).length;
			const on = st.enabled ? "ON " : "off";
			const model = st.model || (n ? `(auto: ${modelsForCap(cfg, cap)[0]?.id})` : "(no models)");
			return `${st.enabled ? "☑" : "☐"} ${cap.icon} ${cap.label}  [${on}]  ${n} models  ·  ${model}`;
		});

		const menu = [
			...lines,
			"────────────",
			"📁 Set output directory",
			"📋 Status",
			"🔄 Refresh tool activation",
			"Done",
		];

		const choice = await ui.select("9Router Tools", menu);
		if (!choice || choice === "Done") break;

		if (choice.startsWith("📁")) {
			const next = await ui.input("Output directory for generated files", outputDirOf(cfg));
			if (next?.trim()) {
				cfg = saveRaw({ outputDir: next.trim() });
				ui.notify(`Output dir: ${cfg.outputDir}`, "info");
			}
			continue;
		}

		if (choice.startsWith("📋")) {
			const st = [
				`Endpoint: ${endpointOf(cfg)}`,
				`Last catalog sync: ${cfg.lastSync || "never"}`,
				`Output dir: ${outputDirOf(cfg)}`,
				`Config: ${CONFIG_PATH}`,
				"",
				...CAPS.map((cap) => {
					const s = getCapState(cfg, cap);
					const n = modelsForCap(cfg, cap).length;
					return `${s.enabled ? "ON " : "off"}  ${cap.tool.padEnd(18)} ${cap.label}  models=${n}  default=${s.model || "auto"}`;
				}),
				"",
				"Tip: run /9router first to refresh the model catalog.",
			].join("\n");
			await ui.confirm("9Router Tools status", st + "\n\n(OK to close)");
			continue;
		}

		if (choice.startsWith("🔄")) {
			applyToolActivation(pi, cfg);
			ui.notify("Tool activation refreshed", "info");
			continue;
		}

		// Match a capability row
		const cap = CAPS.find(
			(c) => choice.includes(c.label) || choice.includes(c.icon) || choice.includes(c.tool),
		);
		if (!cap) continue;

		const st = getCapState(cfg, cap);
		const n = modelsForCap(cfg, cap).length;
		const action = await ui.select(`${cap.icon} ${cap.label}`, [
			st.enabled ? "Disable" : "Enable",
			`Set default model  (current: ${st.model || "auto"} · ${n} available)`,
			"List models",
			"← Back",
		]);
		if (!action || action === "← Back") continue;

		if (action === "Enable" || action === "Disable") {
			const enabled = action === "Enable";
			cfg = saveRaw({
				capabilities: {
					[cap.id]: { ...getCapState(cfg, cap), enabled },
				},
			});
			applyToolActivation(pi, cfg);
			ui.notify(`${cap.label} ${enabled ? "enabled" : "disabled"}`, "info");
			continue;
		}

		if (action.startsWith("Set default model")) {
			const model = await pickModel(ui, cfg, cap);
			if (model === undefined) continue;
			cfg = saveRaw({
				capabilities: {
					[cap.id]: {
						...getCapState(cfg, cap),
						model: model || undefined,
					},
				},
			});
			ui.notify(model ? `Default ${cap.label} model: ${model}` : `Default ${cap.label} model cleared`, "info");
			continue;
		}

		if (action === "List models") {
			const models = modelsForCap(cfg, cap);
			if (!models.length) {
				ui.notify(needSyncHint(), "warning");
				continue;
			}
			const text = models.map((m, i) => `${i + 1}. ${m.id}${m.name ? ` — ${m.name}` : ""}`).join("\n");
			await ui.confirm(`${cap.label} models (${models.length})`, text + "\n\n(OK to close)");
		}
	}
}

// ── Tool implementations ────────────────────────────────────────

function registerImageTool(pi: ExtensionAPI) {
	const cap = CAPS.find((c) => c.id === "image")!;
	pi.registerTool({
		name: cap.tool,
		label: cap.label,
		description:
			"Generate an image with 9Router (DALL·E, Imagen, FLUX, Gemini image, …). Saves the file under the configured output directory and returns the path. Use for icons, illustrations, mockups, symbols, concept art.",
		promptSnippet: "Generate images / icons / illustrations via 9Router",
		promptGuidelines: [
			"Use nr_image_generate when the user asks to generate, draw, render, or create an image, icon, logo, symbol, or illustration.",
			"Prefer a clear, detailed prompt. Pass model only to override the default set in /9router-tools.",
		],
		parameters: Type.Object({
			prompt: Type.String({ description: "Image description / generation prompt" }),
			model: Type.Optional(Type.String({ description: "Image model id from 9Router catalog (optional)" })),
			size: Type.Optional(
				Type.String({
					description: "Size when supported (e.g. 1024x1024, 1792x1024). Some providers ignore this.",
				}),
			),
			n: Type.Optional(Type.Integer({ description: "Number of images (default 1)", minimum: 1, maximum: 4 })),
			quality: Type.Optional(Type.String({ description: "standard | hd (OpenAI-style providers)" })),
			filename: Type.Optional(Type.String({ description: "Optional output filename (no path)" })),
		}),
		async execute(_id, params, signal, onUpdate, ctx) {
			const cfg = loadRaw();
			const blocked = needCap(cfg, cap);
			if (blocked) return toolError(blocked);

			const model = resolveModel(cfg, cap, params.model);
			if (!model) return toolError(`No image model available. Sync with /9router and set a default in /9router-tools.`);

			const ep = endpointOf(cfg);
			const key = apiKeyOf(cfg);
			const outDir = outputDirOf(cfg);
			const n = Math.min(params.n ?? 1, 4);

			onUpdate?.({ content: [{ type: "text", text: `Generating image with ${model}…` }] });

			// Prefer binary for easy file save; fall back to JSON
			const body: Record<string, unknown> = {
				model,
				prompt: params.prompt,
				n,
			};
			if (params.size) body.size = params.size;
			if (params.quality) body.quality = params.quality;

			const saved: string[] = [];
			const binaryUrl = `${ep}/v1/images/generations?response_format=binary`;
			const bin = await postBinary(binaryUrl, key, { ...body, n: 1 }, signal);

			if (bin.ok && bin.bytes.length > 100) {
				const ext = extFromContentType(bin.contentType, ".png");
				const name =
					params.filename?.replace(/[^\w.\-]+/g, "_") ||
					`img-${stamp()}-${slug(params.prompt)}-${randomBytes(2).toString("hex")}${ext}`;
				saved.push(writeBytes(outDir, name, bin.bytes));
				// additional images via JSON if n>1
				if (n > 1) {
					const multi = await postJson(`${ep}/v1/images/generations`, key, { ...body, response_format: "b64_json", n }, signal);
					if (multi.ok && Array.isArray(multi.data?.data)) {
						for (let i = 0; i < multi.data.data.length; i++) {
							const item = multi.data.data[i];
							if (item.b64_json) {
								const dec = decodeDataUrlOrB64(item.b64_json);
								if (dec) {
									const nm = `img-${stamp()}-${i}${dec.ext}`;
									const p = writeBytes(outDir, nm, dec.bytes);
									if (!saved.includes(p)) saved.push(p);
								}
							}
						}
					}
				}
			} else {
				// JSON path
				const res = await postJson(
					`${ep}/v1/images/generations`,
					key,
					{ ...body, response_format: "b64_json" },
					signal,
				);
				if (!res.ok) {
					// last try: url format
					const res2 = await postJson(`${ep}/v1/images/generations`, key, { ...body, response_format: "url" }, signal);
					if (!res2.ok) return toolError(`Image generation failed (${res2.status}): ${res2.error}`, { model });
					const items = res2.data?.data || [];
					for (let i = 0; i < items.length; i++) {
						const url = items[i].url;
						if (!url) continue;
						const dl = await downloadUrl(url, signal);
						if (!dl) continue;
						const ext = extFromContentType(dl.contentType, ".png");
						const nm =
							params.filename?.replace(/[^\w.\-]+/g, "_") ||
							`img-${stamp()}-${i}${ext}`;
						saved.push(writeBytes(outDir, nm, dl.bytes));
					}
				} else {
					const items = res.data?.data || [];
					for (let i = 0; i < items.length; i++) {
						const b64 = items[i].b64_json;
						if (!b64) continue;
						const dec = decodeDataUrlOrB64(b64);
						if (!dec) continue;
						const nm =
							params.filename?.replace(/[^\w.\-]+/g, "_") ||
							`img-${stamp()}-${i}${dec.ext}`;
						saved.push(writeBytes(outDir, nm, dec.bytes));
					}
				}
			}

			if (!saved.length) return toolError("Image generation returned no image data.", { model });

			const text = [
				`Generated ${saved.length} image(s) with ${model}`,
				`Prompt: ${params.prompt}`,
				...saved.map((p) => `File: ${p}`),
			].join("\n");

			// Include first image as base64 for multimodal follow-up when small enough
			const content: Array<{ type: "text"; text: string } | { type: "image"; source: { type: "base64"; mediaType: string; data: string } }> = [
				{ type: "text", text },
			];
			try {
				const first = saved[0];
				const st = statSync(first);
				if (st.size > 0 && st.size < 4_000_000) {
					const bytes = readFileSync(first);
					const ext = extname(first).toLowerCase();
					const mediaType =
						ext === ".jpg" || ext === ".jpeg"
							? "image/jpeg"
							: ext === ".webp"
								? "image/webp"
								: "image/png";
					content.push({
						type: "image",
						source: { type: "base64", mediaType, data: bytes.toString("base64") },
					});
				}
			} catch {
				/* skip inline */
			}

			return {
				content,
				details: { model, files: saved, prompt: params.prompt, cwd: ctx.cwd },
			};
		},
		renderResult(result, { expanded }, theme) {
			const d = (result.details || {}) as { files?: string[]; model?: string };
			const files = d.files || [];
			const full =
				result.content
					?.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map((c) => c.text)
					.join("\n") || "";
			return compactResult(
				"nr_image_generate",
				`${files.length} file(s)${d.model ? ` · ${d.model}` : ""}`,
				theme,
				expanded,
				full,
			);
		},
	});
}

function registerTtsTool(pi: ExtensionAPI) {
	const cap = CAPS.find((c) => c.id === "tts")!;
	pi.registerTool({
		name: cap.tool,
		label: cap.label,
		description:
			"Convert text to speech with 9Router (OpenAI / Gemini / Edge / ElevenLabs / …). Saves an audio file and returns its path.",
		promptSnippet: "Text-to-speech via 9Router",
		promptGuidelines: [
			"Use nr_tts when the user wants speech, voiceover, narration, or audio from text.",
		],
		parameters: Type.Object({
			input: Type.String({ description: "Text to speak" }),
			model: Type.Optional(Type.String({ description: "TTS model / voice id from catalog" })),
			filename: Type.Optional(Type.String({ description: "Optional output filename" })),
		}),
		async execute(_id, params, signal, onUpdate) {
			const cfg = loadRaw();
			const blocked = needCap(cfg, cap);
			if (blocked) return toolError(blocked);
			const model = resolveModel(cfg, cap, params.model);
			if (!model) return toolError("No TTS model available. Sync /9router and set default in /9router-tools.");

			onUpdate?.({ content: [{ type: "text", text: `Synthesizing speech with ${model}…` }] });

			const ep = endpointOf(cfg);
			const key = apiKeyOf(cfg);
			const outDir = outputDirOf(cfg);

			// Prefer JSON with base64 for portability; binary also works
			const jsonUrl = `${ep}/v1/audio/speech?response_format=json`;
			const res = await postJson(jsonUrl, key, { model, input: params.input }, signal);

			let bytes: Uint8Array | null = null;
			let ext = ".mp3";

			if (res.ok && res.data?.audio) {
				bytes = Buffer.from(res.data.audio, "base64");
				if (res.data.format) ext = `.${String(res.data.format).replace(/^\./, "")}`;
			} else {
				const bin = await postBinary(`${ep}/v1/audio/speech`, key, { model, input: params.input }, signal);
				if (!bin.ok) return toolError(`TTS failed (${bin.status}): ${bin.error}`, { model });
				bytes = bin.bytes;
				ext = extFromContentType(bin.contentType, ".mp3");
			}

			if (!bytes?.length) return toolError("TTS returned empty audio.", { model });

			const name =
				params.filename?.replace(/[^\w.\-]+/g, "_") ||
				`tts-${stamp()}-${slug(params.input)}${ext}`;
			const path = writeBytes(outDir, name, bytes);

			return toolOk(`Speech saved.\nModel: ${model}\nFile: ${path}\nChars: ${params.input.length}`, {
				model,
				file: path,
				bytes: bytes.length,
			});
		},
		renderResult(result, { expanded }, theme) {
			const d = (result.details || {}) as { file?: string; model?: string };
			const full =
				result.content
					?.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map((c) => c.text)
					.join("\n") || "";
			return compactResult("nr_tts", d.file ? basename(d.file) : d.model || "", theme, expanded, full);
		},
	});
}

function registerSttTool(pi: ExtensionAPI) {
	const cap = CAPS.find((c) => c.id === "stt")!;
	pi.registerTool({
		name: cap.tool,
		label: cap.label,
		description:
			"Transcribe an audio file with 9Router (Whisper, Groq, Gemini, Deepgram, …). Pass a local file path.",
		promptSnippet: "Speech-to-text / transcription via 9Router",
		promptGuidelines: [
			"Use nr_stt when the user wants to transcribe or convert speech/audio to text.",
			"Pass a filesystem path to the audio file (mp3, wav, m4a, webm, ogg, flac).",
		],
		parameters: Type.Object({
			file: Type.String({ description: "Path to audio file" }),
			model: Type.Optional(Type.String({ description: "STT model id" })),
			language: Type.Optional(Type.String({ description: "ISO-639-1 language hint, e.g. en, vi" })),
			prompt: Type.Optional(Type.String({ description: "Optional vocabulary / style hint" })),
			response_format: Type.Optional(
				Type.String({ description: "json | text | verbose_json | srt | vtt (default json)" }),
			),
		}),
		async execute(_id, params, signal, onUpdate, ctx) {
			const cfg = loadRaw();
			const blocked = needCap(cfg, cap);
			if (blocked) return toolError(blocked);
			const model = resolveModel(cfg, cap, params.model);
			if (!model) return toolError("No STT model available. Sync /9router and set default in /9router-tools.");

			const filePath = resolveUserPath(params.file, ctx.cwd);
			if (!existsSync(filePath)) return toolError(`File not found: ${filePath}`);

			onUpdate?.({ content: [{ type: "text", text: `Transcribing with ${model}…` }] });

			const bytes = readFileSync(filePath);
			const form = new FormData();
			form.append("model", model);
			form.append("file", new Blob([new Uint8Array(bytes)]), basename(filePath));
			if (params.language) form.append("language", params.language);
			if (params.prompt) form.append("prompt", params.prompt);
			if (params.response_format) form.append("response_format", params.response_format);

			const ep = endpointOf(cfg);
			const key = apiKeyOf(cfg);
			const res = await postMultipart(`${ep}/v1/audio/transcriptions`, key, form, signal);
			if (!res.ok) return toolError(`STT failed (${res.status}): ${res.error}`, { model, file: filePath });

			const text =
				typeof res.data === "string"
					? res.data
					: res.data?.text || JSON.stringify(res.data, null, 2);

			return toolOk(text, {
				model,
				file: filePath,
				language: params.language,
			});
		},
		renderResult(result, { expanded }, theme) {
			const d = (result.details || {}) as { model?: string; file?: string };
			const full =
				result.content
					?.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map((c) => c.text)
					.join("\n") || "";
			return compactResult(
				"nr_stt",
				d.file ? basename(d.file) : d.model || "",
				theme,
				expanded,
				full,
			);
		},
	});
}

function registerEmbedTool(pi: ExtensionAPI) {
	const cap = CAPS.find((c) => c.id === "embed")!;
	pi.registerTool({
		name: cap.tool,
		label: cap.label,
		description:
			"Create text embeddings with 9Router for RAG / semantic search. Returns dimensions and a short preview (full vectors can be large).",
		promptSnippet: "Create embeddings / vectors via 9Router",
		promptGuidelines: [
			"Use nr_embed when the user needs embeddings, vectors, or semantic similarity features.",
		],
		parameters: Type.Object({
			input: Type.String({
				description: "Text to embed, or multiple texts separated by \\n---\\n",
			}),
			model: Type.Optional(Type.String({ description: "Embedding model id" })),
			dimensions: Type.Optional(
				Type.Integer({ description: "Optional dimensions (OpenAI v3-style models)", minimum: 1 }),
			),
			full: Type.Optional(
				Type.Boolean({
					description: "If true, include full vector arrays in the response (can be huge). Default false.",
				}),
			),
		}),
		async execute(_id, params, signal, onUpdate) {
			const cfg = loadRaw();
			const blocked = needCap(cfg, cap);
			if (blocked) return toolError(blocked);
			const model = resolveModel(cfg, cap, params.model);
			if (!model) return toolError("No embedding model available. Sync /9router and set default in /9router-tools.");

			const parts = params.input.includes("\n---\n")
				? params.input.split("\n---\n").map((s) => s.trim()).filter(Boolean)
				: [params.input];

			onUpdate?.({ content: [{ type: "text", text: `Embedding ${parts.length} input(s) with ${model}…` }] });

			const body: Record<string, unknown> = {
				model,
				input: parts.length === 1 ? parts[0] : parts,
			};
			if (params.dimensions) body.dimensions = params.dimensions;

			const ep = endpointOf(cfg);
			const key = apiKeyOf(cfg);
			const res = await postJson(`${ep}/v1/embeddings`, key, body, signal);
			if (!res.ok) return toolError(`Embeddings failed (${res.status}): ${res.error}`, { model });

			const data = res.data?.data || [];
			const lines: string[] = [
				`Model: ${model}`,
				`Inputs: ${parts.length}`,
				`Vectors: ${data.length}`,
			];
			for (const row of data) {
				const vec: number[] = row.embedding || [];
				lines.push(
					`#${row.index ?? "?"} dim=${vec.length} preview=[${vec
						.slice(0, 8)
						.map((x: number) => x.toFixed(5))
						.join(", ")}${vec.length > 8 ? ", …" : ""}]`,
				);
			}
			if (res.data?.usage) {
				lines.push(`Usage: ${JSON.stringify(res.data.usage)}`);
			}

			const details: Record<string, unknown> = {
				model,
				count: data.length,
				dimensions: data[0]?.embedding?.length,
			};
			if (params.full) {
				details.embeddings = data.map((d: any) => d.embedding);
			}

			return toolOk(lines.join("\n"), details);
		},
		renderResult(result, { expanded }, theme) {
			const d = (result.details || {}) as { model?: string; count?: number; dimensions?: number };
			const full =
				result.content
					?.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map((c) => c.text)
					.join("\n") || "";
			return compactResult(
				"nr_embed",
				`${d.count || "?"}×${d.dimensions || "?"} · ${d.model || ""}`,
				theme,
				expanded,
				full,
			);
		},
	});
}

function registerWebSearchTool(pi: ExtensionAPI) {
	const cap = CAPS.find((c) => c.id === "web_search")!;
	pi.registerTool({
		name: cap.tool,
		label: cap.label,
		description:
			"Search the web through 9Router (Exa, Tavily, Brave, Serper, …). Returns titles, URLs, and snippets.",
		promptSnippet: "Web search via 9Router",
		promptGuidelines: [
			"Use nr_web_search when you need current web information, docs, news, or sources.",
			"For full page content of a known URL, use nr_web_fetch instead.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Search query" }),
			model: Type.Optional(
				Type.String({
					description: "Search provider/model id (e.g. exa/search). Optional if default set.",
				}),
			),
			max_results: Type.Optional(
				Type.Integer({ description: "Max results (default 5)", minimum: 1, maximum: 20 }),
			),
			search_type: Type.Optional(Type.String({ description: "web | news (provider-dependent)" })),
			country: Type.Optional(Type.String({ description: "Country bias if supported" })),
			language: Type.Optional(Type.String({ description: "Language bias if supported" })),
		}),
		async execute(_id, params, signal, onUpdate) {
			const cfg = loadRaw();
			const blocked = needCap(cfg, cap);
			if (blocked) return toolError(blocked);
			const model = resolveModel(cfg, cap, params.model);
			if (!model) return toolError("No web search model available. Sync /9router and set default in /9router-tools.");

			onUpdate?.({ content: [{ type: "text", text: `Searching with ${model}…` }] });

			const body: Record<string, unknown> = {
				model,
				query: params.query,
				max_results: params.max_results ?? 5,
			};
			if (params.search_type) body.search_type = params.search_type;
			if (params.country) body.country = params.country;
			if (params.language) body.language = params.language;

			const ep = endpointOf(cfg);
			const key = apiKeyOf(cfg);
			const res = await postJson(`${ep}/v1/search`, key, body, signal);
			if (!res.ok) return toolError(`Web search failed (${res.status}): ${res.error}`, { model, query: params.query });

			const results = res.data?.results || res.data?.data || [];
			const lines: string[] = [
				`Search: ${params.query}`,
				`Provider/model: ${res.data?.provider || model}`,
				`Results: ${Array.isArray(results) ? results.length : 0}`,
				"",
			];
			if (Array.isArray(results)) {
				results.forEach((r: any, i: number) => {
					lines.push(`### ${i + 1}. ${r.title || r.url || "result"}`);
					if (r.url) lines.push(r.url);
					if (r.snippet || r.content) lines.push(r.snippet || r.content);
					lines.push("");
				});
			} else {
				lines.push(JSON.stringify(res.data, null, 2).slice(0, 8000));
			}
			if (res.data?.answer) {
				lines.push("Answer:", String(res.data.answer));
			}

			return toolOk(lines.join("\n").trim(), {
				model,
				query: params.query,
				resultCount: Array.isArray(results) ? results.length : 0,
				urls: Array.isArray(results) ? results.map((r: any) => r.url).filter(Boolean) : [],
			});
		},
		renderResult(result, { expanded }, theme) {
			const d = (result.details || {}) as { query?: string; resultCount?: number };
			const full =
				result.content
					?.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map((c) => c.text)
					.join("\n") || "";
			return compactResult(
				"nr_web_search",
				`${d.resultCount ?? "?"} hits${d.query ? ` · ${d.query}` : ""}`,
				theme,
				expanded,
				full,
			);
		},
	});
}

function registerWebFetchTool(pi: ExtensionAPI) {
	const cap = CAPS.find((c) => c.id === "web_fetch")!;
	pi.registerTool({
		name: cap.tool,
		label: cap.label,
		description:
			"Fetch a URL as markdown/text/HTML through 9Router (Exa, Firecrawl, Jina, Tavily, …).",
		promptSnippet: "Fetch URL content via 9Router",
		promptGuidelines: [
			"Use nr_web_fetch when you already have a URL and need page content as markdown or text.",
		],
		parameters: Type.Object({
			url: Type.String({ description: "Absolute URL to fetch" }),
			model: Type.Optional(Type.String({ description: "Fetch provider/model id (e.g. exa/fetch)" })),
			format: Type.Optional(Type.String({ description: "markdown | text | html (default markdown)" })),
			max_characters: Type.Optional(
				Type.Integer({ description: "Truncate output length (0 = no limit on some providers)", minimum: 0 }),
			),
		}),
		async execute(_id, params, signal, onUpdate) {
			const cfg = loadRaw();
			const blocked = needCap(cfg, cap);
			if (blocked) return toolError(blocked);
			const model = resolveModel(cfg, cap, params.model);
			if (!model) return toolError("No web fetch model available. Sync /9router and set default in /9router-tools.");

			if (!/^https?:\/\//i.test(params.url)) {
				return toolError("url must be an absolute http(s) URL");
			}

			onUpdate?.({ content: [{ type: "text", text: `Fetching ${params.url} with ${model}…` }] });

			const body: Record<string, unknown> = {
				model,
				url: params.url,
				format: params.format || "markdown",
			};
			if (params.max_characters != null) body.max_characters = params.max_characters;

			const ep = endpointOf(cfg);
			const key = apiKeyOf(cfg);
			// skill documents /v1/web/fetch; some builds may alias /v1/fetch
			let res = await postJson(`${ep}/v1/web/fetch`, key, body, signal);
			if (!res.ok && res.status === 404) {
				res = await postJson(`${ep}/v1/fetch`, key, body, signal);
			}
			if (!res.ok) return toolError(`Web fetch failed (${res.status}): ${res.error}`, { model, url: params.url });

			const data = res.data || {};
			const contentObj = data.content;
			const textBody =
				typeof contentObj === "string"
					? contentObj
					: contentObj?.text || data.markdown || data.text || data.raw_content || "";

			const header = [
				`URL: ${data.url || params.url}`,
				data.title ? `Title: ${data.title}` : "",
				`Provider/model: ${data.provider || model}`,
				contentObj?.format ? `Format: ${contentObj.format}` : "",
				contentObj?.length != null ? `Length: ${contentObj.length}` : "",
			]
				.filter(Boolean)
				.join("\n");

			const bodyText = textBody || JSON.stringify(data, null, 2).slice(0, 12000);
			return toolOk(`${header}\n\n${bodyText}`, {
				model,
				url: params.url,
				title: data.title,
				length: contentObj?.length ?? bodyText.length,
			});
		},
		renderResult(result, { expanded }, theme) {
			const d = (result.details || {}) as { url?: string; title?: string };
			const full =
				result.content
					?.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map((c) => c.text)
					.join("\n") || "";
			return compactResult(
				"nr_web_fetch",
				d.title || d.url || "",
				theme,
				expanded,
				full,
			);
		},
	});
}

// ── Extension entry ─────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// Register all tools (activation controlled via setActiveTools)
	registerImageTool(pi);
	registerTtsTool(pi);
	registerSttTool(pi);
	registerEmbedTool(pi);
	registerWebSearchTool(pi);
	registerWebFetchTool(pi);

	const applyFromDisk = () => applyToolActivation(pi, loadRaw());

	// Apply enable/disable after tools exist
	pi.on("session_start", async (_event, ctx) => {
		// slight defer so other extensions finish registering
		applyFromDisk();
		const cfg = loadRaw();
		const enabled = CAPS.filter((c) => getCapState(cfg, c).enabled).length;
		if (ctx.hasUI) {
			ctx.ui.setStatus(
				"9router-tools",
				ctx.ui.theme.fg("dim", `9r-tools · ${enabled}/${CAPS.length} on`),
			);
		}
	});

	// When core extension finishes a catalog sync, refresh activation (models may appear)
	pi.events.on("9router:synced", () => {
		applyFromDisk();
	});

	pi.registerCommand("9router-tools", {
		description:
			"Enable/disable 9Router capability tools (image, tts, stt, embed, web search/fetch) and set default models",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI && ctx.mode !== "tui") {
				ctx.ui.notify("/9router-tools needs interactive mode", "error");
				return;
			}
			const cfg = loadRaw();
			if (!cfg.catalog?.length) {
				ctx.ui.notify("Tip: run /9router → Fetch all first so model pickers have data.", "warning");
			}
			await runToolsUI(pi, ctx);
			applyFromDisk();
		},
	});
}
