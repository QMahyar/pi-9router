/**
 * End-to-end tests against a live 9Router + local extension modules.
 *
 *   bun run scripts/e2e-test.ts
 *
 * Requires 9Router at NINEROUTER_URL (default http://localhost:20128).
 * Writes temp media under $LOCALAPPDATA/Temp/pi-9router-e2e (or /tmp).
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
	authHeaders,
	healthCheck,
	httpGetJson,
	isSyncStale,
	listRowIsRich,
	postBinary,
	postJson,
	withTimeout,
} from "../extensions/lib/shared.ts";
import { fetchAllAndBuild, diagnoseConnection } from "../extensions/9router.ts";
import { resolveModel, describeModels, CAPS, generateImages } from "../extensions/9router-tools.ts";

const EP = (process.env.NINEROUTER_URL || "http://localhost:20128").replace(/\/$/, "");
const KEY = (process.env.NINEROUTER_KEY || "9router").trim();
const OUT = join(tmpdir(), "pi-9router-e2e");

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(name: string, detail?: string) {
	passed++;
	console.log(`  ✓ ${name}${detail ? `  (${detail})` : ""}`);
}

function fail(name: string, err: string) {
	failed++;
	failures.push(`${name}: ${err}`);
	console.log(`  ✗ ${name}`);
	console.log(`      ${err}`);
}

async function assert(name: string, fn: () => Promise<void> | void) {
	try {
		await fn();
		ok(name);
	} catch (e: any) {
		fail(name, e?.message || String(e));
	}
}

function expect(cond: unknown, msg: string): asserts cond {
	if (!cond) throw new Error(msg);
}

// ── Suite ───────────────────────────────────────────────────────

console.log(`\npi-9router E2E  endpoint=${EP}  out=${OUT}\n`);
if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// 1. Shared HTTP helpers
console.log("1. shared helpers");
await assert("authHeaders always sets Bearer", () => {
	const h = authHeaders("9router", true);
	expect(h.Authorization === "Bearer 9router", `got ${h.Authorization}`);
	expect(h["Content-Type"] === "application/json", "missing content-type");
});

await assert("withTimeout aborts", async () => {
	const signal = withTimeout(50);
	const t0 = Date.now();
	await new Promise<void>((resolve, reject) => {
		const iv = setInterval(() => {
			if (signal.aborted) {
				clearInterval(iv);
				resolve();
			}
			if (Date.now() - t0 > 2000) {
				clearInterval(iv);
				reject(new Error("did not abort"));
			}
		}, 10);
	});
	expect(signal.aborted, "signal not aborted");
});

await assert("isSyncStale", () => {
	expect(isSyncStale(undefined) === true, "undefined should be stale");
	expect(isSyncStale(new Date().toISOString()) === false, "now should not be stale");
	expect(isSyncStale(new Date(Date.now() - 48 * 3600_000).toISOString()) === true, "48h should be stale");
});

await assert("listRowIsRich detects chat caps", () => {
	// Chat list shape: caps without name/kind
	expect(
		listRowIsRich({
			id: "x",
			capabilities: { contextWindow: 1e6, vision: true, maxOutput: 64000 },
		}),
		"chat-style caps should be rich",
	);
	expect(
		listRowIsRich({
			id: "x",
			name: "X",
			capabilities: { contextWindow: 1e6, vision: true },
		}),
		"named+caps should be rich",
	);
	expect(!listRowIsRich({ id: "y", owned_by: "z" }), "thin row should not be rich");
	expect(!listRowIsRich({ id: "z", capabilities: { vision: true } }), "flag-only without name should be thin");
});

// 2. Health + diagnose
console.log("\n2. connectivity");
const health = await healthCheck(EP);
await assert("health check", () => {
	expect(health.ok, health.error || "health failed");
	expect((health.ms ?? 0) >= 0, "ms missing");
});
if (!health.ok) {
	console.log("\n9Router not reachable — aborting live tests.\n");
	process.exit(1);
}

const diag = await diagnoseConnection({ endpoint: EP, apiKey: KEY });
await assert("diagnose returns kinds", () => {
	expect(diag.kinds.length >= 3, `only ${diag.kinds.length} kinds`);
	const chat = diag.kinds.find((k) => k.kind === "chat");
	expect(chat?.ok, `chat list failed: ${chat?.error}`);
	expect((chat?.count ?? 0) > 0, "no chat models");
});
console.log(
	`     diagnose: ${diag.kinds.map((k) => `${k.kind}=${k.ok ? k.count + "@" + k.ms + "ms" : "FAIL"}`).join("  ")}`,
);
console.log(
	`     voice: ${diag.voiceProbes.map((v) => `${v.provider}=${v.ok ? "ok" : "fail"}`).join("  ")}`,
);

// 3. Quick sync
console.log("\n3. quick sync (chat only)");
const tQuick = Date.now();
const quick = await fetchAllAndBuild(
	{ endpoint: EP, apiKey: KEY },
	{ mode: "quick", onProgress: (m) => process.stdout.write(`\r     ${m.padEnd(60)}`) },
);
process.stdout.write("\r" + " ".repeat(70) + "\r");
const quickMs = Date.now() - tQuick;
await assert("quick sync ok", () => {
	expect(quick.ok, quick.error || "quick failed");
	expect(quick.mode === "quick", `mode=${quick.mode}`);
	expect(quick.chatModels.length > 0, "no chat models");
});
ok("quick sync timing", `${quick.chatModels.length} chat · ${quickMs}ms · info fetched=${quick.infoFetched} skipped=${quick.infoSkipped}`);

// 4. Full sync
console.log("\n4. full sync");
const tFull = Date.now();
const full = await fetchAllAndBuild(
	{ endpoint: EP, apiKey: KEY },
	{ mode: "full", onProgress: (m) => process.stdout.write(`\r     ${m.padEnd(60)}`) },
);
process.stdout.write("\r" + " ".repeat(70) + "\r");
const fullMs = Date.now() - tFull;
await assert("full sync ok", () => {
	expect(full.ok, full.error || "full failed");
	expect(full.catalog.length > full.chatModels.length, "catalog should include non-chat");
	expect((full.counts.image ?? 0) >= 0, "image count missing");
});
ok(
	"full sync timing",
	`${full.catalog.length} catalog · ${full.chatModels.length} chat · ${fullMs}ms · info ${full.infoFetched}/${full.infoSkipped}`,
);

// Dedupe check
await assert("no duplicate (kind,id)", () => {
	const keys = full.catalog.map((c) => `${c.kind}\0${c.id}`);
	const set = new Set(keys);
	expect(set.size === keys.length, `dupes: ${keys.length - set.size}`);
});

// Smart enrich: chat should skip most info calls
await assert("smart enrich skips rich chat rows", () => {
	expect(
		(full.infoSkipped ?? 0) > 0 || (full.infoFetched ?? 0) < full.catalog.length,
		`fetched all ${full.infoFetched} with skip ${full.infoSkipped}`,
	);
});

// 5. resolveModel
console.log("\n5. resolveModel");
const cfg: any = {
	endpoint: EP,
	apiKey: KEY,
	catalog: full.catalog,
	counts: full.counts,
	capabilities: {
		image: { enabled: true, model: "nb/nanobanana-flash" },
		tts: { enabled: true },
		web_search: { enabled: true },
		web_fetch: { enabled: true },
		embed: { enabled: true },
	},
};

const imageCap = CAPS.find((c) => c.id === "image")!;
const ttsCap = CAPS.find((c) => c.id === "tts")!;
const searchCap = CAPS.find((c) => c.id === "web_search")!;

await assert("resolve exact image id", () => {
	const r = resolveModel(cfg, imageCap, "nb/nanobanana-flash");
	expect(r.ok && r.id === "nb/nanobanana-flash", JSON.stringify(r));
});

await assert("resolve leaf / fuzzy name", () => {
	const r = resolveModel(cfg, imageCap, "nanobanana-pro");
	expect(r.ok, JSON.stringify(r));
	if (r.ok) expect(r.id.includes("nanobanana-pro") || r.id.includes("nanobanana"), r.id);
});

await assert("resolve default when omitted", () => {
	const r = resolveModel(cfg, imageCap);
	expect(r.ok && r.id === "nb/nanobanana-flash", JSON.stringify(r));
});

await assert("reject unknown model with list", () => {
	const r = resolveModel(cfg, imageCap, "definitely-not-a-model-xyz");
	expect(!r.ok, "should fail");
	if (!r.ok) expect(r.message.includes("Available"), r.message);
});

await assert("voice provider passthrough", () => {
	const r = resolveModel(cfg, ttsCap, "edge-tts/en-US-AriaNeural");
	expect(r.ok && r.id === "edge-tts/en-US-AriaNeural", JSON.stringify(r));
});

await assert("describeModels includes params or ids", () => {
	const d = describeModels(cfg, imageCap);
	expect(d.includes("Available") || d.includes("nb/"), d.slice(0, 120));
});

// 6. Image generation (n=2)
console.log("\n6. image generation");
const imgModels = full.catalog.filter((c) => c.kind === "image");
if (imgModels.length) {
	const model = imgModels.find((m) => m.id.includes("nanobanana-flash"))?.id || imgModels[0].id;
	const tImg = Date.now();
	const gen = await generateImages({
		ep: EP,
		key: KEY,
		outDir: OUT,
		model,
		prompt: "a tiny solid red square on white background, simple flat icon",
		n: 2,
	});
	const imgMs = Date.now() - tImg;
	await assert("image n=2 produces files", () => {
		expect(!gen.error || gen.saved.length > 0, gen.error || "no files");
		expect(gen.saved.length >= 1, `saved ${gen.saved.length}: ${gen.error || ""}`);
		for (const f of gen.saved) {
			expect(existsSync(f), `missing ${f}`);
			expect(statSync(f).size > 100, `too small ${f}`);
		}
	});
	ok("image files", `${gen.saved.length} file(s) · ${model} · ${imgMs}ms`);
	if (gen.saved.length < 2) {
		console.log(`     note: n=2 returned ${gen.saved.length} (provider may ignore n)`);
	}

	// Edit/ref with first image as reference (best-effort — may 400 on models without edit)
	if (gen.saved[0]) {
		const edit = await generateImages({
			ep: EP,
			key: KEY,
			outDir: OUT,
			model,
			prompt: "same red square but blue instead",
			n: 1,
			imageUrls: [`data:image/png;base64,${readFileSync(gen.saved[0]).toString("base64")}`],
		});
		if (edit.saved.length) {
			ok("image edit/ref path", edit.saved[0]);
		} else {
			console.log(`     image edit skipped/failed (ok if model has no edit): ${edit.error || "no output"}`);
			ok("image edit attempted without crash");
		}
	}
} else {
	console.log("  · no image models — skip");
}

// 7. TTS binary-first
console.log("\n7. TTS");
const ttsId =
	full.catalog.find((c) => c.id.startsWith("edge-tts/"))?.id ||
	full.catalog.find((c) => c.kind === "tts" && !c.synthetic)?.id;
if (ttsId) {
	const t0 = Date.now();
	const bin = await postBinary(`${EP}/v1/audio/speech`, KEY, {
		model: ttsId,
		input: "Hello from pi nine router end to end test.",
	});
	const ms = Date.now() - t0;
	await assert("TTS binary response", () => {
		expect(bin.ok, !bin.ok ? bin.error : "");
		if (bin.ok) {
			expect(bin.bytes.length > 200, `only ${bin.bytes.length} bytes`);
			const path = join(OUT, `tts-e2e.mp3`);
			writeFileSync(path, bin.bytes);
			expect(statSync(path).size > 200, "file too small");
		}
	});
	ok("TTS timing", `${ttsId} · ${ms}ms · ${bin.ok ? (bin as any).bytes.length + " bytes" : "fail"}`);
} else {
	console.log("  · no tts models — skip");
}

// 8. Embeddings (if any)
console.log("\n8. embeddings");
const emb = full.catalog.find((c) => c.kind === "embedding");
if (emb) {
	const res = await postJson(`${EP}/v1/embeddings`, KEY, {
		model: emb.id,
		input: "pi-9router e2e",
	});
	await assert("embeddings", () => {
		expect(res.ok, !res.ok ? res.error : "");
		if (res.ok) {
			const vec = res.data?.data?.[0]?.embedding;
			expect(Array.isArray(vec) && vec.length > 8, "bad vector");
		}
	});
} else {
	console.log("  · no embedding models — skip");
}

// 9. Web search / fetch (best-effort — needs provider keys)
console.log("\n9. web tools (best-effort)");
const searchModel = full.catalog.find(
	(c) => c.kind === "web" && (c.detailKind === "webSearch" || /search/i.test(c.id)),
);
if (searchModel) {
	const apiModel = searchModel.id.replace(/\/search$/i, "");
	const res = await postJson(`${EP}/v1/search`, KEY, {
		model: apiModel,
		query: "9Router open source",
		max_results: 2,
	});
	if (res.ok) {
		const n = (res.data?.results || res.data?.data || []).length;
		ok("web search", `${apiModel} · ${n} results`);
	} else {
		console.log(`     web search unavailable (${res.status}): ${String(res.error).slice(0, 120)}`);
		ok("web search handled failure");
	}
} else {
	console.log("  · no search models — skip");
}

const fetchModel = full.catalog.find(
	(c) => c.kind === "web" && (c.detailKind === "webFetch" || /fetch/i.test(c.id)),
);
if (fetchModel) {
	const apiModel = fetchModel.id.replace(/\/fetch$/i, "");
	const res = await postJson(`${EP}/v1/web/fetch`, KEY, {
		model: apiModel,
		url: "https://example.com",
		format: "markdown",
		max_characters: 500,
	});
	if (res.ok) {
		ok("web fetch", apiModel);
	} else {
		console.log(`     web fetch unavailable (${res.status}): ${String(res.error).slice(0, 120)}`);
		ok("web fetch handled failure");
	}
} else {
	console.log("  · no fetch models — skip");
}

// 10. resolve search provider strip semantics
console.log("\n10. provider strip semantics");
await assert("search model resolves to catalog id", () => {
	if (!searchModel) return;
	const r = resolveModel(cfg, searchCap, searchModel.id);
	expect(r.ok && r.id === searchModel.id, JSON.stringify(r));
	const wire = r.ok ? r.id.replace(/\/search$/i, "") : "";
	expect(wire && !wire.includes("/"), `wire still has slash: ${wire}`);
});

// 11. Video (opt-in — creating a job bills the account): NR_E2E_VIDEO=1
console.log("\n11. video (opt-in)");
if (process.env.NR_E2E_VIDEO === "1") {
	const VIDEO_DEFAULT_MODEL = "xai/grok-imagine-video";
	const create = await postJson(`${EP}/v1/videos/generations`, KEY, {
		model: VIDEO_DEFAULT_MODEL,
		prompt: "a red square gently bouncing on a white background",
		duration: 6,
	});
	if (!create.ok && create.status === 403) {
		console.log(`     video not available on this account (403): ${String(create.error).slice(0, 100)}`);
		ok("video 403 handled with clear error");
	} else if (!create.ok) {
		console.log(`     video create failed (${create.status}): ${String(create.error).slice(0, 120)}`);
		ok("video create failure handled");
	} else if (create.data?.request_id) {
		const conn = create.headers["x-9router-connection-id"] || create.headers["x-connection-id"];
		ok("video job created", `request_id=${create.data.request_id}${conn ? " + connection id" : " (no connection id header!)"}`);
		// Poll once after a short wait just to prove the poll endpoint shape; a full
		// wait-to-done is intentionally not done here (minutes + billing).
		await new Promise((r) => setTimeout(r, 4000));
		const poll = await httpGetJson<any>(`${EP}/v1/videos/${create.data.request_id}`, KEY, {
			headers: conn ? { "x-connection-id": conn } : {},
		});
		await assert("video poll returns a status", () => {
			expect(poll.ok, !poll.ok ? `HTTP ${poll.status}: ${poll.error}` : "");
			expect(typeof poll.data?.status === "string", JSON.stringify(poll.data).slice(0, 200));
		});
	} else {
		console.log(`     video create returned no request_id: ${JSON.stringify(create.data).slice(0, 120)}`);
		ok("video create without request_id handled");
	}
} else {
	console.log("  · skipped (set NR_E2E_VIDEO=1 to attempt a billed test generation)");
}

// 12. STT (best-effort — needs an STT provider connected + the section 7 TTS file)
console.log("\n12. STT (best-effort)");
const sttModel = full.catalog.find((c) => c.kind === "stt");
const ttsOutFile = join(OUT, "tts-e2e.mp3");
if (sttModel && existsSync(ttsOutFile)) {
	const form = new FormData();
	form.append("model", sttModel.id);
	form.append(
		"file",
		new Blob([new Uint8Array(readFileSync(ttsOutFile))], { type: "audio/mpeg" }),
		"tts-e2e.mp3",
	);
	const res = await fetch(`${EP}/v1/audio/transcriptions`, {
		method: "POST",
		headers: { Authorization: `Bearer ${KEY}` },
		body: form,
	});
	if (res.ok) {
		const body = await res.text();
		ok("stt transcription", `${sttModel.id} · ${body.slice(0, 60)}`);
	} else {
		console.log(`     stt unavailable (${res.status}): ${(await res.text()).slice(0, 120)}`);
		ok("stt failure handled");
	}
} else {
	console.log(sttModel ? "  · no tts-e2e.mp3 artifact (tts skipped) — skip" : "  · no stt models connected — skip");
}

// Summary
console.log(`\n${"─".repeat(50)}`);
console.log(`Results: ${passed} passed · ${failed} failed`);
if (failures.length) {
	console.log("\nFailures:");
	for (const f of failures) console.log(`  - ${f}`);
}
console.log(`Artifacts: ${OUT}\n`);
process.exit(failed ? 1 : 0);
