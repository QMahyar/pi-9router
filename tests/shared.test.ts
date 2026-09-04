import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CAPS,
	INFO_CACHE_TTL,
	INFO_MISSING_TTL,
	TOOL_CAP_DEFAULTS,
	asCaps,
	capsBadgeOf,
	capsClassOf,
	countEnabledTools,
	downloadUrl,
	footerFromConfig,
	formatFooterText,
	formatUsageSummary,
	hasLegacyKeys,
	httpGetJson,
	inferNameFromId,
	isInfoCacheFresh,
	isSyncStale,
	listRowIsRich,
	loadJsonFile,
	logUsage,
	mapConcurrent,
	maskedKey,
	normalizeEndpoint,
	pickAutoDefaultModel,
	postJson,
	readUsageRecords,
	resolveApiKey,
	safeFilename,
	sanitizeInfoCache,
	sanitizeInfoMissing,
	sanitizeModelNames,
	saveJsonMerge,
	type FooterSnapshot,
	type RemoteModel,
} from "../extensions/lib/shared.ts";

// ── Endpoints / keys ─────────────────────────────────────────────

describe("normalizeEndpoint", () => {
	test("applies default when empty", () => {
		expect(normalizeEndpoint("")).toBe("http://localhost:20128");
	});
	test("strips trailing slashes", () => {
		expect(normalizeEndpoint("http://localhost:20128///")).toBe("http://localhost:20128");
	});
	test("assumes http for scheme-less input", () => {
		expect(normalizeEndpoint("localhost:20128")).toBe("http://localhost:20128");
		expect(normalizeEndpoint("192.168.1.5:20128/")).toBe("http://192.168.1.5:20128");
	});
	test("keeps explicit scheme", () => {
		expect(normalizeEndpoint("https://router.example.com")).toBe("https://router.example.com");
	});
});

describe("resolveApiKey", () => {
	test("falls back to dummy bearer", () => {
		expect(resolveApiKey()).toBe("9router");
		expect(resolveApiKey("")).toBe("9router");
	});
	test("uses provided key and trims", () => {
		expect(resolveApiKey(" sk-123 ")).toBe("sk-123");
	});
});

describe("maskedKey", () => {
	test("masks", () => {
		expect(maskedKey(undefined)).toBe("(not set)");
		expect(maskedKey("short")).toBe("••••");
		expect(maskedKey("sk-abcdefghijklmnop")).toBe("sk-a…mnop");
	});
});

describe("isSyncStale", () => {
	test("missing or invalid dates are stale", () => {
		expect(isSyncStale(undefined)).toBe(true);
		expect(isSyncStale("not-a-date")).toBe(true);
	});
	test("fresh is not stale, old is stale", () => {
		expect(isSyncStale(new Date().toISOString())).toBe(false);
		expect(isSyncStale(new Date(Date.now() - 25 * 3600_000).toISOString())).toBe(true);
	});
});

// ── Config I/O ───────────────────────────────────────────────────

