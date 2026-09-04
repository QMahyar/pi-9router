import { describe, expect, test } from "bun:test";
import {
	CAPS,
	VIDEO_DEFAULT_MODEL,
	VIDEO_POLL_INTERVAL_MS,
	describeModels,
	gateUsageRec,
	isAutoRichDefault,
	isFatalMediaStatus,
	isVideoPassthroughId,
	needCap,
	planImageBatch,
	resolveModel,
	videoCreateError,
	videoPollChanged,
	withModelHint,
} from "../extensions/9router-tools.ts";
import { TIMEOUT, type CatalogEntry } from "../extensions/lib/shared.ts";

const imageCap = CAPS.find((c) => c.id === "image")!;
const ttsCap = CAPS.find((c) => c.id === "tts")!;
const searchCap = CAPS.find((c) => c.id === "web_search")!;
const fetchCap = CAPS.find((c) => c.id === "web_fetch")!;
const videoCap = CAPS.find((c) => c.id === "video")!;

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

describe("video resolveModel (no list endpoint — documented default)", () => {
	const videoCatalog: CatalogEntry[] = [
		entry("xai/grok-imagine-video", "video", { name: "Grok Imagine video" }),
		entry("acme/vid-pro", "video", { name: "Vid Pro" }),
	];

	test("documented default is xai/grok-imagine-video", () => {
		expect(VIDEO_DEFAULT_MODEL).toBe("xai/grok-imagine-video");
	});
	test("empty catalog falls back to the documented default instead of erroring", () => {
		const r = resolveModel({}, videoCap);
		expect(r.ok).toBe(true);
		// Independent literal (documented default), not the imported symbol.
		if (r.ok) expect(r.id).toBe("xai/grok-imagine-video");
	});
	test("catalog without video rows still falls back to the documented default", () => {
		const r = resolveModel({ catalog }, videoCap);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.id).toBe("xai/grok-imagine-video");
	});
	test("no override prefers the documented default when it is synced", () => {
		// acme first on purpose — the documented default still wins over models[0].
		const r = resolveModel(
			{ catalog: [...catalog, entry("acme/vid-pro", "video"), entry(VIDEO_DEFAULT_MODEL, "video")] },
			videoCap,
		);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.id).toBe("xai/grok-imagine-video");
	});
	test("saved video default is used when present in catalog", () => {
		const r = resolveModel(
			{ catalog: videoCatalog, capabilities: { video: { enabled: true, model: "acme/vid-pro" } } },
			videoCap,
		);
		expect(r.ok && r.id).toBe("acme/vid-pro");
	});
	test("exact, case-insensitive, and leaf matches", () => {
		const cfg = { catalog: videoCatalog };
		expect(resolveModel(cfg, videoCap, "acme/vid-pro").ok).toBe(true);
		const ci = resolveModel(cfg, videoCap, "ACME/Vid-Pro");
		expect(ci.ok).toBe(true);
		if (ci.ok) expect(ci.id).toBe("acme/vid-pro");
		const leaf = resolveModel(cfg, videoCap, "vid-pro");
		expect(leaf.ok).toBe(true);
		if (leaf.ok) expect(leaf.id).toBe("acme/vid-pro");
		const defaultLeaf = resolveModel(cfg, videoCap, "grok-imagine-video");
		expect(defaultLeaf.ok).toBe(true);
		if (defaultLeaf.ok) expect(defaultLeaf.id).toBe("xai/grok-imagine-video");
	});
	test("documented default is accepted even when only other video models are synced", () => {
		const cfg = { catalog: [entry("acme/vid-pro", "video")] };
		const r = resolveModel(cfg, videoCap, VIDEO_DEFAULT_MODEL);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.id).toBe("xai/grok-imagine-video");
	});
	test("unknown video model is rejected listing the available video models", () => {
		const r = resolveModel({ catalog: [...catalog, ...videoCatalog] }, videoCap, "nope");
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.message).toContain("xai/grok-imagine-video");
			expect(r.message).toContain("acme/vid-pro");
			expect(r.message).not.toContain("gemini/gemini-3-pro-image-preview");
		}
	});
	test("reject-list with no synced video rows names the documented default", () => {
		const r = resolveModel({ catalog }, videoCap, "nope");
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.message).toContain("xai/grok-imagine-video");
	});
	test("description path names the documented default", () => {
		expect(describeModels({ catalog }, videoCap)).toContain("xai/grok-imagine-video");
	});
});

