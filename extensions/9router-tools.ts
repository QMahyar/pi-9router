/**
 * pi-9router-tools — Capability tools for 9Router (companion to 9router.ts)
 *
 * Config UI:  /9router-tools
 * Voice input: Ctrl+Shift+V (only when STT is enabled) → mic → STT → editor
 *
 * Tools (toggle in /9router-tools; inactive tools are removed from the model context):
 *   nr_image_generate  POST /v1/images/generations
 *   nr_tts             POST /v1/audio/speech
 *   nr_stt             POST /v1/audio/transcriptions
 *   nr_embed           POST /v1/embeddings
 *   nr_web_search      POST /v1/search
 *   nr_web_fetch       POST /v1/web/fetch
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
	unlinkSync,
	readdirSync,
} from "node:fs";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// ── Shared config ───────────────────────────────────────────────

const CONFIG_PATH = join(homedir(), ".pi", "agent", "9router.json");
const DEFAULT_ENDPOINT = "http://localhost:20128";
const DEFAULT_OUTPUT_DIR = join(homedir(), ".pi", "agent", "9router-output");
const VOICE_SHORTCUT = "ctrl+shift+v";
const DEFAULT_VOICE_SECONDS = 8;

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
	model?: string;
}

interface VoiceSettings {
	/** Recording length in seconds (3–60) */
	durationSec?: number;
	/** Windows dshow device name, optional */
	device?: string;
	/** replace editor text vs append */
	mode?: "replace" | "append";
}

interface ToolsConfigSlice {
	endpoint?: string;
	apiKey?: string;
	catalog?: CatalogEntry[];
	counts?: Record<string, number>;
	lastSync?: string;
	capabilities?: Partial<Record<CapId, CapState>>;
	outputDir?: string;
	voice?: VoiceSettings;
	/** Optional absolute path to ffmpeg */
	ffmpegPath?: string;
}

interface CapDef {
	id: CapId;
	tool: string;
	label: string;
	catalogKind: string | ((e: CatalogEntry) => boolean);
	defaultEnabled: boolean;
	/** Short row subtitle in settings */
	blurb: string;
}

const CAPS: CapDef[] = [
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
		id: "stt",
		tool: "nr_stt",
		label: "Speech to text",
		catalogKind: "stt",
		defaultEnabled: true,
		blurb: "Audio file / voice input",
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
			e.kind === "web" &&
			(e.id.endsWith("/search") || /search/i.test(e.id) || String((e as any).kind) === "webSearch"),
		defaultEnabled: true,
		blurb: "Query → results",
	},
	{
		id: "web_fetch",
		tool: "nr_web_fetch",
		label: "Web fetch",
		catalogKind: (e) =>
			e.kind === "web" &&
			(e.id.endsWith("/fetch") || /fetch/i.test(e.id) || String((e as any).kind) === "webFetch"),
		defaultEnabled: true,
		blurb: "URL → markdown",
	},
];

// ── Config I/O ──────────────────────────────────────────────────

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
	const next: ToolsConfigSlice = { ...cur, ...patch };
	if (patch.capabilities) {
		next.capabilities = { ...(cur.capabilities || {}), ...patch.capabilities };
	}
	if (patch.voice) {
		next.voice = { ...(cur.voice || {}), ...patch.voice };
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
	return modelsForCap(cfg, cap)[0]?.id || null;
}

function voiceSettings(cfg: ToolsConfigSlice): Required<Pick<VoiceSettings, "durationSec" | "mode">> & VoiceSettings {
	return {
		durationSec: Math.min(60, Math.max(3, cfg.voice?.durationSec ?? DEFAULT_VOICE_SECONDS)),
		mode: cfg.voice?.mode === "append" ? "append" : "replace",
		device: cfg.voice?.device,
	};
}

// ── FFmpeg resolution ───────────────────────────────────────────

function whichOnPath(bin: string): string | undefined {
	try {
		if (process.platform === "win32") {
			const out = execFileSync("where.exe", [bin], { encoding: "utf8" }).trim().split(/\r?\n/)[0];
			return out && existsSync(out) ? out : undefined;
		}
		const out = execFileSync("which", [bin], { encoding: "utf8" }).trim();
		return out && existsSync(out) ? out : undefined;
	} catch {
		return undefined;
	}
}

