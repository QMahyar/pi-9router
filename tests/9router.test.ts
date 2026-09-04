import { afterEach, describe, expect, test } from "bun:test";
import {
	ageAbsentEntries,
	buildModelNames,
	catalogKey,
	enrichCatalog,
	fetchAllAndBuild,
	fillModelCaps,
	formatInfoLine,
	globMatch,
	INFO_CACHE_TTL,
	INFO_MISSING_TTL,
	isInfoMissingCached,
	lookupInfo,
	mapThinkingCompat,
	pruneModelNamesToListed,
	QUICK_STALE_AFTER_ABSENT,
	statusLines,
	toPiModelWithCachedName,
} from "../extensions/9router.ts";
import type { CatalogEntry, ModelCapabilities } from "../extensions/lib/shared.ts";
import type { RemoteModel } from "../extensions/lib/shared.ts";

describe("globMatch", () => {
	test("* wildcard, case-insensitive", () => {
		expect(globMatch("*claude*opus*", "cc/claude-opus-4.7")).toBe(true);
		expect(globMatch("*CLAUDE*", "openai/claude-x")).toBe(true);
		expect(globMatch("*claude*", "openai/gpt-5")).toBe(false);
	});
	test("escapes regex metacharacters in pattern", () => {
		expect(globMatch("*gpt-4.1*", "openai/gpt-4.1")).toBe(true);
		expect(globMatch("*gpt-4.1*", "openai/gpt-4x11")).toBe(false);
		expect(globMatch("a+b", "a+b")).toBe(true);
		expect(globMatch("a+b", "aab")).toBe(false);
	});
});

describe("fillModelCaps", () => {
	test("fills only missing fields — explicit caps win", () => {
		const out = fillModelCaps("cc/claude-opus-4.7", { contextWindow: 64000 });
		expect(out.contextWindow).toBe(64000); // not overwritten
		expect(out.maxOutput).toBe(128000); // filled from pattern
		expect(out.vision).toBe(true);
		expect(out.reasoning).toBe(true);
		expect(out.thinkingFormat).toBe("claude-adaptive");
	});
	test("matches the leaf id first (provider prefix ignored)", () => {
		const out = fillModelCaps("somehost/gpt-4o", {});
		expect(out.contextWindow).toBe(128000);
		expect(out.maxOutput).toBe(16384);
	});
	test("unknown ids pass through untouched", () => {
		// Fresh literal on the expected side (not the input object): a
		// self-comparison would pass vacuously even if the fn mutated input.
		expect(fillModelCaps("mystery/model-x", { vision: false })).toEqual({ vision: false });
	});
	test("full id is used when leaf does not match", () => {
		// Leaf "qwen3-coder" misses *qwen*coder*? — it matches; use a leaf-only miss:
		const out = fillModelCaps("qwen/something-else", {});
		expect(out.thinkingFormat).toBe("qwen");
	});
});

describe("mapThinkingCompat", () => {
	test("non-reasoning models get plain compat", () => {
		const { compat } = mapThinkingCompat({ reasoning: false });
		expect(compat?.supportsReasoningEffort).toBe(false);
		expect(compat?.thinkingFormat).toBeUndefined();
	});
	test("openai format", () => {
		const { compat } = mapThinkingCompat({ reasoning: true, thinkingFormat: "openai" });
		expect(compat?.supportsReasoningEffort).toBe(true);
		expect(compat?.thinkingFormat).toBe("openai");
	});
	test("reasoning without format defaults to openai", () => {
		const { compat } = mapThinkingCompat({ reasoning: true });
		expect(compat?.thinkingFormat).toBe("openai");
	});
	test("claude-adaptive maps to openrouter passthrough", () => {
		const { compat } = mapThinkingCompat({ reasoning: true, thinkingFormat: "claude-adaptive" });
		expect(compat?.thinkingFormat).toBe("openrouter");
	});
	test("qwen and deepseek disable effort, set their format", () => {
		expect(mapThinkingCompat({ reasoning: true, thinkingFormat: "qwen" }).compat).toMatchObject({
			supportsReasoningEffort: false,
			thinkingFormat: "qwen",
		});
		expect(mapThinkingCompat({ reasoning: true, thinkingFormat: "deepseek" }).compat).toMatchObject({
			supportsReasoningEffort: false,
			thinkingFormat: "deepseek",
		});
	});
	test("zai/glm format", () => {
		expect(mapThinkingCompat({ reasoning: true, thinkingFormat: "zai" }).compat).toMatchObject({
			thinkingFormat: "zai",
			supportsReasoningEffort: false,
		});
	});
	test("every result sets maxTokensField", () => {
		for (const f of ["", "openai", "openrouter", "claude-budget", "gemini-level", "qwen", "deepseek", "zai", "kimi", "unknown"]) {
			const { compat } = mapThinkingCompat(f ? { reasoning: true, thinkingFormat: f } : undefined);
			expect(compat?.maxTokensField).toBe("max_tokens");
		}
	});
});

// ── Per-kind info keying (ticket 1 — fix a) ────────────────────

describe("catalogKey", () => {
	test("produces kind\0id key", () => {
		expect(catalogKey("chat", "openai/gpt-4o")).toBe("chat\0openai/gpt-4o");
		expect(catalogKey("image", "openai/gpt-4o")).toBe("image\0openai/gpt-4o");
	});
});