describe("video FATAL abort parity (mirror generateImages)", () => {
	test("401/402/403 are fatal; transient statuses keep polling", () => {
		expect(isFatalMediaStatus(401)).toBe(true);
		expect(isFatalMediaStatus(402)).toBe(true);
		expect(isFatalMediaStatus(403)).toBe(true);
		for (const s of [0, 408, 429, 500, 502, 503, 504]) {
			expect(isFatalMediaStatus(s)).toBe(false);
		}
	});
	test("403 keeps the refusal message plus the server detail (bounded 2KB)", () => {
		const detail = `quota_exceeded:${"x".repeat(2000)}`;
		const msg = videoCreateError(403, detail);
		expect(msg).toContain("Video generation refused (403)");
		expect(msg).toContain("SuperGrok");
		expect(msg).toContain(detail); // 2007 chars < 2KB bound — kept whole
	});
	test("403 without server detail still explains the cause", () => {
		const msg = videoCreateError(403, "");
		expect(msg).toContain("Video generation refused (403)");
		expect(msg).toContain("SuperGrok");
	});
	test("non-403 create errors report status + server detail", () => {
		expect(videoCreateError(401, "bad key")).toBe("Video job submission failed (401): bad key");
		expect(videoCreateError(402, "no quota")).toBe("Video job submission failed (402): no quota");
		expect(videoCreateError(500, "boom")).toBe("Video job submission failed (500): boom");
	});
	test("status 0 names the orphaned-job risk (no request_id to poll)", () => {
		const msg = videoCreateError(0, "timeout after 120000ms");
		expect(msg).toContain("(status 0)");
		expect(msg).toContain("may still have been created");
		expect(msg).toContain("request_id");
		expect(msg).toContain("dashboard");
	});
	test("video timeouts: 600s deadline / 3s poll / 60s download", () => {
		expect(TIMEOUT.video).toBe(600_000);
		expect(VIDEO_POLL_INTERVAL_MS).toBe(3_000);
		expect(TIMEOUT.download).toBe(60_000);
	});
});

describe("resolveModel capability-aware auto default (ticket 7)", () => {
	const thinFirst: CatalogEntry[] = [
		entry("thin/img", "image", { name: "thin/img" }),
		entry("rich/img", "image", { name: "Rich", contextWindow: 32000 }),
	];
	test("omitted model + no default → rich row with a note", () => {
		const r = resolveModel({ catalog: thinFirst }, imageCap);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.id).toBe("rich/img");
			expect(r.note).toContain("rich caps");
		}
	});
	test("all thin → first entry, no note", () => {
		const r = resolveModel(
			{ catalog: [entry("a/m", "image"), entry("b/m", "image")] },
			imageCap,
		);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.id).toBe("a/m");
			expect(r.note).toBeUndefined();
		}
	});
	test("saved default still wins over the rich row", () => {
		const r = resolveModel(
			{ catalog: thinFirst, capabilities: { image: { enabled: true, model: "thin/img" } } },
			imageCap,
		);
		expect(r.ok && r.id).toBe("thin/img");
	});
});

describe("planImageBatch — batch presets (ticket 7)", () => {
	test("no prompts → n images of the single prompt, filename kept", () => {
		const out = planImageBatch({ prompt: "a cat", n: 3, filename: "cat.png" });
		expect(out.batch).toEqual([]);
		expect(out.n).toBe(3);
		expect(out.jobs).toEqual([{ prompt: "a cat", filename: "cat.png" }]);
	});
	test("prompts → one image each, n ignored, filenames unset", () => {
		const out = planImageBatch({ prompt: "unused", prompts: ["a", "b"], n: 4, filename: "x.png" });
		expect(out.batch).toEqual(["a", "b"]);
		expect(out.n).toBe(1);
		expect(out.jobs).toEqual([{ prompt: "a", filename: undefined }, { prompt: "b", filename: undefined }]);
	});
	test("blanks filtered, capped at 4", () => {
		const out = planImageBatch({
			prompt: "unused",
			prompts: [" a ", "", "  ", "b", "c", "d", "e"],
		});
		expect(out.batch).toEqual(["a", "b", "c", "d"]);
		expect(out.jobs.length).toBe(4);
	});
	test("all-blank prompts → single-prompt path", () => {
		const out = planImageBatch({ prompt: "solo", prompts: ["", "  "] });
		expect(out.batch).toEqual([]);
		expect(out.n).toBe(1);
		expect(out.jobs).toEqual([{ prompt: "solo", filename: undefined }]);
	});
	test("n caps at 4 on the single path", () => {
		expect(planImageBatch({ prompt: "p", n: 99 }).n).toBe(4);
		expect(planImageBatch({ prompt: "p" }).n).toBe(1);
	});
});