function tryFfmpegStatic(): string | undefined {
	const candidates: string[] = [];

	const tryRequireFrom = (fromFile: string) => {
		try {
			const req = createRequire(fromFile);
			const bin = req("ffmpeg-static") as string;
			if (typeof bin === "string" && bin) candidates.push(bin);
		} catch {
			/* missing */
		}
	};

	// 1) Extension file location (jiti / file URL)
	try {
		const extFile = fileURLToPath(import.meta.url);
		tryRequireFrom(extFile);
		// walk up a few parents for node_modules/ffmpeg-static
		let dir = dirname(extFile);
		for (let i = 0; i < 6; i++) {
			tryRequireFrom(join(dir, "package.json"));
			const win = join(dir, "node_modules", "ffmpeg-static", "ffmpeg.exe");
			const nix = join(dir, "node_modules", "ffmpeg-static", "ffmpeg");
			if (existsSync(win)) candidates.push(win);
			if (existsSync(nix)) candidates.push(nix);
			const parent = dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
	} catch {
		/* import.meta may be unavailable */
	}

	// 2) Common pi package install roots
	const roots = [
		join(homedir(), ".pi", "agent", "npm"),
		join(homedir(), ".pi", "agent", "git"),
		join(homedir(), ".pi", "npm"),
		join(homedir(), ".pi", "git"),
		process.cwd(),
	];
	for (const root of roots) {
		tryRequireFrom(join(root, "package.json"));
		// shallow scan one level of package folders
		try {
			for (const name of readdirSync(root, { withFileTypes: true })) {
				if (!name.isDirectory()) continue;
				const base = join(root, name.name);
				tryRequireFrom(join(base, "package.json"));
				const win = join(base, "node_modules", "ffmpeg-static", "ffmpeg.exe");
				const nix = join(base, "node_modules", "ffmpeg-static", "ffmpeg");
				if (existsSync(win)) candidates.push(win);
				if (existsSync(nix)) candidates.push(nix);
			}
		} catch {
			/* */
		}
	}

	for (const c of candidates) {
		if (c && existsSync(c)) return c;
	}
	return undefined;
}

function resolveFfmpeg(cfg?: ToolsConfigSlice): { path?: string; source?: string } {
	const c = cfg || loadRaw();
	if (c.ffmpegPath && existsSync(c.ffmpegPath)) {
		return { path: c.ffmpegPath, source: "config" };
	}
	const env = process.env.FFMPEG_PATH || process.env.FFMPEG_BINARY;
	if (env && existsSync(env)) return { path: env, source: "env" };
	const onPath = whichOnPath("ffmpeg") || whichOnPath("ffmpeg.exe");
	if (onPath) return { path: onPath, source: "PATH" };
	const bundled = tryFfmpegStatic();
	if (bundled) return { path: bundled, source: "ffmpeg-static" };
	return {};
}

// ── HTTP ────────────────────────────────────────────────────────

function authHeaders(apiKey: string, json = true): Record<string, string> {
	const h: Record<string, string> = { Accept: "*/*" };
	if (json) h["Content-Type"] = "application/json";
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
		return {
			ok: true,
			status: res.status,
			bytes: new Uint8Array(await res.arrayBuffer()),
			contentType: res.headers.get("content-type") || "application/octet-stream",
		};
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

// ── File / misc helpers ─────────────────────────────────────────

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

async function downloadUrl(url: string, signal?: AbortSignal) {
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

// ── Active tools ────────────────────────────────────────────────

function applyToolActivation(pi: ExtensionAPI, cfg: ToolsConfigSlice): void {
	const active = new Set(pi.getActiveTools());
	const allKnown = new Set(pi.getAllTools().map((t) => t.name));
	for (const cap of CAPS) {
		if (!allKnown.has(cap.tool)) continue;
		if (getCapState(cfg, cap).enabled) active.add(cap.tool);
		else active.delete(cap.tool);
	}
	pi.setActiveTools([...active]);
}

// ── STT helper (shared by tool + voice shortcut) ────────────────

async function transcribeFile(
	cfg: ToolsConfigSlice,
	filePath: string,
	opts: { model?: string; language?: string; prompt?: string; response_format?: string } = {},
	signal?: AbortSignal,
): Promise<{ ok: true; text: string; model: string } | { ok: false; error: string }> {
	const cap = CAPS.find((c) => c.id === "stt")!;
	const blocked = needCap(cfg, cap);
	if (blocked) return { ok: false, error: blocked };
	const model = resolveModel(cfg, cap, opts.model);
	if (!model) return { ok: false, error: "No STT model. Sync /9router and set a default in /9router-tools." };
	if (!existsSync(filePath)) return { ok: false, error: `File not found: ${filePath}` };

	const bytes = readFileSync(filePath);
	const form = new FormData();
	form.append("model", model);
	form.append("file", new Blob([new Uint8Array(bytes)]), basename(filePath));
	if (opts.language) form.append("language", opts.language);
	if (opts.prompt) form.append("prompt", opts.prompt);
	if (opts.response_format) form.append("response_format", opts.response_format);

	const res = await postMultipart(`${endpointOf(cfg)}/v1/audio/transcriptions`, apiKeyOf(cfg), form, signal);
	if (!res.ok) return { ok: false, error: `STT failed (${res.status}): ${res.error}` };
	const text =
		typeof res.data === "string" ? res.data : res.data?.text || JSON.stringify(res.data);
	return { ok: true, text: String(text).trim(), model };
}

// ── Mic recording ───────────────────────────────────────────────

/**
 * List Windows DirectShow audio capture devices via ffmpeg.
 * ffmpeg always exits non-zero for -list_devices; names are on stderr.
 */
function listWindowsAudioDevices(ffmpegPath: string): string[] {
	let text = "";
	try {
		execFileSync(
			ffmpegPath,
			["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"],
			{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
		);
	} catch (err: any) {
		const stderr = err?.stderr;
		text = Buffer.isBuffer(stderr)
			? stderr.toString("utf8")
			: String(stderr || err?.message || err);
	}

	const names: string[] = [];
	const seen = new Set<string>();

	// Primary:  "Microphone Name" (audio)
	const reAudio = /"([^"]+)"\s*\(audio\)/gi;
	let m: RegExpExecArray | null;
	while ((m = reAudio.exec(text))) {
		const n = m[1].trim();
		if (n && !seen.has(n.toLowerCase())) {
			seen.add(n.toLowerCase());
			names.push(n);
		}
	}

	// Fallback: parse the "DirectShow audio devices" section only
	if (!names.length) {
		const audioSection = text.split(/DirectShow\s+audio\s+devices/i)[1] || "";
		const beforeVideo = audioSection.split(/DirectShow\s+video\s+devices/i)[0] || audioSection;
		const reQuoted = /"([^"]+)"/g;
		while ((m = reQuoted.exec(beforeVideo))) {
			const n = m[1].trim();
			if (n && !seen.has(n.toLowerCase()) && !/^dummy$/i.test(n)) {
				seen.add(n.toLowerCase());
				names.push(n);
			}
		}
	}

	return names;
}