describe("lookupInfo — per-kind isolation (twin-risk)", () => {
	const chatInfo: RemoteModel = { id: "provider/dall-e-3", name: "Chat Name" };
	const imageInfo: RemoteModel = { id: "provider/dall-e-3", name: "Image Name" };

	function twinMap(): Map<string, RemoteModel> {
		const m = new Map<string, RemoteModel>();
		m.set(catalogKey("chat", "provider/dall-e-3"), chatInfo);
		m.set(catalogKey("image", "provider/dall-e-3"), imageInfo);
		return m;
	}

	test("same id in chat+image keeps per-kind names", () => {
		const infoById = twinMap();
		expect(lookupInfo(infoById, "chat", "provider/dall-e-3")).toBe(chatInfo);
		expect(lookupInfo(infoById, "image", "provider/dall-e-3")).toBe(imageInfo);
	});

	test("ambiguous bare id falls back to nothing", () => {
		const infoById = twinMap();
		// Lookup with a non-existent kind — bare id is ambiguous, so undefined
		expect(lookupInfo(infoById, "tts", "provider/dall-e-3")).toBeUndefined();
	});

	test("unambiguous bare id falls back to the single kind entry", () => {
		const m = new Map<string, RemoteModel>();
		m.set(catalogKey("image", "solo/model"), imageInfo);
		// Lookup with "chat" kind — not stored, but bare id is unambiguous
		expect(lookupInfo(m, "chat", "solo/model")).toBe(imageInfo);
	});

	test("missing id returns undefined", () => {
		const infoById = twinMap();
		expect(lookupInfo(infoById, "chat", "nonexistent")).toBeUndefined();
	});
});

// ── Negative info cache (ticket 1 — fix b) ─────────────────────

describe("INFO_MISSING_TTL", () => {
	test("is 24 h", () => {
		// Independent literal: 24 h in ms (not the source expression).
		expect(INFO_MISSING_TTL).toBe(86_400_000);
	});
});

describe("isInfoMissingCached — negative-cache predicate (real code)", () => {
	const now = Date.now();

	test("known-missing id within TTL is skipped", () => {
		expect(
			isInfoMissingCached({ "provider/unknown-model": now }, "provider/unknown-model", now),
		).toBe(true);
	});

	test("expired entry (>TTL) is re-probed", () => {
		expect(
			isInfoMissingCached(
				{ "provider/old-missing": now - INFO_MISSING_TTL - 1 },
				"provider/old-missing",
				now,
			),
		).toBe(false);
	});

	test("unknown id is re-probed", () => {
		expect(isInfoMissingCached({}, "provider/fresh-model", now)).toBe(false);
		expect(isInfoMissingCached(undefined, "provider/fresh-model", now)).toBe(false);
	});

});

