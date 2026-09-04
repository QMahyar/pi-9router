import { afterEach, describe, expect, test } from "bun:test";
import {
	DIAGNOSE_PROBE_KINDS,
	debugLog,
	diagnoseConnection,
	formatDiagnose,
	formatTriageLine,
	isDebugTopic,
	statusLines,
} from "../extensions/9router.ts";

const realFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = realFetch;
});

/** Stub fetch for diagnose: health OK, chat list of 2, one row per other
 *  kind, video 404 (no list endpoint), info hit, voice probes fail fast. */
function stubDiagnoseFetch(seen: string[]): void {
	globalThis.fetch = (async (url: unknown, init?: { method?: string }) => {
		const u = String(url);
		seen.push(`${init?.method ?? "GET"} ${u}`);
		const json = (v: unknown, status = 200) =>
			new Response(JSON.stringify(v), {
				status,
				headers: { "Content-Type": "application/json" },
			});
		if (u.endsWith("/api/health")) return json({ ok: true });
		if (u.includes("/v1/models/info")) {
			const id = new URL(u).searchParams.get("id") ?? "acme/chat-a";
			return json({ id, name: "Chat A Friendly" });
		}
		if (u.endsWith("/v1/audio/speech")) return new Response("tts unavailable", { status: 400 });
		if (u.endsWith("/v1/models")) {
			return json({
				data: [
					{ id: "acme/chat-a", name: "Chat A" },
					{ id: "acme/chat-b" },
				],
			});
		}
		const m = u.match(/\/v1\/models\/([\w-]+)$/);
		if (m) {
			if (m[1] === "video") return new Response("no such kind", { status: 404 });
			return json({ data: [{ id: `p/${m[1]}-1` }] });
		}
		return new Response("not found", { status: 404 });
	}) as unknown as typeof fetch;
}

describe("DIAGNOSE_PROBE_KINDS (ticket 5b)", () => {
	test("covers stt/video/image-to-text plus the legacy five", () => {
		for (const k of ["chat", "image", "tts", "stt", "embedding", "web", "image-to-text", "video"]) {
			expect((DIAGNOSE_PROBE_KINDS as readonly string[]).includes(k)).toBe(true);
		}
		expect(DIAGNOSE_PROBE_KINDS[0]).toBe("chat");
	});
});

describe("diagnoseConnection list reuse (ticket 5a, no server)", () => {
	test("fetches the chat list once and samples its first id", async () => {
		const seen: string[] = [];
		stubDiagnoseFetch(seen);
		const out = await diagnoseConnection({ endpoint: "http://127.0.0.1:1" });
		const chatLists = seen.filter((s) => s.endsWith("/v1/models"));
		expect(chatLists.length).toBe(1);
		const listCalls = seen.filter((s) => s.includes("/v1/models"));
		// Independent literal: 8 probe-kind lists + 1 info fetch (not
		// recomputed from DIAGNOSE_PROBE_KINDS — adding a kind must fail here).
		expect(listCalls.length).toBe(9);
		expect(out.sampleInfo?.id).toBe("acme/chat-a");
		expect(out.sampleInfo?.ok).toBe(true);
		expect(out.sampleInfo?.name).toBe("Chat A Friendly");
	});

	test("reports every probe kind with per-kind latency ms", async () => {
		const seen: string[] = [];
		stubDiagnoseFetch(seen);
		const out = await diagnoseConnection({ endpoint: "http://127.0.0.1:1" });
		// Independent literal: 8 probe kinds (chat/image/tts/stt/embedding/web/image-to-text/video).
		expect(out.kinds.length).toBe(8);
		for (const k of out.kinds) {
			expect(typeof k.ms).toBe("number");
		}
		const kinds = out.kinds.map((k) => k.kind);
		for (const want of ["stt", "video", "image-to-text"]) expect(kinds.includes(want)).toBe(true);
		expect(kinds.filter((k) => k === "chat").length).toBe(1);
	});
});

describe("formatDiagnose latency table + triage (ticket 5b/5c, no server)", () => {
	test("latency table has one row per kind with ms", async () => {
		const seen: string[] = [];
		stubDiagnoseFetch(seen);
		const out = await diagnoseConnection({ endpoint: "http://127.0.0.1:1" });
		const text = formatDiagnose(out);
		expect(text.includes("List latency:")).toBe(true);
		for (const k of DIAGNOSE_PROBE_KINDS) {
			const row = text.split("\n").find((l) => l.includes(k));
			expect(row).toBeDefined();
			expect(row!.includes("ms")).toBe(true);
		}
		// Video has no list endpoint — FAIL row still carries latency.
		const videoRow = text.split("\n").find((l) => l.includes("video"))!;
		expect(videoRow.includes("FAIL")).toBe(true);
		expect(videoRow.includes("ms")).toBe(true);
	});

	test("triage line carries mode, counts, stale, missing-info", async () => {
		const seen: string[] = [];
		stubDiagnoseFetch(seen);
		const now = Date.now();
		const out = await diagnoseConnection({
			endpoint: "http://127.0.0.1:1",
			lastSync: new Date(now - 30 * 60 * 1000).toISOString(),
			lastSyncMode: "full",
			counts: { chat: 2, image: 1 },
			infoMissing: { "ghost/model": now },
		});
		expect(out.lastSyncMode).toBe("full");
		expect(out.infoMissingCount).toBe(1);
		const text = formatDiagnose(out);
		const triage = text.split("\n").find((l) => l.startsWith("Triage:"))!;
		expect(triage).toBeDefined();
		expect(triage.includes("(full)")).toBe(true);
		expect(triage.includes("chat:2")).toBe(true);
		expect(triage.includes("fresh")).toBe(true);
		expect(triage.includes("missing-info: 1")).toBe(true);
	});
});