/**
 * dshow input for spawn argv (not shell):
 *   audio=Microphone (Realtek(R) Audio)
 * Pass as ONE array element so spaces are fine. Do NOT wrap in extra quotes —
 * ffmpeg would look for a device name that includes the quote characters.
 */
function dshowAudioInput(deviceName: string): string {
	const cleaned = deviceName.replace(/"/g, "").trim();
	return `audio=${cleaned}`;
}

function recordMicrophone(opts: {
	ffmpegPath: string;
	seconds: number;
	device?: string;
	outPath: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
	return new Promise((resolvePromise) => {
		const { ffmpegPath, seconds, device, outPath } = opts;
		ensureDir(dirname(outPath));
		const args: string[] = ["-y", "-hide_banner", "-loglevel", "error"];

		if (process.platform === "win32") {
			if (!device || !device.trim() || /^default$/i.test(device)) {
				resolvePromise({
					ok: false,
					error:
						'No microphone selected. Open /9router-tools → Voice input → pick a mic (Windows has no "default" dshow device).',
				});
				return;
			}
			// Critical: quotes around the device name for dshow
			args.push(
				"-f",
				"dshow",
				"-i",
				dshowAudioInput(device),
				"-t",
				String(seconds),
				"-ac",
				"1",
				"-ar",
				"16000",
				outPath,
			);
		} else if (process.platform === "darwin") {
			args.push("-f", "avfoundation", "-i", ":0", "-t", String(seconds), "-ac", "1", "-ar", "16000", outPath);
		} else {
			args.push("-f", "pulse", "-i", "default", "-t", String(seconds), "-ac", "1", "-ar", "16000", outPath);
		}

		const child = spawn(ffmpegPath, args, { stdio: ["ignore", "pipe", "pipe"] });
		let err = "";
		child.stderr?.on("data", (d) => {
			err += String(d);
		});
		child.on("error", (e) => resolvePromise({ ok: false, error: e.message }));
		child.on("close", (code) => {
			if (code === 0 && existsSync(outPath) && statSync(outPath).size > 100) {
				resolvePromise({ ok: true });
			} else {
				const hint =
					process.platform === "win32"
						? " Pick the correct mic in /9router-tools → Voice input."
						: "";
				const msg = (err.trim() || `ffmpeg exited ${code}.`) + hint;
				resolvePromise({ ok: false, error: msg.slice(0, 400) });
			}
		});
	});
}

async function ensureWindowsMic(
	ui: ExtensionContext["ui"],
	cfg: ToolsConfigSlice,
	ffmpegPath: string,
	forcePick = false,
): Promise<string | null> {
	const devices = listWindowsAudioDevices(ffmpegPath);
	if (!devices.length) {
		ui.notify(
			"No DirectShow audio devices found. Check Windows mic permissions and that ffmpeg can see devices.",
			"error",
		);
		return null;
	}

	const saved = cfg.voice?.device?.trim();
	const savedOk = saved && devices.some((d) => d === saved);

	if (!forcePick && savedOk) return saved!;

	if (!forcePick && devices.length === 1) {
		saveRaw({ voice: { device: devices[0] } });
		return devices[0];
	}

	const items = devices.map((d) => (d === saved ? `* ${d}` : `  ${d}`));
	items.push("Cancel");
	const pick = await ui.select("Microphone for voice input", items);
	if (!pick || pick === "Cancel") return null;
	const name = pick.replace(/^\*\s/, "").replace(/^\s\s/, "").trim();
	if (!name || !devices.includes(name)) return null;
	saveRaw({ voice: { device: name } });
	return name;
}

async function runVoiceToEditor(ctx: ExtensionContext): Promise<void> {
	const ui = ctx.ui;
	const cfg = loadRaw();
	const sttCap = CAPS.find((c) => c.id === "stt")!;
	if (!getCapState(cfg, sttCap).enabled) {
		ui.notify("Speech to text is off. Enable it in /9router-tools.", "warning");
		return;
	}

	const ff = resolveFfmpeg(cfg);
	if (!ff.path) {
		ui.notify(
			"ffmpeg not found. Install system ffmpeg (winget install Gyan.FFmpeg) or reinstall this package (bundles ffmpeg-static).",
			"error",
		);
		return;
	}

	const vs = voiceSettings(cfg);
	let device = vs.device;

	if (process.platform === "win32") {
		// Never use "default" — dshow requires the exact device name
		const mic = await ensureWindowsMic(ui, cfg, ff.path, false);
		if (!mic) return;
		device = mic;
	}

	const outPath = join(outputDirOf(cfg), `voice-${stamp()}.wav`);
	ui.notify(`Recording ${vs.durationSec}s… speak now`, "info");
	const rec = await recordMicrophone({
		ffmpegPath: ff.path,
		seconds: vs.durationSec,
		device,
		outPath,
	});
	if (!rec.ok) {
		// If device vanished, force re-pick next time
		if (process.platform === "win32" && /Could not find audio/i.test(rec.error)) {
			const cur = loadRaw();
			const voice = { ...(cur.voice || {}) };
			delete voice.device;
			writeFileSync(CONFIG_PATH, JSON.stringify({ ...cur, voice }, null, 2));
			ui.notify(`${rec.error} Device cleared — press Ctrl+Shift+V again to pick a mic.`, "error");
		} else {
			ui.notify(rec.error, "error");
		}
		return;
	}

	ui.notify("Transcribing…", "info");
	const tr = await transcribeFile(cfg, outPath);
	try {
		unlinkSync(outPath);
	} catch {
		/* keep on failure */
	}

	if (!tr.ok) {
		ui.notify(tr.error, "error");
		return;
	}
	if (!tr.text) {
		ui.notify("No speech detected", "warning");
		return;
	}

	const mode = voiceSettings(loadRaw()).mode;
	if (mode === "append") {
		const cur = ui.getEditorText?.() ?? "";
		const next = cur ? (cur.endsWith("\n") || cur.endsWith(" ") ? cur + tr.text : cur + " " + tr.text) : tr.text;
		ui.setEditorText(next);
	} else {
		ui.setEditorText(tr.text);
	}
	ui.notify(`Voice → editor (${tr.model})`, "info");
}

// ── Clean TUI ───────────────────────────────────────────────────

function padLabel(label: string, width: number): string {
	if (label.length >= width) return label.slice(0, width);
	return label + " ".repeat(width - label.length);
}

function capRow(cfg: ToolsConfigSlice, cap: CapDef): string {
	const st = getCapState(cfg, cap);
	const n = modelsForCap(cfg, cap).length;
	const status = st.enabled ? "On " : "Off";
	const model = st.enabled ? shortModel(st.model || modelsForCap(cfg, cap)[0]?.id) : "—";
	// Fixed columns for a clean list
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
		return `${star}${m.id}${name}`;
	});
	items.push("Use first available (clear default)");
	items.push("Back");
	const pick = await ui.select(`${cap.label} — default model`, items);
	if (!pick || pick === "Back") return undefined;
	if (pick.startsWith("Use first")) return "";
	// rows: "* id" or "  id" optionally followed by "  Name"
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
			const text = models.map((m, i) => `${String(i + 1).padStart(2)}. ${m.id}`).join("\n");
			await ui.confirm(`${cap.label} (${models.length})`, text);
		}
	}
}

