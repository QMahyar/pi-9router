import { describe, expect, test } from "bun:test";
import { CAPS, describeModels, resolveModel } from "../extensions/9router-tools.ts";
import type { CatalogEntry } from "../extensions/lib/shared.ts";

const imageCap = CAPS.find((c) => c.id === "image")!;
const ttsCap = CAPS.find((c) => c.id === "tts")!;
const searchCap = CAPS.find((c) => c.id === "web_search")!;
const fetchCap = CAPS.find((c) => c.id === "web_fetch")!;

function entry(id: string, kind: string, extra: Partial<CatalogEntry> = {}): CatalogEntry {
	return { id, name: id, kind, ...extra };
}

const catalog: CatalogEntry[] = [
	entry("gemini/gemini-3-pro-image-preview", "image", { name: "Gemini 3 Pro Image" }),
	entry("nb/nanobanana-flash", "image", { name: "NanoBanana Flash" }),
	entry("openai/tts-1", "tts"),
	entry("edge-tts/en-US-AriaNeural", "tts", { synthetic: true, ownedBy: "edge-tts" }),
	entry("google-tts/en", "tts", { synthetic: true, ownedBy: "google-tts" }),
	entry("text-embedding-3-small", "embedding"),
	entry("exa/search", "web", { detailKind: "webSearch" }),
	entry("tavily/search", "web", { detailKind: "webSearch" }),
	entry("jina-reader/fetch", "web", { detailKind: "webFetch" }),
];

describe("CAPS catalogKind predicates", () => {
	test("web_search picks only search rows", () => {
		const ids = catalog.filter(searchCap.catalogKind as (e: CatalogEntry) => boolean).map((e) => e.id);
		expect(ids.sort()).toEqual(["exa/search", "tavily/search"]);
	});
	test("web_fetch picks only fetch rows", () => {
		const ids = catalog.filter(fetchCap.catalogKind as (e: CatalogEntry) => boolean).map((e) => e.id);
		expect(ids).toEqual(["jina-reader/fetch"]);
	});
});

describe("resolveModel", () => {
	test("no override, no default → first catalog id", () => {
		const r = resolveModel({ catalog }, imageCap);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.id).toBe("gemini/gemini-3-pro-image-preview");
	});
	test("saved default is used when present in catalog", () => {
		const r = resolveModel({ catalog, capabilities: { image: { enabled: true, model: "nb/nanobanana-flash" } } }, imageCap);
		expect(r.ok && r.id).toBe("nb/nanobanana-flash");
	});
	test("stale default falls back with a note", () => {
		const r = resolveModel({ catalog, capabilities: { image: { enabled: true, model: "gone/model" } } }, imageCap);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.id).toBe("gemini/gemini-3-pro-image-preview");
			expect(r.note).toContain("no longer in the catalog");
		}
	});
	test("saved voice-provider default is usable without catalog entry", () => {
		const r = resolveModel({ catalog, capabilities: { tts: { enabled: true, model: "edge-tts/fr-FR-HenriNeural" } } }, ttsCap);
		expect(r.ok && r.id).toBe("edge-tts/fr-FR-HenriNeural");
	});
	test("exact and case-insensitive matches", () => {
		expect(resolveModel({ catalog }, imageCap, "nb/nanobanana-flash").ok).toBe(true);
		const ci = resolveModel({ catalog }, imageCap, "NB/NanoBanana-Flash");
		expect(ci.ok).toBe(true);
		if (ci.ok) expect(ci.note).toContain("matched");
	});
	test("unique fuzzy match resolves with note", () => {
		const r = resolveModel({ catalog }, imageCap, "nanobanana");
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.id).toBe("nb/nanobanana-flash");
	});
	test("ambiguous fuzzy match is rejected with candidates", () => {
		const r = resolveModel({ catalog }, searchCap, "search");
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.message).toContain("exa/search");
			expect(r.message).toContain("tavily/search");
		}
	});
	test("unknown model lists available ids", () => {
		const r = resolveModel({ catalog }, imageCap, "nope");
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.message).toContain("gemini/gemini-3-pro-image-preview");
	});
	test("voice-provider override passes through", () => {
		expect(resolveModel({ catalog }, ttsCap, "google-tts/de").ok).toBe(true);
		expect(resolveModel({ catalog }, ttsCap, "el/eleven_multilingual_v2").ok).toBe(true);
	});
	test("empty catalog errors with sync hint", () => {
		const r = resolveModel({}, imageCap);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.message).toContain("/9router");
	});
});

describe("describeModels", () => {
	test("lists non-synthetic ids and groups voice providers", () => {
		const text = describeModels({ catalog }, ttsCap);
		expect(text).toContain("openai/tts-1");
		expect(text).toContain("edge-tts/<voice>");
		expect(text).toContain("google-tts/<voice>");
	});
	test("empty catalog hint", () => {
		expect(describeModels({}, imageCap)).toContain("No models synced yet");
	});
	test("caps +image+ list length marker when catalog exceeds the cap", () => {
		const big: CatalogEntry[] = Array.from({ length: 20 }, (_, i) => entry(`m/image-${i}`, "image"));
		expect(describeModels({ catalog: big }, imageCap)).toContain("+6 more");
	});
});