describe("saveJsonMerge / loadJsonFile", () => {
	test("merges top-level keys and writes valid JSON", () => {
		const dir = mkdtempSync(join(tmpdir(), "nr-test-"));
		const path = join(dir, "9router.json");
		writeFileSync(path, JSON.stringify({ endpoint: "http://a", keep: 1 }));

		const out = saveJsonMerge({ endpoint: "http://b" }, path);
		expect(out.endpoint).toBe("http://b");
		expect(out.keep).toBe(1);
		expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual(out);
	});
	test("merges capabilities one level deep", () => {
		const dir = mkdtempSync(join(tmpdir(), "nr-test-"));
		const path = join(dir, "9router.json");
		writeFileSync(path, JSON.stringify({ capabilities: { image: { enabled: true }, tts: { enabled: false } } }));

		const out = saveJsonMerge({ capabilities: { image: { enabled: false, model: "m" } } }, path);
		const caps = out.capabilities as Record<string, unknown>;
		expect((caps.image as Record<string, unknown>).enabled).toBe(false);
		expect((caps.image as Record<string, unknown>).model).toBe("m");
		expect((caps.tts as Record<string, unknown>).enabled).toBe(false);
	});
	test("union-merges infoMissing key-wise (negative cache survives concurrent writes)", () => {
		const dir = mkdtempSync(join(tmpdir(), "nr-test-"));
		const path = join(dir, "9router.json");
		const now = Date.now();
		writeFileSync(path, JSON.stringify({ infoMissing: { "a/kept": now, "a/old": now - 1000 } }));

		const out = saveJsonMerge({ infoMissing: { "a/old": now, "b/fresh": now } }, path);
		const missing = out.infoMissing as Record<string, number>;
		expect(missing["a/kept"]).toBe(now); // other extension's key preserved
		expect(missing["a/old"]).toBe(now); // patch wins per key
		expect(missing["b/fresh"]).toBe(now);
	});
	test("prunes expired infoMissing entries (24 h TTL) on write, keeps fresh", () => {
		const dir = mkdtempSync(join(tmpdir(), "nr-test-"));
		const path = join(dir, "9router.json");
		const now = Date.now();
		writeFileSync(
			path,
			JSON.stringify({
				infoMissing: { "a/fresh": now, "a/expired": now - INFO_MISSING_TTL - 1 },
			}),
		);

		const out = saveJsonMerge({}, path);
		const missing = out.infoMissing as Record<string, number>;
		expect(missing["a/fresh"]).toBe(now);
		expect("a/expired" in missing).toBe(false);
	});
	test("prunes expired infoCache entries (7 d TTL) on write, keeps fresh", () => {
		const dir = mkdtempSync(join(tmpdir(), "nr-test-"));
		const path = join(dir, "9router.json");
		const now = Date.now();
		const info: RemoteModel = { id: "a/m" };
		writeFileSync(
			path,
			JSON.stringify({
				infoCache: {
					"a/fresh": { fetchedAt: now, info },
					"a/expired": { fetchedAt: now - INFO_CACHE_TTL - 1, info },
				},
			}),
		);

		const out = saveJsonMerge({}, path);
		const cache = out.infoCache as Record<string, { fetchedAt: number }>;
		expect(cache["a/fresh"].fetchedAt).toBe(now);
		expect("a/expired" in cache).toBe(false);
	});
	test("strips voice/ffmpegPath but preserves stt capability state", () => {
		const dir = mkdtempSync(join(tmpdir(), "nr-test-"));
		const path = join(dir, "9router.json");
		writeFileSync(
			path,
			JSON.stringify({ voice: "x", ffmpegPath: "y", capabilities: { stt: { enabled: true }, image: { enabled: true } } }),
		);
		expect(hasLegacyKeys(loadJsonFile(path))).toBe(true);

		const out = saveJsonMerge({}, path);
		expect("voice" in out).toBe(false);
		expect("ffmpegPath" in out).toBe(false);
		const caps = out.capabilities as Record<string, unknown>;
		expect(caps.stt).toEqual({ enabled: true }); // stt is a real capability again
		expect(caps.image).toBeDefined();
		expect(hasLegacyKeys(out)).toBe(false);
	});
	test("clean files report no legacy keys so callers can skip rewriting", () => {
		const dir = mkdtempSync(join(tmpdir(), "nr-test-"));
		const path = join(dir, "9router.json");
		writeFileSync(path, JSON.stringify({ endpoint: "http://a" }));
		expect(hasLegacyKeys(loadJsonFile(path))).toBe(false);
	});
	test("returns {} for missing or corrupt files", () => {
		const dir = mkdtempSync(join(tmpdir(), "nr-test-"));
		expect(loadJsonFile(join(dir, "missing.json"))).toEqual({});
		const corrupt = join(dir, "corrupt.json");
		writeFileSync(corrupt, "{ not json");
		expect(loadJsonFile(corrupt)).toEqual({});
	});
});

// ── Caps / list rows ─────────────────────────────────────────────

describe("asCaps", () => {
	test("maps string-array capability tags", () => {
		const caps = asCaps(["vision", "textToImage"]);
		expect(caps?.vision).toBe(true);
		expect(caps?.imageOutput).toBe(true);
	});
	test("normalizes thinking → reasoning", () => {
		expect(asCaps({ thinking: true })?.reasoning).toBe(true);
		expect(asCaps({ thinking: "false" })?.reasoning).toBe(false);
	});
	test("undefined for missing", () => {
		expect(asCaps(undefined)).toBeUndefined();
	});
});

