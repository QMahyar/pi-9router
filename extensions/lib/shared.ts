/**
 * Shared helpers for 9router.ts and 9router-tools.ts.
 * Not an extension entry point (no default export) — only imported.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

// ── Paths / defaults ────────────────────────────────────────────

export const CONFIG_PATH = join(homedir(), ".pi", "agent", "9router.json");
export const DEFAULT_ENDPOINT = "http://localhost:20128";
export const DEFAULT_OUTPUT_DIR = join(homedir(), ".pi", "agent", "9router-output");

/** Request timeouts (ms). Esc/UI AbortSignal still wins when present. */
export const TIMEOUT = {
	health: 8_000,
	list: 45_000,
	info: 12_000,
	probe: 20_000,
	tool: 120_000,
	download: 60_000,
} as const;

/** Warn when lastSync is older than this. */
export const STALE_SYNC_MS = 24 * 60 * 60 * 1000;

// ── Types ───────────────────────────────────────────────────────

export interface ModelCapabilities {
	vision?: boolean;
	pdf?: boolean;
	audioInput?: boolean;
	videoInput?: boolean;
	imageOutput?: boolean;
	audioOutput?: boolean;
	search?: boolean;
	tools?: boolean;
	reasoning?: boolean;
	thinkingFormat?: string | null;
	thinkingCanDisable?: boolean;
	thinkingRange?: { min?: number; max?: number } | null;
	contextWindow?: number;
	maxOutput?: number;
	upstreamProvider?: string;
	[key: string]: unknown;
}

export interface RemoteModel {
	id: string;
	object?: string;
	owned_by?: string;
	name?: string;
	kind?: string;
	endpoint?: string;
	capabilities?: ModelCapabilities | string[];
	params?: string[];
	options?: unknown;
	created?: number;
}

// ── Config I/O ──────────────────────────────────────────────────

export function loadJsonFile(): Record<string, unknown> {
	if (!existsSync(CONFIG_PATH)) return {};
	try {
		return JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as Record<string, unknown>;
	} catch {
		return {};
	}
}

/** Deep-merge top-level keys; merges `capabilities` one level when both sides set it. */
export function saveJsonMerge(patch: Record<string, unknown>): Record<string, unknown> {
	const dir = dirname(CONFIG_PATH);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	const cur = loadJsonFile();
	const next: Record<string, unknown> = { ...cur, ...patch };
	if (patch.capabilities && typeof patch.capabilities === "object") {
		next.capabilities = {
			...((cur.capabilities as Record<string, unknown>) || {}),
			...(patch.capabilities as Record<string, unknown>),
		};
	}
	// Drop legacy keys from older installs
	delete next.voice;
	delete next.ffmpegPath;
	if (next.capabilities && typeof next.capabilities === "object") {
		const caps = { ...(next.capabilities as Record<string, unknown>) };
		delete caps.stt;
		next.capabilities = caps;
	}
	writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2));
	return next;
}

export function normalizeEndpoint(endpoint?: string): string {
	return (endpoint || process.env.NINEROUTER_URL || DEFAULT_ENDPOINT).replace(/\/$/, "");
}

export function resolveApiKey(apiKey?: string): string {
	return (apiKey || process.env.NINEROUTER_KEY || "9router").trim();
}

export function maskedKey(key?: string): string {
	if (!key) return "(not set)";
	if (key.length <= 8) return "••••";
	return key.slice(0, 4) + "…" + key.slice(-4);
}

export function baseV1(endpoint: string): string {
	return `${normalizeEndpoint(endpoint)}/v1`;
}

export function isSyncStale(lastSync?: string, maxAgeMs = STALE_SYNC_MS): boolean {
	if (!lastSync) return true;
	const t = Date.parse(lastSync);
	if (Number.isNaN(t)) return true;
	return Date.now() - t > maxAgeMs;
}

// ── Abort / timeout ─────────────────────────────────────────────

/** Combine optional parent signal with a timeout. */
export function withTimeout(timeoutMs: number, parent?: AbortSignal): AbortSignal {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
	const onParent = () => {
		clearTimeout(timer);
		ctrl.abort(parent?.reason ?? new Error("aborted"));
	};
	if (parent) {
		if (parent.aborted) onParent();
		else parent.addEventListener("abort", onParent, { once: true });
	}
	// Clear timer when our signal aborts for any reason so we don't leak
	ctrl.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
	return ctrl.signal;
}

function errMsg(err: unknown): string {
	if (!err) return "unknown error";
	if (err instanceof Error) {
		if (err.name === "AbortError" || /timeout/i.test(err.message)) {
			return err.message.includes("timeout") ? err.message : "aborted";
		}
		return err.message || String(err);
	}
	return String(err);
}

// ── HTTP ────────────────────────────────────────────────────────

export function authHeaders(apiKey: string, json = false): Record<string, string> {
	const h: Record<string, string> = { Accept: json ? "application/json" : "*/*" };
	if (json) h["Content-Type"] = "application/json";
	// Always send Bearer — dummy "9router" is fine when auth is off
	if (apiKey) h.Authorization = `Bearer ${apiKey}`;
	return h;
}

