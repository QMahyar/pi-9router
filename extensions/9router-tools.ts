/**
 * pi-9router-tools — Capability tools for 9Router (companion to 9router.ts)
 *
 * Config UI: /9router-tools
 *
 * Tools (toggle in UI; off tools are removed from the model context):
 *   nr_image_generate  POST /v1/images/generations
 *   nr_tts             POST /v1/audio/speech
 *   nr_embed           POST /v1/embeddings
 *   nr_web_search      POST /v1/search
 *   nr_web_fetch       POST /v1/web/fetch
 *
 * Speech-to-text / mic input is intentionally not included — use a dedicated
 * OS dictation app (e.g. Superwhisper, Spokenly) for voice → editor.
 *
 * Each tool's description carries the ids available for its capability, and a
 * `model` argument is resolved against the catalog before any request goes out.
 *
 * Wire convention: /v1/images/generations, /v1/audio/speech, /v1/embeddings take
 * the full catalog id; /v1/search and /v1/web/fetch take a bare provider name.
 *
 * Shared config: ~/.pi/agent/9router.json
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
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import {
	CONFIG_PATH,
	DEFAULT_OUTPUT_DIR,
	TIMEOUT,
	downloadUrl,
	isSyncStale,
	loadJsonFile,
	normalizeEndpoint,
	postBinary,
	postJson,
	resolveApiKey,
	saveJsonMerge,
} from "./lib/shared.ts";

// ── Types ───────────────────────────────────────────────────────

type CapId = "image" | "tts" | "embed" | "web_search" | "web_fetch";

interface CatalogEntry {
	id: string;
	name?: string;
	kind: string;
	detailKind?: string;
	ownedBy?: string;
	capabilities?: unknown;
	params?: string[];
	namedByServer?: boolean;
	synthetic?: boolean;
	note?: string;
}

const VOICE_PROVIDER_PREFIXES = ["edge-tts", "google-tts", "el", "local-device"];

interface CapState {
	enabled: boolean;
	model?: string;
}

interface ToolsConfigSlice {
	endpoint?: string;
	apiKey?: string;
	catalog?: CatalogEntry[];
	counts?: Record<string, number>;
	lastSync?: string;
	lastSyncMode?: string;
	capabilities?: Partial<Record<CapId, CapState>>;
	outputDir?: string;
	/** Inline generated images into the conversation as base64 (default false) */
	attachImages?: boolean;
}

interface CapDef {
	id: CapId;
	tool: string;
	label: string;
	catalogKind: string | ((e: CatalogEntry) => boolean);
	defaultEnabled: boolean;
	blurb: string;
}

export const CAPS: CapDef[] = [
	{
		id: "image",
		tool: "nr_image_generate",
		label: "Image generation",
		catalogKind: "image",
		defaultEnabled: true,
		blurb: "Text → image",
	},
	{
		id: "tts",
		tool: "nr_tts",
		label: "Text to speech",
		catalogKind: "tts",
		defaultEnabled: true,
		blurb: "Text → audio file",
	},
	{
		id: "embed",
		tool: "nr_embed",
		label: "Embeddings",
		catalogKind: "embedding",
		defaultEnabled: false,
		blurb: "Text → vectors",
	},
	{
		id: "web_search",
		tool: "nr_web_search",
		label: "Web search",
		catalogKind: (e) =>
			e.kind === "web" && (e.detailKind === "webSearch" || (!e.detailKind && /search/i.test(e.id))),
		defaultEnabled: true,
		blurb: "Query → results",
	},
	{
		id: "web_fetch",
		tool: "nr_web_fetch",
		label: "Web fetch",
		catalogKind: (e) =>
			e.kind === "web" && (e.detailKind === "webFetch" || (!e.detailKind && /fetch/i.test(e.id))),
		defaultEnabled: true,
		blurb: "URL → markdown",
	},
];

// ── Config ──────────────────────────────────────────────────────

function loadRaw(): ToolsConfigSlice {
	return loadJsonFile() as ToolsConfigSlice;
}

function saveRaw(patch: Partial<ToolsConfigSlice>): ToolsConfigSlice {
	return saveJsonMerge(patch as Record<string, unknown>) as ToolsConfigSlice;
}

function endpointOf(cfg: ToolsConfigSlice): string {
	return normalizeEndpoint(cfg.endpoint);
}