describe("listRowIsRich", () => {
	test("numeric context window marks rich", () => {
		expect(listRowIsRich({ id: "m", capabilities: { contextWindow: 200000 } } as RemoteModel)).toBe(true);
	});
	test("thin rows are not rich", () => {
		expect(listRowIsRich({ id: "m", owned_by: "x" } as RemoteModel)).toBe(false);
	});
	test("non-empty string array is rich", () => {
		expect(listRowIsRich({ id: "m", capabilities: ["vision"] } as RemoteModel)).toBe(true);
	});
	test("capability flags need a name or kind (ticket 6 doc rule)", () => {
		const vision: RemoteModel = { id: "m", capabilities: { vision: true } };
		expect(listRowIsRich(vision)).toBe(false);
		expect(listRowIsRich({ ...vision, name: "N" })).toBe(true);
		expect(listRowIsRich({ ...vision, kind: "chat" })).toBe(true);
		expect(listRowIsRich({ id: "m", capabilities: { maxOutput: 4096 } } as RemoteModel)).toBe(true);
	});
});

describe("inferNameFromId", () => {
	test("derives human names from ids", () => {
		expect(inferNameFromId("openai/gpt-5-mini")).toBe("Gpt 5 Mini");
		expect(inferNameFromId("plain-model")).toBe("Plain Model");
	});
});

describe("safeFilename", () => {
	test("strips separators and traversal", () => {
		expect(safeFilename("../../etc/passwd")).toBe(".._.._etc_passwd");
		expect(safeFilename("my image:v2.png")).toBe("my_image_v2.png");
	});
});

// ── Footer / caps tables ─────────────────────────────────────────

describe("TOOL_CAP_DEFAULTS derived from CAPS", () => {
	test("covers all seven caps with independent default literals", () => {
		// Independent source: the CAPS table in extensions/lib/shared.ts —
		// seven entries, five on by default (image/tts/web_search/web_fetch/video).
		expect(Object.keys(TOOL_CAP_DEFAULTS).sort()).toEqual([
			"embed",
			"image",
			"stt",
			"tts",
			"video",
			"web_fetch",
			"web_search",
		]);
		expect(TOOL_CAP_DEFAULTS.image).toBe(true);
		expect(TOOL_CAP_DEFAULTS.tts).toBe(true);
		expect(TOOL_CAP_DEFAULTS.web_search).toBe(true);
		expect(TOOL_CAP_DEFAULTS.web_fetch).toBe(true);
		expect(TOOL_CAP_DEFAULTS.video).toBe(true);
		expect(TOOL_CAP_DEFAULTS.embed).toBe(false);
		expect(TOOL_CAP_DEFAULTS.stt).toBe(false);
	});
	test("video/stt tool wiring", () => {
		expect(CAPS.find((c) => c.id === "video")?.tool).toBe("nr_video_generate");
		expect(CAPS.find((c) => c.id === "stt")?.tool).toBe("nr_stt");
	});
});

describe("countEnabledTools", () => {
	test("defaults when capabilities absent", () => {
		// Independent literals: 7 caps total, 5 on by default.
		const { on, total } = countEnabledTools(undefined);
		expect(total).toBe(7);
		expect(on).toBe(5);
	});
	test("saved states override defaults", () => {
		const { on } = countEnabledTools({ image: { enabled: false } });
		expect(on).toBe(4);
	});
});

describe("formatFooterText", () => {
	test("sync prompt when nothing synced", () => {
		const snap: FooterSnapshot = { enabled: true, chatCount: 0, toolsOn: 0, toolsTotal: 5 };
		const { text, tone } = formatFooterText(snap);
		expect(text).toBe("9router(sync)");
		expect(tone).toBe("dim");
	});
	test("counts and staleness", () => {
		const fresh = formatFooterText({
			enabled: true,
			chatCount: 95,
			toolsOn: 3,
			toolsTotal: 5,
			lastSync: new Date().toISOString(),
		});
		expect(fresh.text).toBe("9router(95 Models · 3/5 Tools)");
		expect(fresh.tone).toBe("dim");

		const stale = formatFooterText({
			enabled: true,
			chatCount: 95,
			toolsOn: 3,
			toolsTotal: 5,
			lastSync: new Date(Date.now() - 48 * 3600_000).toISOString(),
		});
		expect(stale.text).toContain("stale");
		expect(stale.tone).toBe("warning");
	});
});

// ── Concurrency ──────────────────────────────────────────────────

