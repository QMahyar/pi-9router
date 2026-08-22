import { describe, expect, test } from "bun:test";
import {
	fillModelCaps,
	globMatch,
	mapThinkingCompat,
} from "../extensions/9router.ts";
import type { ModelCapabilities } from "../extensions/lib/shared.ts";

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
		const caps: ModelCapabilities = { vision: false };
		expect(fillModelCaps("mystery/model-x", caps)).toEqual(caps);
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