describe("enrichCatalog negative cache end-to-end (real code, stubbed fetch)", () => {
	const realFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = realFetch;
	});

	function thinEntry(id: string, kind = "chat"): CatalogEntry {
		return { id, name: id, kind };
	}

	function stubFetch(handler: (url: string) => unknown): void {
		globalThis.fetch = (async (url: unknown) => handler(String(url))) as unknown as typeof fetch;
	}

	test("true-404 miss is recorded; quick-sync rebuild with the cache skips the fetch", async () => {
		let calls = 0;
		stubFetch(() => {
			calls++;
			return { ok: false, status: 404, statusText: "Not Found", text: async () => "no such model" };
		});

		const first = await enrichCatalog("http://localhost:20128", "key", [thinEntry("provider/ghost")], new Map());
		expect(first.missing).toBe(1);
		expect(first.infoMissing["provider/ghost"]).toBeGreaterThan(0);
		expect(calls).toBe(1);

		// Quick-sync rebuild with the persisted negative cache: zero HTTP.
		calls = 0;
		const second = await enrichCatalog("http://localhost:20128", "key", [thinEntry("provider/ghost")], new Map(), {
			infoMissing: first.infoMissing,
		});
		expect(calls).toBe(0);
		expect(second.skipped).toBe(1);
		expect(second.missing).toBe(0);
	});

	test("transient 500 is NOT negatively cached — next sync re-probes", async () => {
		let calls = 0;
		stubFetch(() => {
			calls++;
			return { ok: false, status: 500, statusText: "Internal Server Error", text: async () => "boom" };
		});

		const first = await enrichCatalog("http://localhost:20128", "key", [thinEntry("provider/flaky")], new Map());
		expect(first.missing).toBe(1);
		expect("provider/flaky" in first.infoMissing).toBe(false);
		expect(calls).toBe(1);

		// Next sync (quick or full) must re-probe the transient failure.
		calls = 0;
		const second = await enrichCatalog("http://localhost:20128", "key", [thinEntry("provider/flaky")], new Map(), {
			infoMissing: first.infoMissing,
		});
		expect(calls).toBe(1);
		expect(second.missing).toBe(1);
	});

	test("timeout/abort is NOT negatively cached — next sync re-probes", async () => {
		let calls = 0;
		stubFetch(() => {
			calls++;
			throw new Error("fetch timeout");
		});

		const first = await enrichCatalog("http://localhost:20128", "key", [thinEntry("provider/slow")], new Map());
		expect(first.missing).toBe(1);
		expect("provider/slow" in first.infoMissing).toBe(false);
		expect(calls).toBe(1);

		calls = 0;
		const second = await enrichCatalog("http://localhost:20128", "key", [thinEntry("provider/slow")], new Map(), {
			infoMissing: first.infoMissing,
		});
		expect(calls).toBe(1);
		expect(second.missing).toBe(1);
	});

	test("next sync (incl. full) retries transient 500 but still skips true-404", async () => {
		stubFetch((url: string) => {
			if (url.includes(encodeURIComponent("provider/ghost")) || url.includes("provider/ghost")) {
				return { ok: false, status: 404, statusText: "Not Found", text: async () => "no such model" };
			}
			return { ok: false, status: 500, statusText: "Internal Server Error", text: async () => "boom" };
		});

		const first = await enrichCatalog(
			"http://localhost:20128",
			"key",
			[thinEntry("provider/ghost"), thinEntry("provider/flaky")],
			new Map(),
		);
		expect(first.missing).toBe(2);
		expect("provider/ghost" in first.infoMissing).toBe(true);
		expect("provider/flaky" in first.infoMissing).toBe(false);

		// Full-sync rebuild with the persisted cache: ghost skipped, flaky re-probed and recovered.
		let ghostCalls = 0;
		let flakyCalls = 0;
		stubFetch((url: string) => {
			if (url.includes("provider/ghost")) {
				ghostCalls++;
				return { ok: false, status: 404, statusText: "Not Found", text: async () => "gone" };
			}
			flakyCalls++;
			return {
				ok: true,
				status: 200,
				statusText: "OK",
				text: async () => "",
				json: async () => ({ id: "provider/flaky", name: "Flaky Model" }),
			};
		});

		const entries = [thinEntry("provider/ghost"), thinEntry("provider/flaky")];
		const second = await enrichCatalog("http://localhost:20128", "key", entries, new Map(), {
			infoMissing: first.infoMissing,
		});
		expect(ghostCalls).toBe(0);
		expect(flakyCalls).toBe(1);
		expect(second.skippedNegative).toBe(1);
		expect(entries[1].name).toBe("Flaky Model");
	});

	test("expired negative-cache entry is re-probed", async () => {
		let calls = 0;
		stubFetch(() => {
			calls++;
			return { ok: false, status: 404, statusText: "Not Found", text: async () => "gone" };
		});

		const out = await enrichCatalog("http://localhost:20128", "key", [thinEntry("provider/ghost")], new Map(), {
			infoMissing: { "provider/ghost": Date.now() - INFO_MISSING_TTL - 1 },
		});
		expect(calls).toBe(1);
		expect(out.missing).toBe(1);
	});

	test("info hit is stored under the kind-qualified key", async () => {
		stubFetch(() => ({
			ok: true,
			status: 200,
			statusText: "OK",
			text: async () => "",
			json: async () => ({ id: "provider/pic", name: "Pic Model" }),
		}));

		const entries = [thinEntry("provider/pic", "image")];
		const out = await enrichCatalog("http://localhost:20128", "key", entries, new Map());
		expect(out.infoById.get("image\0provider/pic")?.name).toBe("Pic Model");
		expect(out.infoById.has("chat\0provider/pic")).toBe(false);
		expect(entries[0].name).toBe("Pic Model");
	});

	test("counters split honestly: probed vs positive-hits vs negative-hits vs rich-skips", async () => {
		let calls = 0;
		stubFetch((url: string) => {
			calls++;
			// Note: the info URL encodes the slash (live%2Fd), so match the leaf.
			if (url.includes("live")) {
				return {
					ok: true,
					status: 200,
					statusText: "OK",
					text: async () => "",
					json: async () => ({ id: "live/d", name: "Live D" }),
				};
			}
			return { ok: false, status: 404, statusText: "Not Found", text: async () => "no such model" };
		});

		const now = Date.now();
		const entries = [
			thinEntry("rich/a"), // rich list row → skipped, no HTTP
			thinEntry("pos/b"), // 7 d positive cache → cached hit, no HTTP
			thinEntry("neg/c"), // 24 h negative cache → skip, no HTTP
			thinEntry("live/d"), // probe → 200 hit
			thinEntry("miss/e"), // probe → 404 miss
		];
		const remotesByKey = new Map<string, RemoteModel>([
			["chat\0rich/a", { id: "rich/a", name: "Rich A", capabilities: { contextWindow: 64000 } }],
		]);
		const out = await enrichCatalog("http://localhost:20128", "key", entries, remotesByKey, {
			infoCache: { "chat\0pos/b": { fetchedAt: now, info: { id: "pos/b", name: "Pos B" } } },
			infoMissing: { "neg/c": now },
		});
		expect(calls).toBe(2); // only live/d + miss/e hit HTTP
		expect(out.fetched).toBe(2); // probed
		expect(out.missing).toBe(1); // misses (live/d hit, miss/e missed)
		expect(out.cachedInfo).toBe(1); // positive-hits (pos/b)
		expect(out.skippedNegative).toBe(1); // negative-hits (neg/c)
		expect(out.skipped).toBe(3); // rich/a + pos/b + neg/c
	});
});

describe("formatInfoLine — honest counter labels", () => {
	test("each label shows its own counter (hand-computed: hits 5-2=3, rich 10-1-1=8)", () => {
		const line = formatInfoLine({
			infoFetched: 5,
			infoMissed: 2,
			infoCached: 1,
			infoSkippedNegative: 1,
			infoSkipped: 10,
		});
		expect(line).toContain("probed: 5");
		expect(line).toContain("hits 3");
		expect(line).toContain("misses 2");
		expect(line).toContain("cache hits (7d): 1");
		expect(line).toContain("negative-skips: 1");
		expect(line).toContain("rich-skips: 8");
	});
	test("all-zero sync reports zeros", () => {
		const line = formatInfoLine({});
		expect(line).toContain("probed: 0");
		expect(line).toContain("hits 0");
		expect(line).toContain("misses 0");
		expect(line).toContain("rich-skips: 0");
	});
});

// ── Refresh keeps friendly names (ticket 2) ───────────────────────