async function configureVoice(
	ctx: ExtensionContext,
	cfg: ToolsConfigSlice,
): Promise<ToolsConfigSlice> {
	const ui = ctx.ui;
	while (true) {
		const vs = voiceSettings(cfg);
		const sttOn = getCapState(cfg, CAPS.find((c) => c.id === "stt")!).enabled;
		const ff = resolveFfmpeg(cfg);
		const choice = await ui.select("Voice input", [
			`Shortcut: ${VOICE_SHORTCUT}${sttOn ? "" : "  (disabled — STT is off)"}`,
			`Duration: ${vs.durationSec}s`,
			`Editor: ${vs.mode === "append" ? "append" : "replace"}`,
			`Microphone: ${vs.device || "(auto)"}`,
			`ffmpeg: ${ff.path ? `${ff.source} — ${shortModel(ff.path, 40)}` : "NOT FOUND"}`,
			"Set ffmpeg path",
			"Refresh audio devices",
			"Test record → editor",
			"Back",
		]);
		if (!choice || choice === "Back") return cfg;

		if (choice.startsWith("Duration")) {
			const raw = await ui.input("Recording length (seconds, 3–60)", String(vs.durationSec));
			const n = Number(raw);
			if (Number.isFinite(n)) {
				cfg = saveRaw({ voice: { durationSec: Math.min(60, Math.max(3, Math.round(n))) } });
			}
			continue;
		}

		if (choice.startsWith("Editor")) {
			const mode = await ui.select("After transcription", ["Replace editor text", "Append to editor", "Back"]);
			if (!mode || mode === "Back") continue;
			cfg = saveRaw({ voice: { mode: mode.startsWith("Append") ? "append" : "replace" } });
			continue;
		}

		if (choice.startsWith("Microphone") || choice === "Refresh audio devices") {
			const ff2 = resolveFfmpeg(cfg);
			if (!ff2.path) {
				ui.notify("Install ffmpeg first", "error");
				continue;
			}
			if (process.platform !== "win32") {
				ui.notify("Device picker is for Windows dshow. macOS/Linux use system default.", "info");
				continue;
			}
			const mic = await ensureWindowsMic(ctx, cfg, ff2.path, true);
			cfg = loadRaw();
			if (mic) ui.notify(`Microphone: ${mic}`, "info");
			continue;
		}

		if (choice === "Set ffmpeg path") {
			const p = await ui.input("Absolute path to ffmpeg binary", cfg.ffmpegPath || ff.path || "");
			if (p?.trim()) {
				if (!existsSync(p.trim())) ui.notify("Path does not exist", "error");
				else cfg = saveRaw({ ffmpegPath: p.trim() });
			}
			continue;
		}

		if (choice === "Test record → editor") {
			await runVoiceToEditor(ctx);
			cfg = loadRaw();
			continue;
		}
	}
}