export async function httpGetJson<T>(
	url: string,
	apiKey: string,
	opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<{ ok: true; data: T } | { ok: false; status: number; error: string }> {
	const signal = withTimeout(opts.timeoutMs ?? TIMEOUT.list, opts.signal);
	try {
		const res = await fetch(url, {
			method: "GET",
			headers: authHeaders(apiKey, true),
			signal,
		});
		if (!res.ok) {
			const body = (await res.text()).slice(0, 240);
			return { ok: false, status: res.status, error: body || res.statusText };
		}
		return { ok: true, data: (await res.json()) as T };
	} catch (err) {
		return { ok: false, status: 0, error: errMsg(err) };
	}
}

export async function healthCheck(
	endpoint: string,
	opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<{ ok: boolean; error?: string; ms?: number }> {
	const signal = withTimeout(opts.timeoutMs ?? TIMEOUT.health, opts.signal);
	const t0 = Date.now();
	try {
		const res = await fetch(`${normalizeEndpoint(endpoint)}/api/health`, {
			signal,
			headers: { Accept: "application/json" },
		});
		const ms = Date.now() - t0;
		if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, ms };
		const data = (await res.json()) as { ok?: boolean };
		return { ok: data.ok === true, ms, error: data.ok === true ? undefined : "health.ok !== true" };
	} catch (err) {
		return { ok: false, error: errMsg(err), ms: Date.now() - t0 };
	}
}

export async function postJson(
	url: string,
	apiKey: string,
	body: unknown,
	opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<{ ok: true; status: number; data: any } | { ok: false; status: number; error: string }> {
	const signal = withTimeout(opts.timeoutMs ?? TIMEOUT.tool, opts.signal);
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
	} catch (err) {
		return { ok: false, status: 0, error: errMsg(err) };
	}
}

export async function postBinary(
	url: string,
	apiKey: string,
	body: unknown,
	opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<
	| { ok: true; status: number; bytes: Uint8Array; contentType: string }
	| { ok: false; status: number; error: string }
> {
	const signal = withTimeout(opts.timeoutMs ?? TIMEOUT.tool, opts.signal);
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
	} catch (err) {
		return { ok: false, status: 0, error: errMsg(err) };
	}
}

export async function downloadUrl(
	url: string,
	opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<{ bytes: Uint8Array; contentType: string } | null> {
	const signal = withTimeout(opts.timeoutMs ?? TIMEOUT.download, opts.signal);
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

// ── Concurrency ─────────────────────────────────────────────────

export async function mapConcurrent<T, R>(
	items: T[],
	limit: number,
	task: (item: T) => Promise<R>,
	signal?: AbortSignal,
): Promise<R[]> {
	const out: R[] = new Array(items.length);
	let next = 0;
	async function worker() {
		while (next < items.length) {
			if (signal?.aborted) return;
			const i = next++;
			out[i] = await task(items[i]);
		}
	}
	const n = Math.min(limit, Math.max(1, items.length));
	await Promise.all(Array.from({ length: n }, () => worker()));
	return out;
}

// ── Small utils ─────────────────────────────────────────────────

export function asCaps(raw: RemoteModel["capabilities"]): ModelCapabilities | undefined {
	if (!raw) return undefined;
	if (Array.isArray(raw)) {
		const out: ModelCapabilities = {};
		for (const tag of raw) {
			const t = String(tag).toLowerCase();
			if (t.includes("image") || t === "texttoimage" || t === "edit") out.imageOutput = true;
			if (t === "vision") out.vision = true;
			if (t === "reasoning" || t === "thinking") out.reasoning = true;
		}
		return out;
	}
	return raw;
}

/**
 * List row already has enough metadata to skip /v1/models/info.
 *
 * Chat lists often ship full capabilities without a display name or kind field
 * — that is still enough to register a pi model. Image/web lists are usually
 * thin ({ id, owned_by } only) and still need an info lookup for real names.
 */
export function listRowIsRich(m: RemoteModel): boolean {
	const caps = asCaps(m.capabilities);
	if (Array.isArray(m.capabilities) && m.capabilities.length > 0) return true;
	if (!caps || typeof caps !== "object") return false;
	// Numeric context / output is the strong signal from chat list endpoints.
	if (typeof caps.contextWindow === "number" && caps.contextWindow > 0) return true;
	if (typeof caps.maxOutput === "number" && caps.maxOutput > 0) return true;
	const hasName = Boolean(m.name?.trim());
	const hasKind = Boolean(m.kind?.trim());
	const hasFlag =
		caps.vision != null || caps.reasoning != null || caps.imageOutput != null || caps.tools != null;
	return hasFlag && (hasName || hasKind);
}

export function inferNameFromId(id: string): string {
	const slash = id.indexOf("/");
	const leaf = slash >= 0 ? id.slice(slash + 1) : id;
	return leaf
		.replace(/[-_]/g, " ")
		.replace(/\b\w/g, (c) => c.toUpperCase());
}