describe("toPiModelWithCachedName — thin refresh row reuses cached name", () => {
	test("cached name wins over bare inferName fallback", () => {
		const thin: RemoteModel = { id: "openai/gpt-4o" };
		const def = toPiModelWithCachedName(thin, "GPT-4o (Friendly)");
		expect(def.id).toBe("openai/gpt-4o");
		expect(def.name).toBe("GPT-4o (Friendly)");
	});

	test("no cached name falls back to derived name", () => {
		const thin: RemoteModel = { id: "openai/gpt-4o" };
		const def = toPiModelWithCachedName(thin, undefined);
		// inferNameFromId("openai/gpt-4o") → "Gpt 4o"
		expect(def.name).toBe("Gpt 4o");
	});

	test("live list-row name wins over stale cached name", () => {
		const live: RemoteModel = { id: "openai/gpt-4o", name: "GPT-4o Live" };
		const def = toPiModelWithCachedName(live, "GPT-4o Stale");
		expect(def.name).toBe("GPT-4o Live");
	});

	test("live info name wins over cached name", () => {
		const thin: RemoteModel = { id: "openai/gpt-4o" };
		const info: RemoteModel = { id: "openai/gpt-4o", name: "GPT-4o Info" };
		const def = toPiModelWithCachedName(thin, "GPT-4o Cached", info);
		expect(def.name).toBe("GPT-4o Info");
	});

	test("cached name still merges live caps from info", () => {
		const thin: RemoteModel = { id: "openai/gpt-4o" };
		const info: RemoteModel = {
			id: "openai/gpt-4o",
			capabilities: { vision: true, contextWindow: 128000, maxOutput: 16384 },
		};
		const def = toPiModelWithCachedName(thin, "GPT-4o (Friendly)", info);
		expect(def.name).toBe("GPT-4o (Friendly)");
		expect(def.input).toEqual(["text", "image"]);
		expect(def.contextWindow).toBe(128000);
	});

	test("previous-def caps hint preserves info-derived numbers for a thin row", () => {
		// refreshModels path: thin list row + cached friendly name + last-known
		// chat caps (caps only — no name on the hint).
		const thin: RemoteModel = { id: "openai/gpt-4o" };
		const hint: RemoteModel = {
			id: "openai/gpt-4o",
			capabilities: { contextWindow: 1000000, maxOutput: 128000 },
		};
		const def = toPiModelWithCachedName(thin, "GPT-4o (Friendly)", hint);
		expect(def.name).toBe("GPT-4o (Friendly)");
		expect(def.contextWindow).toBe(1000000);
		expect(def.maxTokens).toBe(128000);
	});

	test("live list-row caps win over the previous-def hint", () => {
		const live: RemoteModel = {
			id: "openai/gpt-4o",
			capabilities: { contextWindow: 64000, maxOutput: 16000 },
		};
		const hint: RemoteModel = {
			id: "openai/gpt-4o",
			capabilities: { contextWindow: 1000000, maxOutput: 128000 },
		};
		const def = toPiModelWithCachedName(live, "GPT-4o (Friendly)", hint);
		expect(def.name).toBe("GPT-4o (Friendly)");
		expect(def.contextWindow).toBe(64000);
		expect(def.maxTokens).toBe(16000);
	});
});

describe("buildModelNames — last-known chat names", () => {
	function chatEntry(id: string, name: string, namedByServer = true): CatalogEntry {
		return { id, name, kind: "chat", namedByServer };
	}

	test("persists server-named chat entries only", () => {
		const catalog = [
			chatEntry("a/m1", "Friendly One"),
			chatEntry("a/m2", "Gpt 4o", false), // derived — not persisted
		];
		expect(buildModelNames(catalog)).toEqual({ "a/m1": "Friendly One" });
	});

	test("ignores non-chat twins (per-kind isolation)", () => {
		const catalog: CatalogEntry[] = [
			{ id: "provider/x", name: "Image Name", kind: "image", namedByServer: true },
		];
		expect(buildModelNames(catalog)).toEqual({});
	});

	test("carries prev forward for still-present thin ids; prunes removed ids", () => {
		const prev = { "a/keep": "Kept Name", "a/gone": "Gone Name" };
		const catalog = [chatEntry("a/keep", "A Keep", false)]; // thin now, no server name
		const out = buildModelNames(catalog, prev, ["a/keep"]);
		expect(out).toEqual({ "a/keep": "Kept Name" });
	});

	test("server rename overwrites stale cached name", () => {
		const prev = { "a/m1": "Old Name" };
		const catalog = [chatEntry("a/m1", "New Name")];
		expect(buildModelNames(catalog, prev, ["a/m1"])).toEqual({ "a/m1": "New Name" });
	});
});

// ── HYGIENE BATCH-A (d): refreshModels prunes removed ids ─────────────

describe("pruneModelNamesToListed — refresh drops removed ids", () => {
	test("removes ids the refresh no longer lists, keeps listed ones", () => {
		const cached = new Map([
			["a/keep", "Kept Name"],
			["a/gone", "Gone Name"],
		]);
		pruneModelNamesToListed(cached, ["a/keep", "a/new"]);
		expect(cached.get("a/keep")).toBe("Kept Name");
		expect(cached.has("a/gone")).toBe(false);
	});

	test("empty listing clears every cached name", () => {
		const cached = new Map([["a/keep", "Kept Name"]]);
		pruneModelNamesToListed(cached, []);
		expect(cached.size).toBe(0);
	});
});

// ── HYGIENE BATCH-A (d): full sync reuses cached friendly names ───────