describe("mapConcurrent", () => {
	test("preserves order with limited concurrency", async () => {
		let running = 0;
		let peak = 0;
		const items = Array.from({ length: 20 }, (_, i) => i);
		const out = await mapConcurrent(items, 3, async (i) => {
			running++;
			peak = Math.max(peak, running);
			await new Promise((r) => setTimeout(r, 5));
			running--;
			return i * 2;
		});
		// Independent literal — hand-doubled, not recomputed from the worker fn.
		expect(out).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32, 34, 36, 38]);
		expect(peak).toBeLessThanOrEqual(3);
		expect(peak).toBeGreaterThan(1);
	});
	test("empty input", async () => {
		expect(await mapConcurrent([], 4, async (x) => x)).toEqual([]);
	});
});

// sanity: the temp dirs above land in the OS tmpdir, not the repo
test("no config file was created in repo", () => {
	expect(existsSync(join(import.meta.dir, "..", "9router.json"))).toBe(false);
});

// ── downloadUrl keeps the HTTP status (video MP4 failure) ──

describe("downloadUrl status", () => {
	const realFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = realFetch;
	});

	test("non-OK keeps the HTTP status instead of bare null", async () => {
		globalThis.fetch = (async () => ({
			ok: false,
			status: 500,
			statusText: "Internal Server Error",
		})) as unknown as typeof fetch;
		const r = await downloadUrl("http://x/v.mp4");
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.status).toBe(500);
			expect(r.error).toContain("Internal Server Error");
		}
	});

	test("network failure reports status 0 with the cause", async () => {
		globalThis.fetch = (async () => {
			throw new Error("socket hang up");
		}) as unknown as typeof fetch;
		const r = await downloadUrl("http://x/v.mp4");
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.status).toBe(0);
			expect(r.error).toContain("socket hang up");
		}
	});

	test("success still returns bytes + content type", async () => {
		globalThis.fetch = (async () => ({
			ok: true,
			status: 200,
			arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
			headers: { get: () => "video/mp4" },
		})) as unknown as typeof fetch;
		const r = await downloadUrl("http://x/v.mp4");
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.bytes.length).toBe(3);
			expect(r.contentType).toBe("video/mp4");
		}
	});
});

// ── fullError transport (ticket 6: video 403 untruncated end-to-end) ──

describe("fullError transport", () => {
	const realFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = realFetch;
	});

	function failStub(body: string): void {
		globalThis.fetch = (async () => ({
			ok: false,
			status: 403,
			statusText: "Forbidden",
			text: async () => body,
			json: async () => JSON.parse(body),
			headers: { forEach: () => {} },
		})) as unknown as typeof fetch;
	}

	test("postJson caps long plain-text errors by default", async () => {
		failStub("denied:" + "x".repeat(2000));
		const r = await postJson("http://x/v1/videos/generations", "k", {});
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error.length).toBe(400);
	});

	test("postJson keeps the full body with fullError (video 403)", async () => {
		const body = "denied:" + "x".repeat(2000);
		failStub(body);
		const r = await postJson("http://x/v1/videos/generations", "k", {}, { fullError: true });
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toBe(body);
	});

	test("httpGetJson caps long errors by default", async () => {
		failStub("denied:" + "x".repeat(2000));
		const r = await httpGetJson("http://x/v1/videos/abc", "k");
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error.length).toBe(240);
	});

	test("httpGetJson keeps the full body with fullError (video poll)", async () => {
		const body = "denied:" + "x".repeat(2000);
		failStub(body);
		const r = await httpGetJson("http://x/v1/videos/abc", "k", { fullError: true });
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toBe(body);
	});

	test("fullError is bounded at 2KB, not unbounded (postJson)", async () => {
		const body = "denied:" + "x".repeat(5000);
		failStub(body);
		const r = await postJson("http://x/v1/videos/generations", "k", {}, { fullError: true });
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.error.length).toBe(2048);
			expect(body.startsWith(r.error)).toBe(true);
		}
	});

	test("fullError is bounded at 2KB, not unbounded (httpGetJson)", async () => {
		const body = "denied:" + "x".repeat(5000);
		failStub(body);
		const r = await httpGetJson("http://x/v1/videos/abc", "k", { fullError: true });
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.error.length).toBe(2048);
			expect(body.startsWith(r.error)).toBe(true);
		}
	});
});

// ── Ticket 7: auto default, caps classes, usage log ───────────────