function apiKeyOf(cfg: ToolsConfigSlice): string {
	return resolveApiKey(cfg.apiKey);
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

function normalizeId(s: string): string {
	return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function leafOf(id: string): string {
	const i = id.lastIndexOf("/");
	return i >= 0 ? id.slice(i + 1) : id;
}

function isVoiceProviderId(id: string): boolean {
	const i = id.indexOf("/");
	if (i <= 0 || i === id.length - 1) return false;
	return VOICE_PROVIDER_PREFIXES.includes(id.slice(0, i));
}

type ModelResolution =
	| { ok: true; id: string; note?: string }
	| { ok: false; message: string };

/**
 * Turn whatever the caller passed for `model` into a real catalog id.
 */
export function resolveModel(cfg: ToolsConfigSlice, cap: CapDef, override?: string): ModelResolution {
	const models = modelsForCap(cfg, cap);
	const want = override?.trim();

	if (!want) {
		const saved = getCapState(cfg, cap).model?.trim();
		const usable =
			saved && (models.some((m) => m.id === saved) || isVoiceProviderId(saved)) ? saved : undefined;
		const fallback = usable || models[0]?.id;
		if (!fallback) {
			return {
				ok: false,
				message: `No ${cap.label.toLowerCase()} model available. Run /9router → Sync models, then set a default in /9router-tools.`,
			};
		}
		return {
			ok: true,
			id: fallback,
			note: saved && !usable ? `default "${saved}" is no longer in the catalog — used ${fallback}` : undefined,
		};
	}

	const exact = models.find((m) => m.id === want);
	if (exact) return { ok: true, id: exact.id };

	const ci = models.find((m) => m.id.toLowerCase() === want.toLowerCase());
	if (ci) return { ok: true, id: ci.id, note: `matched "${want}"` };

	const key = normalizeId(want);
	if (key) {
		const keyed = models.filter(
			(m) =>
				normalizeId(m.id) === key ||
				normalizeId(leafOf(m.id)) === key ||
				(m.name ? normalizeId(m.name) === key : false),
		);
		if (keyed.length === 1) {
			return { ok: true, id: keyed[0].id, note: `resolved "${want}" → ${keyed[0].id}` };
		}
		if (keyed.length > 1) return { ok: false, message: ambiguous(want, keyed) };

		const partial = models.filter(
			(m) =>
				normalizeId(m.id).includes(key) ||
				(m.name ? normalizeId(m.name).includes(key) : false),
		);
		if (partial.length === 1) {
			return { ok: true, id: partial[0].id, note: `resolved "${want}" → ${partial[0].id}` };
		}
		if (partial.length > 1) return { ok: false, message: ambiguous(want, partial) };
	}

	if (isVoiceProviderId(want)) return { ok: true, id: want };

	return {
		ok: false,
		message: [
			`Unknown ${cap.label.toLowerCase()} model "${want}".`,
			models.length
				? `Available: ${models.map((m) => m.id).join(", ")}`
				: "No models in the catalog — run /9router → Sync models.",
			"Omit `model` to use the configured default.",
		].join("\n"),
	};
}

const MAX_LISTED_MODELS = 14;

function shouldAttachImage(cfg: ToolsConfigSlice): boolean {
	return cfg.attachImages === true;
}

/**
 * Render available ids (+ optional params) for the tool description.
 */
export function describeModels(cfg: ToolsConfigSlice, cap: CapDef): string {
	const models = modelsForCap(cfg, cap);
	if (!models.length) return "No models synced yet — run /9router → Sync models.";

	const listed = models.filter((m) => !m.synthetic);
	const synthetic = models.filter((m) => m.synthetic);
	const parts: string[] = [];

	const head = listed.slice(0, MAX_LISTED_MODELS);
	if (head.length) {
		parts.push(
			head
				.map((m) => {
					const label = m.name && m.name !== m.id ? `${m.id} (${m.name})` : m.id;
					const p = m.params?.length ? ` [${m.params.join(", ")}]` : "";
					return label + p;
				})
				.join(", ") + (listed.length > head.length ? `, +${listed.length - head.length} more` : ""),
		);
	}

	const byProvider = new Map<string, string[]>();
	for (const m of synthetic) {
		const p = m.ownedBy || leafOf(m.id);
		byProvider.set(p, [...(byProvider.get(p) || []), leafOf(m.id)]);
	}
	for (const [provider, voices] of byProvider) {
		parts.push(
			`${provider}/<voice> — e.g. ${voices.slice(0, 3).join(", ")} (${voices.length} listed, any ${provider} voice id works)`,
		);
	}

	return `Available: ${parts.join("; ")}.`;
}

function withModels(cfg: ToolsConfigSlice, cap: CapDef, base: string): string {
	return `${base}\n\n${describeModels(cfg, cap)}\nPass one of these exact ids as \`model\`, or omit \`model\` to use the configured default.`;
}

function ambiguous(want: string, matches: CatalogEntry[]): string {
	return [
		`"${want}" matches ${matches.length} models — pass one exactly:`,
		...matches.map((m) => `  ${m.id}${m.name && m.name !== m.id ? `  (${m.name})` : ""}`),
	].join("\n");
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
	return fallback;
}

function decodeDataUrlOrB64(raw: string): { bytes: Uint8Array; ext: string } | null {
	const m = raw.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i);
	if (m) {
		return { bytes: Buffer.from(m[2], "base64"), ext: extFromContentType(m[1], ".png") };
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

/** Resolve a local image path for edit/reference; return base64 data URL or null. */
function loadImageRef(pathOrData: string, cwd: string): string | null {
	const raw = pathOrData.trim();
	if (!raw) return null;
	if (raw.startsWith("data:image/")) return raw;
	// bare base64
	if (/^[A-Za-z0-9+/=\s]+$/.test(raw) && raw.replace(/\s/g, "").length > 64) {
		const cleaned = raw.replace(/\s/g, "");
		try {
			const buf = Buffer.from(cleaned, "base64");
			if (buf.length > 32) {
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
	const abs = isAbsolute(raw) ? raw : resolve(cwd, raw);
	if (!existsSync(abs)) return null;
	try {
		const bytes = readFileSync(abs);
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

function toolError(message: string, details: Record<string, unknown> = {}) {
	return {
		content: [{ type: "text" as const, text: message }],
		details,
		isError: true as const,
	};
}

function toolOk(text: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text }], details };
}

function needSyncHint(): string {
	return "No 9Router catalog yet. Open /9router → Sync models first.";
}

function needCap(cfg: ToolsConfigSlice, cap: CapDef): string | null {
	const state = getCapState(cfg, cap);
	if (!state.enabled) {
		return `${cap.label} is off. Enable it in /9router-tools.`;
	}
	if (!cfg.catalog?.length) return needSyncHint();
	return null;
}

function shortModel(id?: string, max = 36): string {
	if (!id) return "auto";
	return id.length <= max ? id : "…" + id.slice(-(max - 1));
}

function padLabel(label: string, width: number): string {
	if (label.length >= width) return label.slice(0, width);
	return label + " ".repeat(width - label.length);
}

// ── Active tools ────────────────────────────────────────────────

function applyToolActivation(pi: ExtensionAPI, cfg: ToolsConfigSlice): void {
	const active = new Set(pi.getActiveTools());
	const allKnown = new Set(pi.getAllTools().map((t) => t.name));

	active.delete("nr_stt");

	for (const cap of CAPS) {
		if (!allKnown.has(cap.tool)) continue;
		if (getCapState(cfg, cap).enabled) active.add(cap.tool);
		else active.delete(cap.tool);
	}
	pi.setActiveTools([...active]);
}

// ── TUI ─────────────────────────────────────────────────────────

function capRow(cfg: ToolsConfigSlice, cap: CapDef): string {
	const st = getCapState(cfg, cap);
	const n = modelsForCap(cfg, cap).length;
	const status = st.enabled ? "On " : "Off";
	const model = st.enabled ? shortModel(st.model || modelsForCap(cfg, cap)[0]?.id) : "—";
	return `${padLabel(cap.label, 18)}  ${status}  ${padLabel(model, 34)}  ${n ? n + " models" : "no models"}`;
}

async function pickModel(
	ui: ExtensionContext["ui"],
	cfg: ToolsConfigSlice,
	cap: CapDef,
): Promise<string | undefined> {
	const models = modelsForCap(cfg, cap);
	if (!models.length) {
		ui.notify(needSyncHint(), "warning");
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
	return pick.replace(/^\*\s/, "").replace(/^\s\s/, "").split(/\s{2,}/)[0].trim();
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
		const def = st.model || (n ? modelsForCap(cfg, cap)[0]?.id : undefined);
		const choice = await ui.select(cap.label, [
			st.enabled ? "Turn off" : "Turn on",
			`Default model: ${shortModel(def, 48)}`,
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
			ui.notify(model ? `Default: ${model}` : "Default cleared (use first available)", "info");
			continue;
		}

		if (choice === "Browse models") {
			const models = modelsForCap(cfg, cap);
			if (!models.length) {
				ui.notify(needSyncHint(), "warning");
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

async function showStatus(ui: ExtensionContext["ui"], cfg: ToolsConfigSlice): Promise<void> {
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
			return `${st.enabled ? "ON " : "off"}  ${padLabel(cap.tool, 18)}  ${shortModel(st.model || modelsForCap(cfg, cap)[0]?.id, 40)}  (${n})`;
		}),
	];
	await ui.confirm("Status", lines.join("\n"));
}

async function runToolsUI(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	const ui = ctx.ui;
	let cfg = loadRaw();

	while (true) {
		const stale = isSyncStale(cfg.lastSync);
		const header = cfg.catalog?.length
			? `Synced · ${Object.entries(cfg.counts || {})
					.filter(([k]) => k !== "stt")
					.map(([k, v]) => `${k} ${v}`)
					.join(" · ")}${stale ? " · ⚠ stale" : ""}`
			: "Catalog empty — run /9router → Sync models";

		const rows = CAPS.map((c) => capRow(cfg, c));
		const attLabel = `Inline generated images: ${shouldAttachImage(cfg) ? "on" : "off (recommended)"}`;
		const menu = [...rows, "─".repeat(48), attLabel, "Output folder", "Status", "Close"];

		const choice = await ui.select(`9Router Tools\n${header}`, menu);
		if (!choice || choice === "Close") break;
		if (choice.startsWith("─")) continue;

		if (choice.startsWith("Inline generated images")) {
			const pick = await ui.select("Embed generated images in the conversation?", [
				"Off — return the file path only (recommended)",
				"On — embed base64 in the tool result",
				"Back",
			]);
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
			const next = await ui.input("Folder for generated images/audio", outputDirOf(cfg));
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

		const cap = CAPS.find((c) => choice.startsWith(padLabel(c.label, 18)) || choice.includes(c.label));
		if (cap) cfg = await configureCap(pi, ui, cfg, cap);
	}
}

// ── Render ──────────────────────────────────────────────────────

function compactResult(title: string, detail: string, theme: Theme, expanded: boolean, full: string): Text {
	if (!expanded) {
		return new Text(
			theme.fg("toolTitle", title) + (detail ? theme.fg("dim", ` · ${truncateToWidth(detail, 56)}`) : ""),
			0,
			0,
		);
	}
	return new Text(full || detail || title, 0, 0);
}

function textFromResult(result: { content?: Array<{ type: string; text?: string }> }): string {
	return (
		result.content
			?.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n") || ""
	);
}

// ── Image generation (n + optional edit ref) ────────────────────

async function generateImages(opts: {
	ep: string;
	key: string;
	outDir: string;
	model: string;
	prompt: string;
	n: number;
	size?: string;
	quality?: string;
	filename?: string;
	/** data URL or local path already loaded as data URL */
	imageDataUrl?: string;
	signal?: AbortSignal;
}): Promise<{ saved: string[]; error?: string }> {
	const { ep, key, outDir, model, prompt, n, size, quality, filename, imageDataUrl, signal } = opts;
	const saved: string[] = [];
	const count = Math.min(Math.max(1, n), 4);

	const baseBody: Record<string, unknown> = { model, prompt, n: 1 };
	if (size) baseBody.size = size;
	if (quality) baseBody.quality = quality;
	if (imageDataUrl) {
		// Providers accept `image` (single) and/or `images[]`
		baseBody.image = imageDataUrl;
		baseBody.images = [imageDataUrl];
	}

	for (let i = 0; i < count; i++) {
		// Prefer binary (raw bytes) — matches skill default for saving files
		const bin = await postBinary(
			`${ep}/v1/images/generations?response_format=binary`,
			key,
			baseBody,
			{ signal, timeoutMs: TIMEOUT.tool },
		);
		if (bin.ok && bin.bytes.length > 100) {
			const ext = extFromContentType(bin.contentType, ".png");
			const name =
				(filename?.replace(/[^\w.\-]+/g, "_") && count === 1
					? filename.replace(/[^\w.\-]+/g, "_")
					: null) ||
				`img-${stamp()}-${slug(prompt)}-${i}-${randomBytes(2).toString("hex")}${ext}`;
			saved.push(writeBytes(outDir, name, bin.bytes));
			continue;
		}

		// Fallback: b64_json
		const res = await postJson(
			`${ep}/v1/images/generations`,
			key,
			{ ...baseBody, response_format: "b64_json" },
			{ signal, timeoutMs: TIMEOUT.tool },
		);
		if (res.ok) {
			const rows = res.data?.data || [];
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
					if (!dl) continue;
					const ext = extFromContentType(dl.contentType, ".png");
					const nm =
						filename?.replace(/[^\w.\-]+/g, "_") && (res2.data.data || []).length === 1
							? filename.replace(/[^\w.\-]+/g, "_")
							: `img-${stamp()}-${slug(prompt)}-${j}-${randomBytes(2).toString("hex")}${ext}`;
					saved.push(writeBytes(outDir, nm, dl.bytes));
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
					filename?.replace(/[^\w.\-]+/g, "_") && rows.length === 1 && count === 1
						? filename.replace(/[^\w.\-]+/g, "_")
						: `img-${stamp()}-${slug(prompt)}-${i}-${j}-${randomBytes(2).toString("hex")}${dec.ext}`;
				saved.push(writeBytes(outDir, nm, dec.bytes));
			}
			// If b64 returned multiple for n:1, we still only wanted one iteration worth
			if (rows.length > 1) break;
			continue;
		}

		// Last resort url
		const res2 = await postJson(
			`${ep}/v1/images/generations`,
			key,
			{ ...baseBody, response_format: "url" },
			{ signal, timeoutMs: TIMEOUT.tool },
		);
		if (!res2.ok) {
			return {
				saved,
				error:
					bin.ok === false
						? `Image generation failed (${res.status}): ${res.error}`
						: `Image generation failed (${res2.status}): ${res2.error}`,
			};
		}
		for (let j = 0; j < (res2.data?.data || []).length; j++) {
			const url = res2.data.data[j].url;
			if (!url) continue;
			const dl = await downloadUrl(url, { signal });
			if (!dl) continue;
			const ext = extFromContentType(dl.contentType, ".png");
			const nm = `img-${stamp()}-${slug(prompt)}-${i}-${j}-${randomBytes(2).toString("hex")}${ext}`;
			saved.push(writeBytes(outDir, nm, dl.bytes));
		}
		if ((res2.data?.data || []).length > 1) break;
	}

	return { saved };
}

// ── Tools ───────────────────────────────────────────────────────

function registerImageTool(pi: ExtensionAPI, cfg: ToolsConfigSlice) {
	const cap = CAPS.find((c) => c.id === "image")!;
	pi.registerTool({
		name: cap.tool,
		label: "Image",
		description: withModels(
			cfg,
			cap,
			"Generate an image through 9Router and save it to disk. Best for icons, logos, illustrations, UI mockups, and concept art. Optional image_path enables edit/img2img when the model supports it. Returns the saved file path; the image itself is not embedded in the result by default.",
		),
		promptSnippet: "Generate an image (9Router) and save the file path",
		promptGuidelines: [
			"Call nr_image_generate to create images, icons, logos, illustrations, or mockups.",
			"Write a detailed prompt (subject, style, colors, composition).",
			"Omit model unless the user names a specific image model; when they do, use an exact id from the tool description. Optional size, quality, n (1–4), filename, image_path (local path for edit/img2img).",
			"Tell the user the saved file path from the tool result.",
			"The image is not embedded in the result — read the returned path if you need to see it.",
		],
		parameters: Type.Object({
			prompt: Type.String({ description: "Image prompt: subject, style, colors, composition" }),
			model: Type.Optional(Type.String({ description: "Image model id (optional; uses /9router-tools default)" })),
			size: Type.Optional(Type.String({ description: "Size if supported, e.g. 1024x1024" })),
			n: Type.Optional(Type.Integer({ description: "Number of images, 1–4 (default 1)", minimum: 1, maximum: 4 })),
			quality: Type.Optional(Type.String({ description: "standard or hd when supported" })),
			filename: Type.Optional(Type.String({ description: "Output file name only, no folders" })),
			image_path: Type.Optional(
				Type.String({
					description: "Local path (or data URL) of a reference image for edit/img2img when the model supports it",
				}),
			),
		}),
		async execute(_id, params, signal, onUpdate, ctx) {
			const cfg = loadRaw();
			const blocked = needCap(cfg, cap);
			if (blocked) return toolError(blocked);
			const picked = resolveModel(cfg, cap, params.model);
			if (!picked.ok) return toolError(picked.message, { requested: params.model });
			const model = picked.id;

			const ep = endpointOf(cfg);
			const key = apiKeyOf(cfg);
			const outDir = outputDirOf(cfg);
			const n = Math.min(params.n ?? 1, 4);

			let imageDataUrl: string | undefined;
			if (params.image_path?.trim()) {
				const loaded = loadImageRef(params.image_path, ctx.cwd);
				if (!loaded) {
					return toolError(`Could not read image_path: ${params.image_path}`, {
						image_path: params.image_path,
					});
				}
				imageDataUrl = loaded;
			}

			onUpdate?.({
				content: [
					{
						type: "text",
						text: `Generating ${n} image(s) with ${model}${imageDataUrl ? " (edit/ref)" : ""}…`,
					},
				],
			});

			const { saved, error } = await generateImages({
				ep,
				key,
				outDir,
				model,
				prompt: params.prompt,
				n,
				size: params.size,
				quality: params.quality,
				filename: params.filename,
				imageDataUrl,
				signal,
			});

			if (error && !saved.length) return toolError(error, { model });
			if (!saved.length) return toolError("No image data returned.", { model });

			const text = [
				`Generated ${saved.length} image(s) · ${model}`,
				picked.note ? `Model ${picked.note}` : "",
				params.image_path ? `Reference: ${params.image_path}` : "",
				`Prompt: ${params.prompt}`,
				error ? `Note: ${error}` : "",
				...saved.map((p) => `File: ${p}`),
			]
				.filter(Boolean)
				.join("\n");

			const content: Array<
				| { type: "text"; text: string }
				| { type: "image"; source: { type: "base64"; mediaType: string; data: string } }
			> = [{ type: "text", text }];

			let attached = false;
			if (shouldAttachImage(cfg)) {
				try {
					const first = saved[0];
					const st = statSync(first);
					if (st.size > 0) {
						const bytes = readFileSync(first);
						const ext = extname(first).toLowerCase();
						const mediaType =
							ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".webp" ? "image/webp" : "image/png";
						content.push({
							type: "image",
							source: { type: "base64", mediaType, data: bytes.toString("base64") },
						});
						attached = true;
					}
				} catch {
					/* path is already in text */
				}
			}

			return {
				content,
				details: {
					model,
					files: saved,
					prompt: params.prompt,
					n: saved.length,
					cwd: ctx.cwd,
					attached,
					image_path: params.image_path,
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

function registerTtsTool(pi: ExtensionAPI, cfg: ToolsConfigSlice) {
	const cap = CAPS.find((c) => c.id === "tts")!;
	pi.registerTool({
		name: cap.tool,
		label: "Speech",
		description: withModels(
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
			model: Type.Optional(Type.String({ description: "TTS model/voice id (optional)" })),
			filename: Type.Optional(Type.String({ description: "Output file name only" })),
		}),
		async execute(_id, params, signal, onUpdate) {
			const cfg = loadRaw();
			const blocked = needCap(cfg, cap);
			if (blocked) return toolError(blocked);
			const picked = resolveModel(cfg, cap, params.model);
			if (!picked.ok) return toolError(picked.message, { requested: params.model });
			const model = picked.id;
			onUpdate?.({ content: [{ type: "text", text: `Synthesizing · ${model}` }] });

			const ep = endpointOf(cfg);
			const key = apiKeyOf(cfg);
			const outDir = outputDirOf(cfg);

			// Prefer raw audio bytes (skill default); JSON is fallback
			let bytes: Uint8Array | null = null;
			let ext = ".mp3";
			const bin = await postBinary(`${ep}/v1/audio/speech`, key, { model, input: params.input }, {
				signal,
				timeoutMs: TIMEOUT.tool,
			});
			if (bin.ok && bin.bytes.length > 64) {
				// Reject tiny JSON error bodies disguised as 200
				const ct = bin.contentType.toLowerCase();
				if (ct.includes("json") || bin.bytes[0] === 0x7b /* { */) {
					// fall through to json path
				} else {
					bytes = bin.bytes;
					ext = extFromContentType(bin.contentType, ".mp3");
				}
			}

			if (!bytes) {
				const res = await postJson(
					`${ep}/v1/audio/speech?response_format=json`,
					key,
					{ model, input: params.input },
					{ signal, timeoutMs: TIMEOUT.tool },
				);
				if (res.ok && res.data?.audio) {
					bytes = Buffer.from(res.data.audio, "base64");
					if (res.data.format) ext = `.${String(res.data.format).replace(/^\./, "")}`;
				} else {
					const detail = !bin.ok
						? `binary HTTP ${bin.status}: ${bin.error}`
						: !res.ok
							? `json HTTP ${res.status}: ${res.error}`
							: "no audio field in json response";
					return toolError(`TTS failed (${detail})`, { model });
				}
			}

			if (!bytes?.length) return toolError("Empty audio.", { model });
			const name =
				params.filename?.replace(/[^\w.\-]+/g, "_") || `tts-${stamp()}-${slug(params.input)}${ext}`;
			const path = writeBytes(outDir, name, bytes);
			return toolOk(
				[
					"Speech saved.",
					`Model: ${model}`,
					picked.note ? `Model ${picked.note}` : "",
					`File: ${path}`,
					`Chars: ${params.input.length}`,
				]
					.filter(Boolean)
					.join("\n"),
				{ model, file: path, bytes: bytes.length },
			);
		},
		renderResult(result, { expanded }, theme) {
			const d = (result.details || {}) as { file?: string };
			return compactResult("nr_tts", d.file ? basename(d.file) : "", theme, expanded, textFromResult(result));
		},
	});
}

function registerEmbedTool(pi: ExtensionAPI, cfg: ToolsConfigSlice) {
	const cap = CAPS.find((c) => c.id === "embed")!;
	pi.registerTool({
		name: cap.tool,
		label: "Embed",
		description: withModels(
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
			input: Type.String({ description: "Text to embed, or chunks split by a --- line" }),
			model: Type.Optional(Type.String({ description: "Embedding model id (optional)" })),
			dimensions: Type.Optional(Type.Integer({ description: "Vector size when supported", minimum: 1 })),
			full: Type.Optional(Type.Boolean({ description: "Return full vectors (default false)" })),
		}),
		async execute(_id, params, signal, onUpdate) {
			const cfg = loadRaw();
			const blocked = needCap(cfg, cap);
			if (blocked) return toolError(blocked);
			const picked = resolveModel(cfg, cap, params.model);
			if (!picked.ok) return toolError(picked.message, { requested: params.model });
			const model = picked.id;
			const parts = params.input.includes("\n---\n")
				? params.input
						.split("\n---\n")
						.map((s) => s.trim())
						.filter(Boolean)
				: [params.input];
			onUpdate?.({ content: [{ type: "text", text: `Embedding ${parts.length} input(s)…` }] });
			const body: Record<string, unknown> = { model, input: parts.length === 1 ? parts[0] : parts };
			if (params.dimensions) body.dimensions = params.dimensions;
			const res = await postJson(`${endpointOf(cfg)}/v1/embeddings`, apiKeyOf(cfg), body, {
				signal,
				timeoutMs: TIMEOUT.tool,
			});
			if (!res.ok) return toolError(`Embeddings failed (${res.status}): ${res.error}`, { model });
			const data = res.data?.data || [];
			const lines = [`Model: ${model}`, `Inputs: ${parts.length}`, `Vectors: ${data.length}`];
			for (const row of data) {
				const vec: number[] = row.embedding || [];
				lines.push(
					`#${row.index ?? "?"} dim=${vec.length} preview=[${vec
						.slice(0, 8)
						.map((x: number) => x.toFixed(5))
						.join(", ")}${vec.length > 8 ? ", …" : ""}]`,
				);
			}
			const details: Record<string, unknown> = {
				model,
				count: data.length,
				dimensions: data[0]?.embedding?.length,
			};
			// Cap full vectors to avoid context blowups even when requested
			if (params.full) {
				const maxFull = 8;
				details.embeddings = data.slice(0, maxFull).map((d: any) => d.embedding);
				if (data.length > maxFull) {
					details.embeddingsTruncated = true;
					lines.push(`(full vectors capped at ${maxFull} of ${data.length})`);
				}
			}
			return toolOk(lines.join("\n"), details);
		},
		renderResult(result, { expanded }, theme) {
			const d = (result.details || {}) as { count?: number; dimensions?: number; model?: string };
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

function registerWebSearchTool(pi: ExtensionAPI, cfg: ToolsConfigSlice) {
	const cap = CAPS.find((c) => c.id === "web_search")!;
	pi.registerTool({
		name: cap.tool,
		label: "Search",
		description: withModels(
			cfg,
			cap,
			"Search the web through 9Router. Returns titles, URLs, and snippets. For full page text of a known URL, use nr_web_fetch.",
		),
		promptSnippet: "Search the web (9Router)",
		promptGuidelines: [
			"Call nr_web_search for current web info, docs, news, or sources.",
			"Write a clear natural-language query. Omit model unless the user names a provider (e.g. exa/search).",
			"Optional: max_results (default 5), search_type (web|news), country, language.",
			"Follow up with nr_web_fetch on the best URLs when you need full page content.",
			"Do not use nr_web_search for local codebase questions.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "What to search for" }),
			model: Type.Optional(Type.String({ description: "Search model id (optional)" })),
			max_results: Type.Optional(Type.Integer({ description: "Result count, 1–20 (default 5)", minimum: 1, maximum: 20 })),
			search_type: Type.Optional(Type.String({ description: "web or news when supported" })),
			country: Type.Optional(Type.String({ description: "Country bias when supported" })),
			language: Type.Optional(Type.String({ description: "Language bias when supported" })),
		}),
		async execute(_id, params, signal, onUpdate) {
			const cfg = loadRaw();
			const blocked = needCap(cfg, cap);
			if (blocked) return toolError(blocked);
			const picked = resolveModel(cfg, cap, params.model);
			if (!picked.ok) return toolError(picked.message, { requested: params.model });
			const model = picked.id;
			// Wire: bare provider ("exa"), not catalog id ("exa/search")
			const apiModel = model.replace(/\/search$/i, "");
			onUpdate?.({ content: [{ type: "text", text: `Searching · ${apiModel}` }] });
			const body: Record<string, unknown> = {
				model: apiModel,
				query: params.query,
				max_results: params.max_results ?? 5,
			};
			if (params.search_type) body.search_type = params.search_type;
			if (params.country) body.country = params.country;
			if (params.language) body.language = params.language;
			const res = await postJson(`${endpointOf(cfg)}/v1/search`, apiKeyOf(cfg), body, {
				signal,
				timeoutMs: TIMEOUT.tool,
			});
			if (!res.ok) return toolError(`Search failed (${res.status}): ${res.error}`, { model, query: params.query });
			const results = res.data?.results || res.data?.data || [];
			const lines = [
				`Query: ${params.query}`,
				`Model: ${res.data?.provider || model}`,
				`Results: ${Array.isArray(results) ? results.length : 0}`,
				"",
			];
			if (Array.isArray(results)) {
				results.forEach((r: any, i: number) => {
					lines.push(`### ${i + 1}. ${r.title || r.url || "result"}`);
					if (r.url) lines.push(r.url);
					if (r.snippet || r.content) lines.push(String(r.snippet || r.content));
					lines.push("");
				});
			} else {
				lines.push(JSON.stringify(res.data, null, 2).slice(0, 8000));
			}
			if (res.data?.answer) lines.push("Answer:", String(res.data.answer));
			return toolOk(lines.join("\n").trim(), {
				model,
				query: params.query,
				resultCount: Array.isArray(results) ? results.length : 0,
				urls: Array.isArray(results) ? results.map((r: any) => r.url).filter(Boolean) : [],
			});
		},
		renderResult(result, { expanded }, theme) {
			const d = (result.details || {}) as { query?: string; resultCount?: number };
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

function registerWebFetchTool(pi: ExtensionAPI, cfg: ToolsConfigSlice) {
	const cap = CAPS.find((c) => c.id === "web_fetch")!;
	pi.registerTool({
		name: cap.tool,
		label: "Fetch",
		description: withModels(
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
			model: Type.Optional(Type.String({ description: "Fetch model id (optional)" })),
			format: Type.Optional(Type.String({ description: "markdown, text, or html (default markdown)" })),
			max_characters: Type.Optional(Type.Integer({ description: "Max characters to return", minimum: 0 })),
		}),
		async execute(_id, params, signal, onUpdate) {
			const cfg = loadRaw();
			const blocked = needCap(cfg, cap);
			if (blocked) return toolError(blocked);
			const picked = resolveModel(cfg, cap, params.model);
			if (!picked.ok) return toolError(picked.message, { requested: params.model });
			const model = picked.id;
			const apiModel = model.replace(/\/fetch$/i, "");
			if (!/^https?:\/\//i.test(params.url)) return toolError("url must be absolute http(s)");
			onUpdate?.({ content: [{ type: "text", text: `Fetching · ${params.url}` }] });
			const body: Record<string, unknown> = {
				model: apiModel,
				url: params.url,
				format: params.format || "markdown",
			};
			if (params.max_characters != null) body.max_characters = params.max_characters;
			const ep = endpointOf(cfg);
			const key = apiKeyOf(cfg);
			let res = await postJson(`${ep}/v1/web/fetch`, key, body, { signal, timeoutMs: TIMEOUT.tool });
			if (!res.ok && res.status === 404) {
				res = await postJson(`${ep}/v1/fetch`, key, body, { signal, timeoutMs: TIMEOUT.tool });
			}
			if (!res.ok) return toolError(`Fetch failed (${res.status}): ${res.error}`, { model, url: params.url });
			const data = res.data || {};
			const contentObj = data.content;
			const textBody =
				typeof contentObj === "string"
					? contentObj
					: contentObj?.text || data.markdown || data.text || data.raw_content || "";
			const header = [
				`URL: ${data.url || params.url}`,
				data.title ? `Title: ${data.title}` : "",
				`Model: ${data.provider || model}`,
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
			return compactResult("nr_web_fetch", d.title || d.url || "", theme, expanded, textFromResult(result));
		},
	});
}

// ── Entry ───────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	const registerAll = (cfg: ToolsConfigSlice) => {
		registerImageTool(pi, cfg);
		registerTtsTool(pi, cfg);
		registerEmbedTool(pi, cfg);
		registerWebSearchTool(pi, cfg);
		registerWebFetchTool(pi, cfg);
	};

	registerAll(loadRaw());

	const applyFromDisk = () => applyToolActivation(pi, loadRaw());

	pi.on("session_start", async (_event, ctx) => {
		const cfg = saveRaw({});
		applyFromDisk();
		const enabled = CAPS.filter((c) => getCapState(cfg, c).enabled).length;
		if (ctx.hasUI) {
			const stale = isSyncStale(cfg.lastSync);
			ctx.ui.setStatus(
				"9router-tools",
				ctx.ui.theme.fg(stale ? "warning" : "dim", `tools ${enabled}/${CAPS.length}${stale ? " · stale" : ""}`),
			);
		}
	});

	pi.events.on("9router:synced", () => {
		registerAll(loadRaw());
		applyFromDisk();
	});

	pi.registerCommand("9router-tools", {
		description: "9Router tools — enable image, speech, search, fetch; set defaults",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI && ctx.mode !== "tui") {
				ctx.ui.notify("/9router-tools needs interactive mode", "error");
				return;
			}
			if (!loadRaw().catalog?.length) {
				ctx.ui.notify("Catalog empty — open /9router and sync models first.", "warning");
			} else if (isSyncStale(loadRaw().lastSync)) {
				ctx.ui.notify("Catalog is stale (>24h). Consider /9router → Sync models.", "warning");
			}
			await runToolsUI(pi, ctx);
			applyFromDisk();
		},
	});
}

// Test helpers
export { generateImages, loadImageRef, modelsForCap, getCapState };