describe("fetchAllAndBuild full sync reuses cached friendly names (real code, stubbed fetch)", () => {
	const realFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = realFetch;
	});

	test("thin chat row with no server name keeps the modelNames friendly name", async () => {
		globalThis.fetch = (async (url: unknown) => {
			const u = String(url);
			if (u.endsWith("/api/health")) {
				return {
					ok: true,
					status: 200,
					statusText: "OK",
					text: async () => "",
					json: async () => ({ ok: true }),
				};
			}
			if (u.includes("/models/info")) {
				return { ok: false, status: 404, statusText: "Not Found", text: async () => "gone" };
			}
			if (u.includes("/audio/speech")) {
				return { ok: false, status: 500, statusText: "TTS off", text: async () => "no" };
			}
			if (u.endsWith("/v1/models")) {
				return {
					ok: true,
					status: 200,
					statusText: "OK",
					text: async () => "",
					json: async () => ({ data: [{ id: "a/m1" }] }),
				};
			}
			return {
				ok: true,
				status: 200,
				statusText: "OK",
				text: async () => "",
				json: async () => ({ data: [] }),
			};
		}) as unknown as typeof fetch;

		const out = await fetchAllAndBuild(
			{ endpoint: "http://127.0.0.1:1", modelNames: { "a/m1": "Friendly Cached" } },
			{ mode: "full" },
		);
		expect(out.ok).toBe(true);
		expect(out.chatModels).toHaveLength(1);
		expect(out.chatModels[0].id).toBe("a/m1");
		// Server gave no name (thin list row, no info record) — the cached
		// friendly name wins over the bare "M1" id fallback.
		expect(out.chatModels[0].name).toBe("Friendly Cached");
	});
});

// ── Quick-sync stale marking (ticket 3) ────────────────────────────

describe("QUICK_STALE_AFTER_ABSENT", () => {
	test("is 2 — entry absent twice gets the stale flag", () => {
		expect(QUICK_STALE_AFTER_ABSENT).toBe(2);
	});
});

describe("ageAbsentEntries — quick-sync aging, no re-probe", () => {
	function nonChat(id: string, extra?: Partial<CatalogEntry>): CatalogEntry {
		return { id, name: id, kind: "image", ...extra };
	}

	test("entry absent twice gets the stale flag", () => {
		const prev = [nonChat("provider/pic")];
		const once = ageAbsentEntries(prev, new Set());
		expect(once[0].absentSyncs).toBe(1);
		expect(once[0].stale).toBeFalsy();
		const twice = ageAbsentEntries(once, new Set());
		expect(twice[0].absentSyncs).toBe(2);
		expect(twice[0].stale).toBe(true);
	});

	test("reappearing entry clears the counter and the flag", () => {
		const aged: CatalogEntry[] = [
			nonChat("provider/pic", { absentSyncs: 2, stale: true }),
		];
		const out = ageAbsentEntries(aged, new Set([catalogKey("image", "provider/pic")]));
		expect(out[0].absentSyncs).toBeUndefined();
		expect(out[0].stale).toBeUndefined();
	});

	test("confirmed entries stay clean; unconfirmed twins age per kind", () => {
		const prev = [nonChat("provider/x"), nonChat("provider/y")];
		const out = ageAbsentEntries(prev, [catalogKey("image", "provider/x")]);
		expect(out[0].absentSyncs).toBeUndefined();
		expect(out[1].absentSyncs).toBe(1);
	});

	test("synthetic voice entries are exempt (no server list to be absent from)", () => {
		const prev: CatalogEntry[] = [
			{ id: "edge-tts/en-US-AriaNeural", name: "Aria", kind: "tts", synthetic: true },
		];
		const out = ageAbsentEntries(ageAbsentEntries(prev, new Set()), new Set());
		expect(out[0].absentSyncs).toBeUndefined();
		expect(out[0].stale).toBeFalsy();
	});

	test("absent chat entries age too (quick sync confirms present chat by key)", () => {
		const prev: CatalogEntry[] = [
			{ id: "a/gone", name: "Gone", kind: "chat" },
			{ id: "a/here", name: "Here", kind: "chat" },
		];
		const here = [catalogKey("chat", "a/here")];
		const out = ageAbsentEntries(ageAbsentEntries(prev, here), here);
		expect(out[0].absentSyncs).toBe(2);
		expect(out[0].stale).toBe(true);
		expect(out[1].absentSyncs).toBeUndefined();
		expect(out[1].stale).toBeFalsy();
	});

});

describe("fillModelCaps onHit — fallback-hit telemetry", () => {
	test("fires with the matched pattern when a gap is filled", () => {
		const hits: string[] = [];
		const out = fillModelCaps("openai/gpt-4o", {}, (p) => hits.push(p));
		expect(hits).toEqual(["*gpt-4o*"]);
		expect(out.contextWindow).toBe(128000);
	});
	test("silent when server caps are already complete", () => {
		const hits: string[] = [];
		fillModelCaps(
			"openai/gpt-4o",
			{ vision: true, reasoning: false, contextWindow: 128000, maxOutput: 16384 },
			(p) => hits.push(p),
		);
		expect(hits).toEqual([]);
	});
	test("silent when no pattern matches (returns caps untouched)", () => {
		const hits: string[] = [];
		const out = fillModelCaps("unknown-provider/mystery-9z", {}, (p) => hits.push(p));
		expect(hits).toEqual([]);
		expect(out).toEqual({});
	});
	test("omitted callback keeps fillModelCaps pure", () => {
		expect(fillModelCaps("openai/gpt-4o", {}).contextWindow).toBe(128000);
	});
});

describe("enrichCatalog patternHits counter (real code, stubbed fetch)", () => {
	const realFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = realFetch;
	});

	function infoStub(info: unknown): void {
		globalThis.fetch = (async () => ({
			ok: true,
			status: 200,
			statusText: "OK",
			text: async () => "",
			json: async () => info,
		})) as unknown as typeof fetch;
	}

	test("caps-less info record counts a hit and flags the entry", async () => {
		infoStub({ id: "openai/gpt-4o", name: "GPT-4o" });
		const entries: CatalogEntry[] = [{ id: "openai/gpt-4o", name: "openai/gpt-4o", kind: "chat" }];
		const out = await enrichCatalog("http://localhost:20128", "key", entries, new Map());
		expect(out.patternHits).toBe(1);
		expect(entries[0].capsFromPattern).toBe(true);
		expect(entries[0].contextWindow).toBe(128000);
	});

	test("fully-capped info record counts no hit and leaves the flag unset", async () => {
		infoStub({
			id: "openai/gpt-4o",
			name: "GPT-4o",
			capabilities: { vision: true, reasoning: false, contextWindow: 128000, maxOutput: 16384 },
		});
		const entries: CatalogEntry[] = [{ id: "openai/gpt-4o", name: "openai/gpt-4o", kind: "chat" }];
		const out = await enrichCatalog("http://localhost:20128", "key", entries, new Map());
		expect(out.patternHits).toBe(0);
		expect(entries[0].capsFromPattern).toBeUndefined();
	});
});