describe("formatTriageLine shape (ticket 5c)", () => {
	test("never-synced config reads fresh with no counts", () => {
		const line = formatTriageLine({ stale: true, infoMissingCount: 0 });
		expect(line.startsWith("Triage:")).toBe(true);
		expect(line.includes("last sync never")).toBe(true);
		expect(line.includes("no counts")).toBe(true);
		expect(line.includes("stale")).toBe(true);
		expect(line.includes("missing-info: 0")).toBe(true);
	});

	test("statusLines surfaces the triage line", () => {
		const lines = statusLines({
			endpoint: "http://localhost:20128",
			lastSync: new Date().toISOString(),
			lastSyncMode: "quick",
			counts: { chat: 1, stt: 2 },
			infoMissing: {},
			chatModels: [],
			catalog: [],
		});
		const triage = lines.find((l) => l.startsWith("Triage:"))!;
		expect(triage).toBeDefined();
		expect(triage.includes("(quick)")).toBe(true);
		expect(triage.includes("chat:1")).toBe(true);
		expect(triage.includes("stt:2")).toBe(true);
		expect(triage.includes("missing-info: 0")).toBe(true);
	});
});

describe("NR_DEBUG gated logging (ticket 5d)", () => {
	const saved = process.env.NR_DEBUG;
	afterEach(() => {
		if (saved === undefined) delete process.env.NR_DEBUG;
		else process.env.NR_DEBUG = saved;
	});

	test("off by default", () => {
		delete process.env.NR_DEBUG;
		expect(isDebugTopic("sync")).toBe(false);
		expect(isDebugTopic("timing")).toBe(false);
	});

	test("NR_DEBUG=sync,timing enables both topics", () => {
		process.env.NR_DEBUG = "sync,timing";
		expect(isDebugTopic("sync")).toBe(true);
		expect(isDebugTopic("timing")).toBe(true);
	});

	test("single topic + case-insensitive", () => {
		process.env.NR_DEBUG = "SYNC";
		expect(isDebugTopic("sync")).toBe(true);
		expect(isDebugTopic("timing")).toBe(false);
	});

	test("debugLog stays silent when off, writes when on", () => {
		const calls: string[] = [];
		const realErr = console.error;
		console.error = ((...a: unknown[]) => {
			calls.push(a.map(String).join(" "));
		}) as typeof console.error;
		try {
			delete process.env.NR_DEBUG;
			debugLog("timing", "quiet");
			expect(calls.length).toBe(0);
			process.env.NR_DEBUG = "timing";
			debugLog("timing", "loud");
			expect(calls.length).toBe(1);
			expect(calls[0].includes("[9router:timing]")).toBe(true);
		} finally {
			console.error = realErr;
		}
	});
});

describe("voice TTS probes (ticket 5b, no server)", () => {
	test("edge-tts + google-tts probed, FAIL rows carry latency", async () => {
		const seen: string[] = [];
		stubDiagnoseFetch(seen);
		const out = await diagnoseConnection({ endpoint: "http://127.0.0.1:1" });
		expect(out.voiceProbes.map((v) => v.provider).sort()).toEqual(["edge-tts", "google-tts"]);
		for (const v of out.voiceProbes) {
			expect(v.ok).toBe(false); // stub answers 400 to /v1/audio/speech
			expect(typeof v.ms).toBe("number");
		}
		expect(seen.some((s) => s.includes("/v1/audio/speech"))).toBe(true);
	});

	test("formatDiagnose renders the Voice TTS probes section", async () => {
		const seen: string[] = [];
		stubDiagnoseFetch(seen);
		const out = await diagnoseConnection({ endpoint: "http://127.0.0.1:1" });
		const text = formatDiagnose(out);
		expect(text.includes("Voice TTS probes:")).toBe(true);
		for (const p of ["edge-tts", "google-tts"]) {
			const row = text.split("\n").find((l) => l.includes(p))!;
			expect(row).toBeDefined();
			expect(row.includes("FAIL")).toBe(true);
			expect(row.includes("ms")).toBe(true);
		}
	});
});