describe("video poll dedup (lastProgress — ~200 polls/job must not toast)", () => {
	// Fold a poll snapshot sequence through the dedup predicate the way the
	// tool loop does, counting the progress toasts that would fire.
	function toastCount(polls: { status?: string; progress?: number }[]): number {
		let last: { status?: string; progress?: number } = {};
		let n = 0;
		for (const job of polls) {
			if (videoPollChanged(last, job)) {
				n++;
				last = { status: job.status, progress: job.progress };
			}
		}
		return n;
	}

	test("200 identical polls toast once, not 200 times", () => {
		const polls = Array.from({ length: 200 }, () => ({ status: "processing", progress: 10 }));
		expect(toastCount(polls)).toBe(1);
	});
	test("each progress advance toasts", () => {
		expect(
			toastCount([
				{ status: "processing", progress: 10 },
				{ status: "processing", progress: 20 },
				{ status: "processing", progress: 30 },
			]),
		).toBe(3);
	});
	test("a status change without progress still toasts", () => {
		expect(toastCount([{ status: "queued" }, { status: "processing" }])).toBe(2);
	});
	test("polls with neither status nor progress never toast", () => {
		expect(toastCount([{}, {}, {}])).toBe(0);
	});
});

describe("video custom/future model passthrough hatch", () => {
	test("isVideoPassthroughId accepts provider/model, rejects bare and malformed ids", () => {
		expect(isVideoPassthroughId("xai/future-video-v9")).toBe(true);
		expect(isVideoPassthroughId("xai/grok-imagine-video")).toBe(true);
		expect(isVideoPassthroughId("nope")).toBe(false);
		expect(isVideoPassthroughId("/leading")).toBe(false);
		expect(isVideoPassthroughId("trailing/")).toBe(false);
		expect(isVideoPassthroughId("a/b/c")).toBe(false);
		expect(isVideoPassthroughId("")).toBe(false);
	});
	test("unknown provider/model passes through verbatim with a billing note", () => {
		const r = resolveModel({ catalog: [entry(VIDEO_DEFAULT_MODEL, "video")] }, videoCap, "xai/future-video-v9");
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.id).toBe("xai/future-video-v9");
			expect(r.note).toContain("passthrough");
		}
	});
	test("bare unknown name still rejects with the available candidates", () => {
		const r = resolveModel({ catalog: [entry(VIDEO_DEFAULT_MODEL, "video")] }, videoCap, "nope");
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.message).toContain("xai/grok-imagine-video");
	});
	test("voice-provider ids are rejected for video (no wasted billed create)", () => {
		for (const voice of ["edge-tts/en-US-AriaNeural", "google-tts/en", "el/eleven_multilingual_v2"]) {
			const r = resolveModel({ catalog: [entry(VIDEO_DEFAULT_MODEL, "video")] }, videoCap, voice);
			expect(r.ok).toBe(false);
			if (!r.ok) expect(r.message).toContain("xai/grok-imagine-video");
		}
	});
	test("saved voice default is not usable for video — falls back to the documented default", () => {
		const r = resolveModel(
			{
				catalog: [entry(VIDEO_DEFAULT_MODEL, "video")],
				capabilities: { video: { enabled: true, model: "edge-tts/en-US-AriaNeural" } },
			},
			videoCap,
		);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.id).toBe("xai/grok-imagine-video");
	});
	test("saved passthrough default is usable (no silent fallback to another model)", () => {
		const r = resolveModel(
			{
				catalog: [entry(VIDEO_DEFAULT_MODEL, "video")],
				capabilities: { video: { enabled: true, model: "xai/future-video-v9" } },
			},
			videoCap,
		);
		expect(r.ok && r.id).toBe("xai/future-video-v9");
	});
	test("passthrough is video-only — other caps still reject unknown ids", () => {
		const r = resolveModel({ catalog }, imageCap, "acme/future-image-v9");
		expect(r.ok).toBe(false);
	});
});

describe("gate failures reach the usage log (record seam)", () => {
	test("blocked gate builds a failing record with the tool + note", () => {
		const r = gateUsageRec("nr_tts", "Text to speech is off. Enable it in /9router-tools.");
		expect(r.tool).toBe("nr_tts");
		expect(r.ok).toBe(false);
		expect(r.ms).toBe(0);
		expect(r.note).toBe("Text to speech is off. Enable it in /9router-tools.");
		expect(r.model).toBeUndefined();
	});
	test("requested model is kept when present", () => {
		const r = gateUsageRec("nr_image_generate", 'Unknown image model "nope".', "nope");
		expect(r.model).toBe("nope");
		expect(r.ok).toBe(false);
		expect(r.tool).toBe("nr_image_generate");
	});
	test("blank requested model is dropped", () => {
		expect(gateUsageRec("nr_embed", "note", "   ").model).toBeUndefined();
	});
});