describe("enrichCatalog positive info cache (7 d TTL)", () => {
	const realFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = realFetch;
	});

	test("fresh cached record is reused with zero HTTP", async () => {
		let calls = 0;
		globalThis.fetch = (async () => {
			calls++;
			throw new Error("must not fetch");
		}) as unknown as typeof fetch;

		const now = Date.now();
		const entries: CatalogEntry[] = [{ id: "provider/cached", name: "provider/cached", kind: "chat" }];
		const out = await enrichCatalog("http://localhost:20128", "key", entries, new Map(), {
			infoCache: {
				"chat\0provider/cached": { fetchedAt: now, info: { id: "provider/cached", name: "Cached Live" } },
			},
		});
		expect(calls).toBe(0);
		expect(out.cachedInfo).toBe(1);
		expect(out.fetched).toBe(0);
		expect(entries[0].name).toBe("Cached Live");
	});

	test("expired cached record is re-probed and refreshed", async () => {
		let calls = 0;
		globalThis.fetch = (async () => {
			calls++;
			return {
				ok: true,
				status: 200,
				statusText: "OK",
				text: async () => "",
				json: async () => ({ id: "provider/old", name: "Reprobed" }),
			};
		}) as unknown as typeof fetch;

		const entries: CatalogEntry[] = [{ id: "provider/old", name: "provider/old", kind: "chat" }];
		const out = await enrichCatalog("http://localhost:20128", "key", entries, new Map(), {
			infoCache: {
				"chat\0provider/old": {
					fetchedAt: Date.now() - INFO_CACHE_TTL - 1,
					info: { id: "provider/old", name: "Stale" },
				},
			},
		});
		expect(calls).toBe(1);
		expect(out.cachedInfo).toBe(0);
		expect(entries[0].name).toBe("Reprobed");
		expect(out.infoCache["chat\0provider/old"].fetchedAt).toBeGreaterThan(Date.now() - 60_000);
	});

	test("progress callback fires for long enriches", async () => {
		globalThis.fetch = (async () => ({
			ok: false,
			status: 404,
			statusText: "Not Found",
			text: async () => "gone",
		})) as unknown as typeof fetch;

		const seen: string[] = [];
		const entries: CatalogEntry[] = Array.from({ length: 5 }, (_, i) => ({
			id: `provider/t${i}`,
			name: `provider/t${i}`,
			kind: "chat",
		}));
		await enrichCatalog("http://localhost:20128", "key", entries, new Map(), {
			onProgress: (msg) => seen.push(msg),
		});
		expect(seen.length).toBeGreaterThan(0);
		expect(seen[0]).toContain("Fetching metadata for 5 models");
		expect(seen[seen.length - 1]).toContain("Metadata 5/5");
	});
});

// ── HYGIENE BATCH-A (b): chat+image twins share one info probe ─────────

describe("enrichCatalog twin dedupe (real code, stubbed fetch)", () => {
	const realFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = realFetch;
	});

	test("chat+image twins with the same bare id burn one probe; both entries named", async () => {
		let calls = 0;
		globalThis.fetch = (async () => {
			calls++;
		return {
			ok: true,
			status: 200,
			statusText: "OK",
			text: async () => "",
			json: async () => ({ id: "provider/twin", name: "Twin Live" }),
		};
		}) as unknown as typeof fetch;

		const entries: CatalogEntry[] = [
			{ id: "provider/twin", name: "provider/twin", kind: "chat" },
			{ id: "provider/twin", name: "provider/twin", kind: "image" },
		];
		const out = await enrichCatalog("http://localhost:20128", "key", entries, new Map());
		expect(calls).toBe(1);
		expect(out.fetched).toBe(1);
		expect(entries[0].name).toBe("Twin Live");
		expect(entries[1].name).toBe("Twin Live");
		// Kind-qualified reads stay intact — each twin holds its own record.
		expect(out.infoById.get(catalogKey("chat", "provider/twin"))).toMatchObject({
			id: "provider/twin",
			name: "Twin Live",
		});
		expect(out.infoById.get(catalogKey("image", "provider/twin"))).toMatchObject({
			id: "provider/twin",
			name: "Twin Live",
		});
	});
});

// ── HYGIENE BATCH-A (c): kind-qualified positive infoCache keys ────────