describe("pickAutoDefaultModel", () => {
	test("empty list → undefined", () => {
		expect(pickAutoDefaultModel([])).toBeUndefined();
	});
	test("first rich row wins over a thin first entry", () => {
		const out = pickAutoDefaultModel([
			{ id: "thin/m", name: "thin/m", kind: "image" },
			{ id: "rich/m", name: "Rich", kind: "image", contextWindow: 32000 },
		]);
		expect(out?.id).toBe("rich/m");
	});
	test("falls back to first entry when nothing is rich", () => {
		const out = pickAutoDefaultModel([
			{ id: "a/m", name: "a/m", kind: "image" },
			{ id: "b/m", name: "b/m", kind: "image" },
		]);
		expect(out?.id).toBe("a/m");
	});
});

describe("capsClassOf / capsBadgeOf", () => {
	test("live caps → rich", () => {
		expect(capsClassOf({ id: "m", name: "m", kind: "chat", contextWindow: 1000 })).toBe("rich");
		expect(capsBadgeOf({ id: "m", name: "m", kind: "chat", contextWindow: 1000 })).toContain("live server info");
	});
	test("pattern fill → thin", () => {
		const e = { id: "m", name: "m", kind: "chat", contextWindow: 1000, capsFromPattern: true } as const;
		expect(capsClassOf(e)).toBe("thin");
		expect(capsBadgeOf(e)).toContain("pattern fallback");
	});
	test("no caps → missing", () => {
		expect(capsClassOf({ id: "m", name: "m", kind: "image" })).toBe("missing");
		expect(capsBadgeOf({ id: "m", name: "m", kind: "image" })).toContain("missing");
	});
});

describe("isInfoCacheFresh", () => {
	test("fresh within 7 d, expired after", () => {
		const now = Date.now();
		expect(isInfoCacheFresh({ fetchedAt: now, info: { id: "a/m" } }, now)).toBe(true);
		expect(isInfoCacheFresh({ fetchedAt: now - INFO_CACHE_TTL - 1, info: { id: "a/m" } }, now)).toBe(false);
		expect(isInfoCacheFresh(undefined, now)).toBe(false);
	});
});

describe("usage log (append-only jsonl)", () => {
	test("round-trips records, skips corrupt lines, summarizes", () => {
		const dir = mkdtempSync(join(tmpdir(), "nr-test-"));
		const path = join(dir, "9router-usage.jsonl");
		expect(formatUsageSummary(path)).toBeUndefined();
		logUsage({ tool: "nr_image_generate", model: "m/a", ms: 1000, ok: true, count: 2 }, path);
		logUsage({ tool: "nr_tts", model: "m/b", ms: 3000, ok: false }, path);
		writeFileSync(path, readFileSync(path, "utf-8") + "not json\n");
		const recs = readUsageRecords(path);
		expect(recs.length).toBe(2);
		expect(recs[0].tool).toBe("nr_image_generate");
		expect(typeof recs[0].ts).toBe("string");
		const summary = formatUsageSummary(path)!;
		expect(summary).toContain("2 calls");
		expect(summary).toContain("50% ok");
		expect(summary).toContain("avg 2.0s");
		expect(summary).toContain("last nr_tts m/b");
	});
	test("never throws on bad paths", () => {
		expect(() => logUsage({ tool: "t", ok: true }, join(tmpdir(), "nr-test-\0bad", "u.jsonl"))).not.toThrow();
		expect(readUsageRecords(join(tmpdir(), "nr-test-missing.jsonl"))).toEqual([]);
	});
	test("usage file stays bounded: an append past the size cap prunes to the tail", () => {
		const dir = mkdtempSync(join(tmpdir(), "nr-test-"));
		const path = join(dir, "9router-usage.jsonl");
		// Bulk pre-fill (>256KB) with distinct sequence ids, then one live append.
		// Independent literals: 256KB cap, 1000-line tail (shared.ts MAX_USAGE_*).
		const lines5000 = Array.from(
			{ length: 5000 },
			(_, i) => JSON.stringify({ ts: "2020-01-01T00:00:00.000Z", tool: "nr_old", ok: true, seq: i }) + "\n",
		).join("");
		writeFileSync(path, lines5000);
		expect(readFileSync(path, "utf-8").length).toBeGreaterThan(256_000);
		logUsage({ tool: "nr_image_generate", model: "m/new", ms: 5, ok: true }, path);
		const raw = readFileSync(path, "utf-8");
		expect(raw.length).toBeLessThanOrEqual(256_000);
		const lines = raw.split("\n").filter(Boolean);
		expect(lines.length).toBeLessThanOrEqual(1000);
		// Rotation keeps the TAIL: oldest bulk seqs are gone, the newest bulk
		// seqs and the live append survive.
		const seqs = lines.slice(0, -1).map((l) => (JSON.parse(l) as { seq: number }).seq);
		expect(Math.min(...seqs)).toBeGreaterThan(4000);
		expect(Math.max(...seqs)).toBe(4999);
		expect(JSON.parse(lines[lines.length - 1]).model).toBe("m/new");
		const recs = readUsageRecords(path);
		expect(recs[recs.length - 1].model).toBe("m/new");
	});
	test("appends under the size cap rewrite nothing (all lines kept)", () => {
		const dir = mkdtempSync(join(tmpdir(), "nr-test-"));
		const path = join(dir, "9router-usage.jsonl");
		logUsage({ tool: "nr_tts", model: "m/a", ms: 10, ok: true }, path);
		logUsage({ tool: "nr_tts", model: "m/b", ms: 20, ok: true }, path);
		const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
		expect(lines.length).toBe(2);
		expect((JSON.parse(lines[0]) as { model: string }).model).toBe("m/a");
		expect((JSON.parse(lines[1]) as { model: string }).model).toBe("m/b");
	});
});