async function showStatus(ui: ExtensionContext["ui"], cfg: ToolsConfigSlice): Promise<void> {
	const ff = resolveFfmpeg(cfg);
	const on = CAPS.filter((c) => getCapState(cfg, c).enabled).length;
	const lines = [
		`Endpoint     ${endpointOf(cfg)}`,
		`Catalog      ${cfg.lastSync ? new Date(cfg.lastSync).toLocaleString() : "never synced"}`,
		`Output       ${outputDirOf(cfg)}`,
		`Tools on     ${on} / ${CAPS.length}`,
		`ffmpeg       ${ff.path ? `${ff.source}: ${ff.path}` : "missing"}`,
		`Voice        ${VOICE_SHORTCUT} · ${voiceSettings(cfg).durationSec}s · ${getCapState(cfg, CAPS.find((c) => c.id === "stt")!).enabled ? "armed" : "disarmed (STT off)"}`,
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
		const header = cfg.catalog?.length
			? `Synced · ${Object.entries(cfg.counts || {})
					.map(([k, v]) => `${k} ${v}`)
					.join(" · ")}`
			: "Catalog empty — run /9router → Sync models";

		const rows = CAPS.map((c) => capRow(cfg, c));
		const menu = [
			...rows,
			"─".repeat(48),
			"Output folder",
			"Voice input",
			"Status",
			"Close",
		];

		const choice = await ui.select(`9Router Tools\n${header}`, menu);
		if (!choice || choice === "Close") break;
		if (choice.startsWith("─")) continue;

		if (choice === "Output folder") {
			const next = await ui.input("Folder for generated images/audio", outputDirOf(cfg));
			if (next?.trim()) {
				cfg = saveRaw({ outputDir: next.trim() });
				ui.notify("Output folder saved", "info");
			}
			continue;
		}

		if (choice === "Voice input") {
			cfg = await configureVoice(ctx, cfg);
			continue;
		}

		if (choice === "Status") {
			await showStatus(ui, cfg);
			continue;
		}

		const cap = CAPS.find((c) => choice.startsWith(padLabel(c.label, 18)) || choice.includes(c.label));
		if (cap) {
			cfg = await configureCap(pi, ui, cfg, cap);
		}
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

// ── Tools ───────────────────────────────────────────────────────

function registerImageTool(pi: ExtensionAPI) {
	const cap = CAPS.find((c) => c.id === "image")!;
	pi.registerTool({
		name: cap.tool,
		label: cap.label,
		description:
			"Generate an image with 9Router and save it to disk. Use for icons, logos, illustrations, UI mockups, diagrams-as-images, and concept art. Returns the file path (and may include the image inline). Default model is configured in /9router-tools; only pass model to override.",
		promptSnippet: "Generate images via 9Router (saves file path)",
		promptGuidelines: [
			"Use nr_image_generate when the user asks to generate, draw, render, design, or create an image, icon, logo, symbol, illustration, mockup, or concept art.",
			"Write a detailed prompt (subject, style, colors, composition). Do not pass model unless the user names a specific image model.",
			"Optional: size (e.g. 1024x1024), quality (standard|hd), n (1-4), filename. Some providers ignore size/quality.",
			"After success, report the saved file path to the user. Do not claim you embedded the image in the chat unless the tool result includes image content.",
		],
		parameters: Type.Object({
			prompt: Type.String({ description: "Detailed image generation prompt" }),
			model: Type.Optional(Type.String({ description: "Override default image model id" })),
			size: Type.Optional(Type.String({ description: "e.g. 1024x1024, 1792x1024" })),
			n: Type.Optional(Type.Integer({ description: "Images to generate (1-4)", minimum: 1, maximum: 4 })),
			quality: Type.Optional(Type.String({ description: "standard | hd" })),
			filename: Type.Optional(Type.String({ description: "Output filename only (no directories)" })),
		}),
		async execute(_id, params, signal, onUpdate, ctx) {
			const cfg = loadRaw();
			const blocked = needCap(cfg, cap);
			if (blocked) return toolError(blocked);
			const model = resolveModel(cfg, cap, params.model);
			if (!model) return toolError("No image model. Sync /9router and set a default in /9router-tools.");

			const ep = endpointOf(cfg);
			const key = apiKeyOf(cfg);
			const outDir = outputDirOf(cfg);
			const n = Math.min(params.n ?? 1, 4);
			onUpdate?.({ content: [{ type: "text", text: `Generating with ${model}…` }] });

			const body: Record<string, unknown> = { model, prompt: params.prompt, n };
			if (params.size) body.size = params.size;
			if (params.quality) body.quality = params.quality;

			const saved: string[] = [];
			const bin = await postBinary(`${ep}/v1/images/generations?response_format=binary`, key, { ...body, n: 1 }, signal);
			if (bin.ok && bin.bytes.length > 100) {
				const ext = extFromContentType(bin.contentType, ".png");
				const name =
					params.filename?.replace(/[^\w.\-]+/g, "_") ||
					`img-${stamp()}-${slug(params.prompt)}-${randomBytes(2).toString("hex")}${ext}`;
				saved.push(writeBytes(outDir, name, bin.bytes));
			} else {
				const res = await postJson(`${ep}/v1/images/generations`, key, { ...body, response_format: "b64_json" }, signal);
				if (!res.ok) {
					const res2 = await postJson(`${ep}/v1/images/generations`, key, { ...body, response_format: "url" }, signal);
					if (!res2.ok) return toolError(`Image generation failed (${res2.status}): ${res2.error}`, { model });
					for (let i = 0; i < (res2.data?.data || []).length; i++) {
						const url = res2.data.data[i].url;
						if (!url) continue;
						const dl = await downloadUrl(url, signal);
						if (!dl) continue;
						const ext = extFromContentType(dl.contentType, ".png");
						const nm = params.filename?.replace(/[^\w.\-]+/g, "_") || `img-${stamp()}-${i}${ext}`;
						saved.push(writeBytes(outDir, nm, dl.bytes));
					}
				} else {
					for (let i = 0; i < (res.data?.data || []).length; i++) {
						const b64 = res.data.data[i].b64_json;
						if (!b64) continue;
						const dec = decodeDataUrlOrB64(b64);
						if (!dec) continue;
						const nm = params.filename?.replace(/[^\w.\-]+/g, "_") || `img-${stamp()}-${i}${dec.ext}`;
						saved.push(writeBytes(outDir, nm, dec.bytes));
					}
				}
			}

			if (!saved.length) return toolError("No image data returned.", { model });
			const text = [`Generated ${saved.length} image(s) · ${model}`, `Prompt: ${params.prompt}`, ...saved.map((p) => `File: ${p}`)].join(
				"\n",
			);

			const content: Array<
				| { type: "text"; text: string }
				| { type: "image"; source: { type: "base64"; mediaType: string; data: string } }
			> = [{ type: "text", text }];
			try {
				const first = saved[0];
				const st = statSync(first);
				if (st.size > 0 && st.size < 4_000_000) {
					const bytes = readFileSync(first);
					const ext = extname(first).toLowerCase();
					const mediaType =
						ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".webp" ? "image/webp" : "image/png";
					content.push({ type: "image", source: { type: "base64", mediaType, data: bytes.toString("base64") } });
				}
			} catch {
				/* */
			}
			return { content, details: { model, files: saved, prompt: params.prompt, cwd: ctx.cwd } };
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

function registerTtsTool(pi: ExtensionAPI) {
	const cap = CAPS.find((c) => c.id === "tts")!;
	pi.registerTool({
		name: cap.tool,
		label: cap.label,
		description:
			"Convert text to speech via 9Router and save an audio file (mp3/wav). Use for narration, voiceover, or reading text aloud. Default voice/model is set in /9router-tools.",
		promptSnippet: "Text-to-speech via 9Router (saves audio file)",
		promptGuidelines: [
			"Use nr_tts when the user wants speech, voiceover, narration, TTS, or an audio reading of text.",
			"Pass the full text in input. Omit model unless the user requests a specific voice/model id.",
			"Return the saved audio file path. Do not invent playback inside the terminal.",
		],
		parameters: Type.Object({
			input: Type.String({ description: "Text to speak" }),
			model: Type.Optional(Type.String({ description: "Override default TTS model/voice id" })),
			filename: Type.Optional(Type.String({ description: "Output filename only" })),
		}),
		async execute(_id, params, signal, onUpdate) {
			const cfg = loadRaw();
			const blocked = needCap(cfg, cap);
			if (blocked) return toolError(blocked);
			const model = resolveModel(cfg, cap, params.model);
			if (!model) return toolError("No TTS model. Sync /9router and set a default in /9router-tools.");
			onUpdate?.({ content: [{ type: "text", text: `Synthesizing · ${model}` }] });

			const ep = endpointOf(cfg);
			const key = apiKeyOf(cfg);
			const outDir = outputDirOf(cfg);
			const res = await postJson(`${ep}/v1/audio/speech?response_format=json`, key, { model, input: params.input }, signal);
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
			if (!bytes?.length) return toolError("Empty audio.", { model });
			const name = params.filename?.replace(/[^\w.\-]+/g, "_") || `tts-${stamp()}-${slug(params.input)}${ext}`;
			const path = writeBytes(outDir, name, bytes);
			return toolOk(`Speech saved.\nModel: ${model}\nFile: ${path}\nChars: ${params.input.length}`, {
				model,
				file: path,
				bytes: bytes.length,
			});
		},
		renderResult(result, { expanded }, theme) {
			const d = (result.details || {}) as { file?: string };
			return compactResult("nr_tts", d.file ? basename(d.file) : "", theme, expanded, textFromResult(result));
		},
	});
}

function registerSttTool(pi: ExtensionAPI) {
	const cap = CAPS.find((c) => c.id === "stt")!;
	pi.registerTool({
		name: cap.tool,
		label: cap.label,
		description:
			"Transcribe an existing audio file via 9Router (Whisper/Groq/Gemini/…). Pass a local filesystem path. For live microphone input into the pi editor, the user uses Ctrl+Shift+V (not this tool).",
		promptSnippet: "Transcribe audio file via 9Router",
		promptGuidelines: [
			"Use nr_stt to transcribe an audio file on disk (mp3, wav, m4a, webm, ogg, flac).",
			"Pass file as a real path relative to the project or absolute. Strip a leading @ if present.",
			"Optional: language (ISO-639-1), prompt (vocabulary hint), response_format (json|text|verbose_json|srt|vtt).",
			"Do not use nr_stt for live mic capture; tell the user to press Ctrl+Shift+V when STT is enabled in /9router-tools.",
		],
		parameters: Type.Object({
			file: Type.String({ description: "Path to audio file" }),
			model: Type.Optional(Type.String({ description: "Override default STT model" })),
			language: Type.Optional(Type.String({ description: "ISO-639-1 e.g. en, vi" })),
			prompt: Type.Optional(Type.String({ description: "Optional vocabulary hint" })),
			response_format: Type.Optional(Type.String({ description: "json | text | verbose_json | srt | vtt" })),
		}),
		async execute(_id, params, signal, onUpdate, ctx) {
			const cfg = loadRaw();
			const blocked = needCap(cfg, cap);
			if (blocked) return toolError(blocked);
			const filePath = resolveUserPath(params.file, ctx.cwd);
			onUpdate?.({ content: [{ type: "text", text: "Transcribing…" }] });
			const tr = await transcribeFile(
				cfg,
				filePath,
				{
					model: params.model,
					language: params.language,
					prompt: params.prompt,
					response_format: params.response_format,
				},
				signal,
			);
			if (!tr.ok) return toolError(tr.error, { file: filePath });
			return toolOk(tr.text, { model: tr.model, file: filePath });
		},
		renderResult(result, { expanded }, theme) {
			const d = (result.details || {}) as { file?: string };
			return compactResult("nr_stt", d.file ? basename(d.file) : "", theme, expanded, textFromResult(result));
		},
	});
}

function registerEmbedTool(pi: ExtensionAPI) {
	const cap = CAPS.find((c) => c.id === "embed")!;
	pi.registerTool({
		name: cap.tool,
		label: cap.label,
		description:
			"Create text embeddings via 9Router for RAG/similarity. By default returns dimensions + a short preview only (not full vectors). Set full=true only when the user needs the complete vector arrays.",
		promptSnippet: "Create embeddings via 9Router",
		promptGuidelines: [
			"Use nr_embed for embeddings, vectors, semantic similarity, or RAG chunk encoding.",
			"Pass one string, or multiple chunks separated by a line containing only --- .",
			"Omit model unless the user specifies one. Optional dimensions for OpenAI v3-style models.",
			"Do not set full=true unless necessary — full vectors are huge and waste context.",
		],
		parameters: Type.Object({
			input: Type.String({ description: "Text, or multiple texts split by \\n---\\n" }),
			model: Type.Optional(Type.String({ description: "Override default embedding model" })),
			dimensions: Type.Optional(Type.Integer({ description: "Optional dims (OpenAI v3)", minimum: 1 })),
			full: Type.Optional(Type.Boolean({ description: "Include full vectors (default false)" })),
		}),
		async execute(_id, params, signal, onUpdate) {
			const cfg = loadRaw();
			const blocked = needCap(cfg, cap);
			if (blocked) return toolError(blocked);
			const model = resolveModel(cfg, cap, params.model);
			if (!model) return toolError("No embedding model. Sync /9router and set a default in /9router-tools.");
			const parts = params.input.includes("\n---\n")
				? params.input
						.split("\n---\n")
						.map((s) => s.trim())
						.filter(Boolean)
				: [params.input];
			onUpdate?.({ content: [{ type: "text", text: `Embedding ${parts.length} input(s)…` }] });
			const body: Record<string, unknown> = { model, input: parts.length === 1 ? parts[0] : parts };
			if (params.dimensions) body.dimensions = params.dimensions;
			const res = await postJson(`${endpointOf(cfg)}/v1/embeddings`, apiKeyOf(cfg), body, signal);
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
			const details: Record<string, unknown> = { model, count: data.length, dimensions: data[0]?.embedding?.length };
			if (params.full) details.embeddings = data.map((d: any) => d.embedding);
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

function registerWebSearchTool(pi: ExtensionAPI) {
	const cap = CAPS.find((c) => c.id === "web_search")!;
	pi.registerTool({
		name: cap.tool,
		label: cap.label,
		description:
			"Search the web via 9Router (Exa/Tavily/Brave/…). Returns titles, URLs, snippets. For full page text of a known URL use nr_web_fetch. Default search model is set in /9router-tools.",
		promptSnippet: "Web search via 9Router",
		promptGuidelines: [
			"Use nr_web_search for current information, docs lookup, news, or finding sources on the web.",
			"Write a clear natural-language query. Omit model unless the user picks a provider (e.g. exa/search).",
			"Optional: max_results (default 5), search_type (web|news), country, language.",
			"After search, use nr_web_fetch on the best URLs when you need full page content.",
			"Prefer nr_web_search over guessing. Do not use it for local codebase questions.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Search query" }),
			model: Type.Optional(Type.String({ description: "Override default search model id" })),
			max_results: Type.Optional(Type.Integer({ description: "1-20, default 5", minimum: 1, maximum: 20 })),
			search_type: Type.Optional(Type.String({ description: "web | news" })),
			country: Type.Optional(Type.String({ description: "Country bias if supported" })),
			language: Type.Optional(Type.String({ description: "Language bias if supported" })),
		}),
		async execute(_id, params, signal, onUpdate) {
			const cfg = loadRaw();
			const blocked = needCap(cfg, cap);
			if (blocked) return toolError(blocked);
			const model = resolveModel(cfg, cap, params.model);
			if (!model) return toolError("No web search model. Sync /9router and set a default in /9router-tools.");
			onUpdate?.({ content: [{ type: "text", text: `Searching · ${model}` }] });
			const body: Record<string, unknown> = {
				model,
				query: params.query,
				max_results: params.max_results ?? 5,
			};
			if (params.search_type) body.search_type = params.search_type;
			if (params.country) body.country = params.country;
			if (params.language) body.language = params.language;
			const res = await postJson(`${endpointOf(cfg)}/v1/search`, apiKeyOf(cfg), body, signal);
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

function registerWebFetchTool(pi: ExtensionAPI) {
	const cap = CAPS.find((c) => c.id === "web_fetch")!;
	pi.registerTool({
		name: cap.tool,
		label: cap.label,
		description:
			"Fetch a URL as markdown/text/HTML via 9Router (Exa/Firecrawl/Jina/Tavily/…). Use when you already have a URL. For discovery use nr_web_search first.",
		promptSnippet: "Fetch URL content via 9Router",
		promptGuidelines: [
			"Use nr_web_fetch when you have an absolute http(s) URL and need page content.",
			"Default format is markdown. Optional max_characters to truncate long pages.",
			"Omit model unless the user specifies a fetch provider (e.g. exa/fetch).",
			"Do not use nr_web_fetch for local files — use the read tool instead.",
		],
		parameters: Type.Object({
			url: Type.String({ description: "Absolute http(s) URL" }),
			model: Type.Optional(Type.String({ description: "Override default fetch model" })),
			format: Type.Optional(Type.String({ description: "markdown | text | html" })),
			max_characters: Type.Optional(Type.Integer({ description: "Truncate length", minimum: 0 })),
		}),
		async execute(_id, params, signal, onUpdate) {
			const cfg = loadRaw();
			const blocked = needCap(cfg, cap);
			if (blocked) return toolError(blocked);
			const model = resolveModel(cfg, cap, params.model);
			if (!model) return toolError("No web fetch model. Sync /9router and set a default in /9router-tools.");
			if (!/^https?:\/\//i.test(params.url)) return toolError("url must be absolute http(s)");
			onUpdate?.({ content: [{ type: "text", text: `Fetching · ${params.url}` }] });
			const body: Record<string, unknown> = {
				model,
				url: params.url,
				format: params.format || "markdown",
			};
			if (params.max_characters != null) body.max_characters = params.max_characters;
			const ep = endpointOf(cfg);
			const key = apiKeyOf(cfg);
			let res = await postJson(`${ep}/v1/web/fetch`, key, body, signal);
			if (!res.ok && res.status === 404) res = await postJson(`${ep}/v1/fetch`, key, body, signal);
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
	registerImageTool(pi);
	registerTtsTool(pi);
	registerSttTool(pi);
	registerEmbedTool(pi);
	registerWebSearchTool(pi);
	registerWebFetchTool(pi);

	const applyFromDisk = () => applyToolActivation(pi, loadRaw());

	pi.on("session_start", async (_event, ctx) => {
		applyFromDisk();
		const cfg = loadRaw();
		const enabled = CAPS.filter((c) => getCapState(cfg, c).enabled).length;
		if (ctx.hasUI) {
			const ff = resolveFfmpeg(cfg);
			const sttOn = getCapState(cfg, CAPS.find((c) => c.id === "stt")!).enabled;
			const voice = sttOn && ff.path ? ` · ${VOICE_SHORTCUT}` : "";
			ctx.ui.setStatus(
				"9router-tools",
				ctx.ui.theme.fg("dim", `tools ${enabled}/${CAPS.length}${voice}`),
			);
		}
	});

	pi.events.on("9router:synced", () => applyFromDisk());

	// Voice → editor. Registered always; handler no-ops when STT is off.
	pi.registerShortcut(VOICE_SHORTCUT, {
		description: "Voice input (9Router STT → editor). Requires Speech to text On.",
		handler: async (ctx) => {
			if (!ctx.hasUI) return;
			await runVoiceToEditor(ctx);
		},
	});

	pi.registerCommand("9router-tools", {
		description: "9Router tools settings: enable capabilities, defaults, voice input, output folder",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI && ctx.mode !== "tui") {
				ctx.ui.notify("/9router-tools needs interactive mode", "error");
				return;
			}
			if (!loadRaw().catalog?.length) {
				ctx.ui.notify("Catalog empty — open /9router and sync models first.", "warning");
			}
			await runToolsUI(pi, ctx);
			applyFromDisk();
		},
	});
}