describe("enrichCatalog kind-qualified positive cache (real code, stubbed fetch)", () => {
	const realFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = realFetch;
	});

	test("same-kind record is reused with zero HTTP", async () => {
		let calls = 0;
		globalThis.fetch = (async () => {
			calls++;
			throw new Error("must not fetch");
		}) as unknown as typeof fetch;

		const now = Date.now();
		const entries: CatalogEntry[] = [{ id: "provider/cached", name: "provider/cached", kind: "chat" }];
		const out = await enrichCatalog("http://localhost:20128", "key", entries, new Map(), {
			infoCache: {
				["chat\0provider/cached"]: {
					fetchedAt: now,
					info: { id: "provider/cached", name: "Cached Live" },
				},
			},
		});
		expect(calls).toBe(0);
		expect(out.cachedInfo).toBe(1);
		expect(out.fetched).toBe(0);
		expect(entries[0].name).toBe("Cached Live");
	});

	test("a fresh record cached for one kind is not reused by another kind within TTL", async () => {
		let calls = 0;
		globalThis.fetch = (async () => {
			calls++;
		return {
				ok: true,
				status: 200,
				statusText: "OK",
				text: async () => "",
				json: async () => ({ id: "provider/repurposed", name: "Repurposed Live" }),
			};
		}) as unknown as typeof fetch;

		// Simulates a record fetched for chat (old bare-id write format): the
		// image twin must re-probe instead of wearing chat's cached name.
		const entries: CatalogEntry[] = [
			{ id: "provider/repurposed", name: "provider/repurposed", kind: "image" },
		];
		const out = await enrichCatalog("http://localhost:20128", "key", entries, new Map(), {
			infoCache: {
				"provider/repurposed": {
					fetchedAt: Date.now(),
					info: { id: "provider/repurposed", name: "Chat Cached" },
				},
			},
		});
		expect(calls).toBe(1);
		expect(out.cachedInfo).toBe(0);
		expect(entries[0].name).toBe("Repurposed Live");
		expect(out.infoCache["image\0provider/repurposed"]?.info).toMatchObject({
			id: "provider/repurposed",
		});
	});
});

// ── CORE BATCH (b): abort during enrich is failure, not success ─────────

describe("fetchAllAndBuild abort during enrich (quick mode, stubbed fetch)", () => {
	const realFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = realFetch;
	});

	test("aborted enrich returns ok:false with an abort error (no partial success)", async () => {
		const ctrl = new AbortController();
		globalThis.fetch = (async (url: unknown) => {
			const u = String(url);
			if (u.endsWith("/api/health")) {
				return {
					ok: true,
					status: 200,
					statusText: "OK",
					text: async () => "",
					json: async () => ({ ok: true }),
				};
			}
			if (u.endsWith("/v1/models")) {
				return {
					ok: true,
					status: 200,
					statusText: "OK",
					text: async () => "",
					json: async () => ({ data: [{ id: "a/m1" }, { id: "a/m2" }] }),
				};
			}
			// First info probe aborts mid-enrich; every probe then fails.
			if (!ctrl.signal.aborted) ctrl.abort(new Error("aborted"));
			return {
				ok: false,
				status: 0,
				statusText: "aborted",
				text: async () => "aborted",
			};
		}) as unknown as typeof fetch;

		const out = await fetchAllAndBuild({ endpoint: "http://127.0.0.1:1" }, {
			mode: "quick",
			signal: ctrl.signal,
		});
		expect(out.ok).toBe(false);
		expect(out.error ?? "").toMatch(/abort/i);
		expect(out.chatModels).toEqual([]);
	});
});

// ── CORE BATCH (c): malformed cache lifecycle ───────────────────────────

describe("enrichCatalog malformed cache blobs (no crash, no resurrection)", () => {
	const realFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = realFetch;
	});

	function notFoundStub(calls: { n: number }): void {
		globalThis.fetch = (async () => {
			calls.n++;
			return { ok: false, status: 404, statusText: "Not Found", text: async () => "gone" };
		}) as unknown as typeof fetch;
	}

	test("NaN/null/string timestamps are dropped, fresh numeric survives", async () => {
		const calls = { n: 0 };
		notFoundStub(calls);
		const now = Date.now();
		const out = await enrichCatalog(
			"http://localhost:20128",
			"key",
			[{ id: "a/fresh", name: "a/fresh", kind: "chat" }],
			new Map(),
			{
				infoMissing: {
					"a/fresh": now,
					"a/nan": NaN,
					"a/null": null,
					"a/str": "yesterday",
				} as unknown as Record<string, number>,
			},
		);
		expect(out.infoMissing["a/fresh"]).toBe(now);
		expect("a/nan" in out.infoMissing).toBe(false);
		expect("a/null" in out.infoMissing).toBe(false);
		expect("a/str" in out.infoMissing).toBe(false);
	});

	test("string/array top-level blobs do not crash and do not resurrect", async () => {
		const calls = { n: 0 };
		notFoundStub(calls);
		const out = await enrichCatalog(
			"http://localhost:20128",
			"key",
			[{ id: "a/m", name: "a/m", kind: "chat" }],
			new Map(),
			{
				infoMissing: "oops" as unknown as Record<string, number>,
				infoCache: ["bad"] as unknown as Record<string, never>,
			},
		);
		// Thin row with no usable cache must be probed exactly once, then
		// negatively cached as a true-404 (numeric timestamp).
		expect(calls.n).toBe(1);
		expect(typeof out.infoMissing["a/m"]).toBe("number");
		expect(Number.isFinite(out.infoMissing["a/m"])).toBe(true);
	});

	test("{info:null} positive-cache record is skipped, re-probed, never kept", async () => {
		let calls = 0;
		globalThis.fetch = (async () => {
			calls++;
			return {
					ok: true,
					status: 200,
					statusText: "OK",
					text: async () => "",
					json: async () => ({ id: "a/m", name: "Live Name" }),
				};
		}) as unknown as typeof fetch;
		const entries: CatalogEntry[] = [{ id: "a/m", name: "a/m", kind: "chat" }];
		const out = await enrichCatalog("http://localhost:20128", "key", entries, new Map(), {
			infoCache: {
				"chat\0a/m": { fetchedAt: Date.now(), info: null },
			} as unknown as Record<string, { fetchedAt: number; info: RemoteModel }>,
		});
		expect(calls).toBe(1);
		expect(entries[0].name).toBe("Live Name");
		expect(out.cachedInfo).toBe(0);
		// Replaced by the fresh live record — the null is gone.
		expect(out.infoCache["chat\0a/m"]?.info).toMatchObject({ id: "a/m" });
	});
});

