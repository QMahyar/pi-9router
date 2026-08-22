import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CAPS,
	TOOL_CAP_DEFAULTS,
	asCaps,
	countEnabledTools,
	formatFooterText,
	hasLegacyKeys,
	inferNameFromId,
	isSyncStale,
	listRowIsRich,
	loadJsonFile,
	mapConcurrent,
	maskedKey,
	normalizeEndpoint,
	resolveApiKey,
	safeFilename,
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
	test("one entry per cap, values match", () => {
		expect(Object.keys(TOOL_CAP_DEFAULTS).length).toBe(CAPS.length);
		for (const cap of CAPS) {
			expect(TOOL_CAP_DEFAULTS[cap.id]).toBe(cap.defaultEnabled);
		}
	});
	test("video on by default, stt off by default", () => {
		expect(TOOL_CAP_DEFAULTS.video).toBe(true);
		expect(TOOL_CAP_DEFAULTS.stt).toBe(false);
		expect(CAPS.find((c) => c.id === "video")?.tool).toBe("nr_video_generate");
		expect(CAPS.find((c) => c.id === "stt")?.tool).toBe("nr_stt");
	});
});

describe("countEnabledTools", () => {
	test("defaults when capabilities absent", () => {
		const { on, total } = countEnabledTools(undefined);
		expect(total).toBe(CAPS.length);
		expect(on).toBe(CAPS.filter((c) => c.defaultEnabled).length);
	});
	test("saved states override defaults", () => {
		const { on } = countEnabledTools({ image: { enabled: false } });
		expect(on).toBe(CAPS.filter((c) => c.defaultEnabled).length - 1);
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
		expect(out).toEqual(items.map((i) => i * 2));
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