describe("auto default is explicit (billed default never silent)", () => {
	const thinFirst: CatalogEntry[] = [
		entry("thin/img", "image", { name: "thin/img" }),
		entry("rich/img", "image", { name: "Rich", contextWindow: 32000 }),
	];
	const allThin: CatalogEntry[] = [entry("a/m", "image"), entry("b/m", "image")];

	test("isAutoRichDefault is true only when the rich pick overrides the first entry", () => {
		expect(isAutoRichDefault({ catalog: thinFirst }, imageCap)).toBe(true);
	});
	test("saved default wins → not auto", () => {
		const cfg = { catalog: thinFirst, capabilities: { image: { enabled: true, model: "thin/img" } } };
		expect(isAutoRichDefault(cfg, imageCap)).toBe(false);
	});
	test("all thin → first entry, not auto", () => {
		expect(isAutoRichDefault({ catalog: allThin }, imageCap)).toBe(false);
	});
	test("description announces the auto default", () => {
		const d = withModelHint({ catalog: thinFirst }, imageCap, "Base.");
		expect(d).toContain("rich/img");
		expect(d).toContain("auto default");
	});
	test("description stays quiet for saved and all-thin defaults", () => {
		const saved = withModelHint(
			{ catalog: thinFirst, capabilities: { image: { enabled: true, model: "thin/img" } } },
			imageCap,
			"Base.",
		);
		expect(saved).toContain("thin/img");
		expect(saved).not.toContain("auto default");
		const thin = withModelHint({ catalog: allThin }, imageCap, "Base.");
		expect(thin).toContain("a/m");
		expect(thin).not.toContain("auto default");
	});
	test("resolveModel auto note names the billed model", () => {
		const r = resolveModel({ catalog: thinFirst }, imageCap);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.id).toBe("rich/img");
			expect(r.note).toContain("auto default");
		}
	});
});

describe("video stale saved default (non-passthrough bare id)", () => {
	const videoCatalog: CatalogEntry[] = [
		entry("xai/grok-imagine-video", "video", { name: "Grok Imagine video" }),
		entry("acme/vid-pro", "video", { name: "Vid Pro" }),
	];

	test("bare unknown saved default falls back to the documented default with a note", () => {
		// "gone-model" has no slash so it is NOT passthrough-eligible —
		// unlike "acme/gone", which would pass through verbatim.
		const r = resolveModel(
			{ catalog: videoCatalog, capabilities: { video: { enabled: true, model: "gone-model" } } },
			videoCap,
		);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.id).toBe("xai/grok-imagine-video");
			expect(r.note).toContain('default "gone-model" is no longer in the catalog');
		}
	});
});

describe("videoPollChanged predicate (direct seam)", () => {
	test("identical snapshot does not toast", () => {
		expect(
			videoPollChanged({ status: "processing", progress: 10 }, { status: "processing", progress: 10 }),
		).toBe(false);
	});
	test("progress advance toasts even when status is unchanged", () => {
		expect(
			videoPollChanged({ status: "processing", progress: 10 }, { status: "processing", progress: 20 }),
		).toBe(true);
	});
	test("status change toasts even when progress is unchanged", () => {
		expect(
			videoPollChanged({ status: "queued", progress: 10 }, { status: "processing", progress: 10 }),
		).toBe(true);
	});
	test("empty polls never toast", () => {
		expect(videoPollChanged({}, {})).toBe(false);
	});
	test("first poll from empty state toasts", () => {
		expect(videoPollChanged({}, { status: "queued" })).toBe(true);
	});
	test("progress appearing from undefined toasts (0 counts as progress)", () => {
		expect(videoPollChanged({ status: "processing" }, { status: "processing", progress: 0 })).toBe(true);
	});
});

describe("withModelHint video names the documented default", () => {
	test("empty catalog synthesizes the documented default with no auto marker", () => {
		const h = withModelHint({}, videoCap, "Base.");
		expect(h).toContain("xai/grok-imagine-video");
		expect(h).not.toContain("auto default");
	});
});

describe("needCap gate semantics", () => {
	const imageCap = CAPS.find((c) => c.id === "image")!;

	test("missing capability record falls back to the cap default", () => {
		// image is defaultEnabled → no gate message with no capabilities at all
		expect(needCap({ catalog: [entry("m/a", "image")] }, imageCap)).toBeNull();
	});
	test("stored enabled:null is OFF (original spread-merge semantics)", () => {
		expect(needCap({ catalog: [entry("m/a", "image")], capabilities: { image: { enabled: null } } as never }, imageCap)).toContain("is off");
	});
	test("stored enabled:false is OFF, enabled:true is ON", () => {
		expect(needCap({ catalog: [entry("m/a", "image")], capabilities: { image: { enabled: false } } }, imageCap)).toContain("is off");
		expect(needCap({ catalog: [entry("m/a", "image")], capabilities: { image: { enabled: true } } }, imageCap)).toBeNull();
	});
	test("enabled cap with an empty catalog asks for a sync", () => {
		expect(needCap({ catalog: [] }, imageCap)).toContain("Sync");
	});
});