// ── CORE BATCH (d): caps-only hint stale window ──────────────────────────

describe("toPiModelWithCachedName caps-only hint re-fallthrough", () => {
	test("capless live row re-runs pattern inference instead of trusting a stale pattern hint", () => {
		const thin: RemoteModel = { id: "openai/gpt-4o" };
		const staleHint: RemoteModel = {
			id: "openai/gpt-4o",
			capabilities: { contextWindow: 111, maxOutput: 222 },
		};
		const def = toPiModelWithCachedName(thin, "GPT-4o (Friendly)", staleHint, {
			hintFromPattern: true,
		});
		// Independent source: the MODEL_PATTERN_CAPS *gpt-4o* row in
		// extensions/9router.ts (128000 context / 16384 output).
		expect(def.name).toBe("GPT-4o (Friendly)");
		expect(def.contextWindow).toBe(128000);
		expect(def.maxTokens).toBe(16384);
	});

	test("live-derived hint still wins for a capless row (provenance flag off)", () => {
		const thin: RemoteModel = { id: "openai/gpt-4o" };
		const liveHint: RemoteModel = {
			id: "openai/gpt-4o",
			capabilities: { contextWindow: 1000000, maxOutput: 128000 },
		};
		const def = toPiModelWithCachedName(thin, "GPT-4o (Friendly)", liveHint);
		expect(def.contextWindow).toBe(1000000);
		expect(def.maxTokens).toBe(128000);
	});

	test("unknown model with no pattern match keeps the hint even when flagged", () => {
		const thin: RemoteModel = { id: "mystery/model-x" };
		const hint: RemoteModel = {
			id: "mystery/model-x",
			capabilities: { contextWindow: 111, maxOutput: 222 },
		};
		const def = toPiModelWithCachedName(thin, "Mystery", hint, { hintFromPattern: true });
		expect(def.contextWindow).toBe(111);
		expect(def.maxTokens).toBe(222);
	});
});

// ── HYGIENE BATCH-A (a): enrich progress step math ──────────────────────

describe("enrichCatalog progress step (real code, stubbed fetch)", () => {
	const realFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = realFetch;
	});

	function notFoundStub(): void {
		globalThis.fetch = (async () => ({
			ok: false,
			status: 404,
			statusText: "Not Found",
			text: async () => "gone",
		})) as unknown as typeof fetch;
	}

	function thinEntries(n: number): CatalogEntry[] {
		return Array.from({ length: n }, (_, i) => ({
			id: `provider/m${i}`,
			name: `provider/m${i}`,
			kind: "chat",
		}));
	}

	test("total=1000 yields ~10 Metadata notifies (step scales, not capped at 10)", async () => {
		notFoundStub();
		const seen: string[] = [];
		await enrichCatalog("http://localhost:20128", "key", thinEntries(1000), new Map(), {
			onProgress: (msg) => seen.push(msg),
		});
		const meta = seen.filter((m) => m.startsWith("Metadata"));
		// 1000 ids at ~10 updates per enrich: steps of 100 → exactly 10.
		expect(meta.length).toBe(10);
		expect(meta[meta.length - 1]).toBe("Metadata 1000/1000…");
	});

	test("small totals still notify per model (step floor is 1)", async () => {
		notFoundStub();
		const seen: string[] = [];
		await enrichCatalog("http://localhost:20128", "key", thinEntries(5), new Map(), {
			onProgress: (msg) => seen.push(msg),
		});
		const meta = seen.filter((m) => m.startsWith("Metadata"));
		expect(meta.length).toBe(5);
		expect(meta[meta.length - 1]).toBe("Metadata 5/5…");
	});
});

// ── STATUS BATCH: statusLines branches (stale / Catalog / Stale rows) ──

describe("statusLines branch rows (Status surface split from triage)", () => {
	test("stale lastSync flags the Last-sync row, Catalog row lists tool counts", () => {
		const lines = statusLines({
			endpoint: "http://localhost:20128",
			lastSync: new Date(Date.now() - 48 * 3600_000).toISOString(),
			lastSyncMode: "full",
			counts: { chat: 2, image: 3 },
			infoMissing: { "ghost/model": Date.now() },
			chatModels: [],
			catalog: [],
		});
		const lastSync = lines.find((l) => l.startsWith("Last sync:")) ?? "";
		expect(lastSync).toContain("(full)");
		expect(lastSync).toContain("⚠ stale (>24h)");
		const catalog = lines.find((l) => l.startsWith("Catalog:")) ?? "";
		expect(catalog).toContain("image:3");
		const triage = lines.find((l) => l.startsWith("Triage:")) ?? "";
		expect(triage).toContain("stale");
		expect(triage).toContain("missing-info: 1");
	});

	test("stale catalog entries get the confirm row; fresh minimal config omits Catalog/Stale rows", () => {
		const withStale = statusLines({
			endpoint: "http://localhost:20128",
			lastSync: new Date().toISOString(),
			chatModels: [],
			catalog: [{ id: "p/pic", name: "Pic", kind: "image", stale: true }],
		});
		const staleRow = withStale.find((l) => l.startsWith("Stale:")) ?? "";
		expect(staleRow).toContain("1 unconfirmed");
		expect(staleRow).toContain("full sync");

		const fresh = statusLines({
			endpoint: "http://localhost:20128",
			lastSync: new Date().toISOString(),
			chatModels: [],
			catalog: [],
		});
		expect(fresh.some((l) => l.startsWith("Catalog:"))).toBe(false);
		expect(fresh.some((l) => l.startsWith("Stale:"))).toBe(false);
		expect(fresh.find((l) => l.startsWith("Last sync:")) ?? "").not.toContain("stale");
	});
});