// ── CORE BATCH (a): modelNames union-merge ───────────────────────────

describe("saveJsonMerge modelNames union-merge", () => {
	test("preserves on-disk names when a stale in-memory refresh writes", () => {
		const dir = mkdtempSync(join(tmpdir(), "nr-test-"));
		const path = join(dir, "9router.json");
		// Fresh names already on disk (e.g. written by a concurrent full sync).
		writeFileSync(
			path,
			JSON.stringify({ modelNames: { "a/keep": "Kept Fresh", "a/old": "Old Name" } }),
		);
		// Stale in-memory refresh state only knows one id (patch wins per key,
		// but must not wipe the fresh on-disk key it never saw).
		const out = saveJsonMerge({ modelNames: { "a/fresh": "Fresh Name" } }, path);
		const names = out.modelNames as Record<string, string>;
		expect(names["a/keep"]).toBe("Kept Fresh");
		expect(names["a/fresh"]).toBe("Fresh Name");
		expect(names["a/old"]).toBe("Old Name");
		expect(JSON.parse(readFileSync(path, "utf-8")).modelNames).toEqual(names);
	});
	test("patch wins per key for modelNames", () => {
		const dir = mkdtempSync(join(tmpdir(), "nr-test-"));
		const path = join(dir, "9router.json");
		writeFileSync(path, JSON.stringify({ modelNames: { "a/m": "Old" } }));
		const out = saveJsonMerge({ modelNames: { "a/m": "New" } }, path);
		expect((out.modelNames as Record<string, string>)["a/m"]).toBe("New");
	});
	test("union-merges infoCache key-wise (merge — fresh on-disk records survive)", () => {
		const dir = mkdtempSync(join(tmpdir(), "nr-test-"));
		const path = join(dir, "9router.json");
		const now = Date.now();
		const mkRec = (name: string) => ({ fetchedAt: now, info: { id: "a/m", name } });
		writeFileSync(
			path,
			JSON.stringify({ infoCache: { "chat\0a/kept": mkRec("Kept Fresh") } }),
		);
		// A concurrent write from the other extension only knows its own key —
		// patch wins per key but must not wipe the fresh on-disk key it never saw.
		const out = saveJsonMerge({ infoCache: { "chat\0a/new": mkRec("New") } }, path);
		const cache = out.infoCache as Record<string, { info: { name: string } }>;
		expect(cache["chat\0a/kept"].info.name).toBe("Kept Fresh");
		expect(cache["chat\0a/new"].info.name).toBe("New");
		expect(JSON.parse(readFileSync(path, "utf-8")).infoCache).toEqual(cache);
	});
	test("patch wins per key for infoCache", () => {
		const dir = mkdtempSync(join(tmpdir(), "nr-test-"));
		const path = join(dir, "9router.json");
		const now = Date.now();
		writeFileSync(
			path,
			JSON.stringify({ infoCache: { "chat\0a/m": { fetchedAt: now, info: { id: "a/m", name: "Old" } } } }),
		);
		const out = saveJsonMerge(
			{ infoCache: { "chat\0a/m": { fetchedAt: now + 1, info: { id: "a/m", name: "New" } } } },
			path,
		);
		const cache = out.infoCache as Record<string, { fetchedAt: number; info: { name: string } }>;
		expect(cache["chat\0a/m"].info.name).toBe("New");
		expect(cache["chat\0a/m"].fetchedAt).toBe(now + 1);
	});
});

// ── CORE BATCH (c): cache validation ─────────────────────────────────────

describe("saveJsonMerge prunes non-numeric timestamps", () => {
	test("NaN/null/string infoMissing values are dropped at save, fresh kept", () => {
		const dir = mkdtempSync(join(tmpdir(), "nr-test-"));
		const path = join(dir, "9router.json");
		const now = Date.now();
		writeFileSync(path, JSON.stringify({}));
		const out = saveJsonMerge(
			{
				infoMissing: {
					"a/fresh": now,
					"a/nan": NaN,
					"a/null": null,
					"a/str": "yesterday",
				} as unknown as Record<string, unknown>,
			},
			path,
		);
		const missing = out.infoMissing as Record<string, number>;
		expect(missing["a/fresh"]).toBe(now);
		expect("a/nan" in missing).toBe(false);
		expect("a/null" in missing).toBe(false);
		expect("a/str" in missing).toBe(false);
	});

	test("{info:null} and NaN-fetchedAt infoCache records are dropped at save", () => {
		const dir = mkdtempSync(join(tmpdir(), "nr-test-"));
		const path = join(dir, "9router.json");
		const now = Date.now();
		writeFileSync(path, JSON.stringify({}));
		const out = saveJsonMerge(
			{
				infoCache: {
					"a/good": { fetchedAt: now, info: { id: "a/good" } },
					"a/nullinfo": { fetchedAt: now, info: null },
					"a/nan": { fetchedAt: NaN, info: { id: "a/nan" } },
				} as unknown as Record<string, unknown>,
			},
			path,
		);
		const cache = out.infoCache as Record<string, { fetchedAt: number }>;
		expect(cache["a/good"].fetchedAt).toBe(now);
		expect("a/nullinfo" in cache).toBe(false);
		expect("a/nan" in cache).toBe(false);
	});

	test("malformed blobs do not resurrect through merge -> reload", () => {
		const dir = mkdtempSync(join(tmpdir(), "nr-test-"));
		const path = join(dir, "9router.json");
		const now = Date.now();
		writeFileSync(
			path,
			JSON.stringify({
				infoMissing: { "a/fresh": now, "a/bad": "yesterday" },
				infoCache: { "b/nullinfo": { fetchedAt: now, info: null } },
			}),
		);
		const out = saveJsonMerge({}, path);
		expect("a/bad" in (out.infoMissing as Record<string, unknown>)).toBe(false);
		expect("b/nullinfo" in (out.infoCache as Record<string, unknown>)).toBe(false);
		// Reload from disk: still gone, no crash, fresh survives.
		const reloaded = loadJsonFile(path);
		const missing = sanitizeInfoMissing(reloaded.infoMissing) ?? {};
		const cache = sanitizeInfoCache(reloaded.infoCache) ?? {};
		expect(missing["a/fresh"]).toBe(now);
		expect("a/bad" in missing).toBe(false);
		expect("b/nullinfo" in cache).toBe(false);
	});
});

describe("sanitize cache shapes on load", () => {
	test("string/array top-level blobs become empty maps, not crashes", () => {
		expect(sanitizeInfoMissing("oops")).toEqual({});
		expect(sanitizeInfoMissing(["x"])).toEqual({});
		expect(sanitizeInfoCache("oops")).toEqual({});
		expect(sanitizeInfoCache(["x"])).toEqual({});
		expect(sanitizeModelNames("oops")).toEqual({});
		expect(sanitizeModelNames(["x"])).toEqual({});
	});

	test("modelNames keeps only non-empty strings", () => {
		const out = sanitizeModelNames({
			"a/good": "Friendly",
			"a/num": 123,
			"a/empty": "   ",
			"a/null": null,
		} as unknown as Record<string, unknown>) ?? {};
		expect(out).toEqual({ "a/good": "Friendly" });
	});
});

// ── CORE BATCH (c): sanitize seam drops expired/malformed records on load ──

describe("sanitize caches drop expired/malformed records on load", () => {
	test("sanitizeInfoMissing drops expired + non-numeric, keeps fresh", () => {
		const now = Date.now();
		const out =
			sanitizeInfoMissing(
				{
					"a/fresh": now,
					"a/old": now - INFO_MISSING_TTL - 1,
					"a/nan": NaN,
					"a/str": "yesterday",
					"a/null": null,
				} as unknown as Record<string, number>,
				now,
			) ?? {};
		expect(out).toEqual({ "a/fresh": now });
	});
	test("sanitizeInfoMissing keeps undefined undefined", () => {
		expect(sanitizeInfoMissing(undefined)).toBeUndefined();
	});
	test("sanitizeInfoCache drops expired + null-info + NaN-fetchedAt, keeps fresh", () => {
		const now = Date.now();
		const out =
			sanitizeInfoCache(
				{
					"chat\0a/good": { fetchedAt: now, info: { id: "a/good", name: "Good" } },
					"chat\0a/old": { fetchedAt: now - INFO_CACHE_TTL - 1, info: { id: "a/old" } },
					"chat\0a/null": { fetchedAt: now, info: null },
					"chat\0a/nan": { fetchedAt: NaN, info: { id: "a/nan" } },
				} as unknown as Record<string, { fetchedAt: number; info: RemoteModel }>,
				now,
			) ?? {};
		expect(Object.keys(out)).toEqual(["chat\0a/good"]);
		expect(out["chat\0a/good"].info).toEqual({ id: "a/good", name: "Good" });
	});
});

// ── Usage summary + record seams ─────────────────────────────────────

describe("formatUsageSummary edges", () => {
	test("single call uses the singular, sub-second stays in ms", () => {
		const dir = mkdtempSync(join(tmpdir(), "nr-test-"));
		const path = join(dir, "9router-usage.jsonl");
		logUsage({ tool: "nr_tts", model: "m/a", ms: 500, ok: true }, path);
		expect(formatUsageSummary(path)).toBe("Usage: 1 call · 100% ok · avg 500ms · last nr_tts m/a 500ms");
	});
	test("records without timing omit avg and latency", () => {
		const dir = mkdtempSync(join(tmpdir(), "nr-test-"));
		const path = join(dir, "9router-usage.jsonl");
		logUsage({ tool: "nr_web_search", ok: true }, path);
		expect(formatUsageSummary(path)).toBe("Usage: 1 call · 100% ok · last nr_web_search");
	});
});

describe("readUsageRecords tail + shape guard", () => {
	test("maxLines reads the tail only", () => {
		const dir = mkdtempSync(join(tmpdir(), "nr-test-"));
		const path = join(dir, "9router-usage.jsonl");
		const lines = Array.from(
			{ length: 5 },
			(_, i) => JSON.stringify({ ts: "2020-01-01T00:00:00.000Z", tool: "nr_old", ok: true, seq: i }),
		).join("\n") + "\n";
		writeFileSync(path, lines);
		const recs = readUsageRecords(path, 2);
		expect(recs.map((r) => (r as unknown as { seq: number }).seq)).toEqual([3, 4]);
	});
	test("valid JSON without a tool field is skipped", () => {
		const dir = mkdtempSync(join(tmpdir(), "nr-test-"));
		const path = join(dir, "9router-usage.jsonl");
		writeFileSync(
			path,
			'{"nope":1}\n42\n[]\n' +
				JSON.stringify({ ts: "2020-01-01T00:00:00.000Z", tool: "nr_tts", ok: true }) + "\n",
		);
		const recs = readUsageRecords(path);
		expect(recs.length).toBe(1);
		expect(recs[0].tool).toBe("nr_tts");
	});
});

describe("footerFromConfig builds the snapshot from raw config", () => {
	test("counts, tools, and sync fields with independent literals", () => {
		const snap = footerFromConfig({
			showFooter: true,
			chatModels: [{}, {}],
			lastSync: "2026-01-01T00:00:00.000Z",
			capabilities: { image: { enabled: false } },
		});
		expect(snap.enabled).toBe(true);
		expect(snap.chatCount).toBe(2);
		expect(snap.lastSync).toBe("2026-01-01T00:00:00.000Z");
		// 7 caps total, 5 on by default, image off → 4 on.
		expect(snap.toolsTotal).toBe(7);
		expect(snap.toolsOn).toBe(4);
	});
});
