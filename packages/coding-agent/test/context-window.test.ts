import { describe, expect, test } from "vitest";
import { inferContextWindow } from "../extensions/phi/providers/context-window.js";

describe("inferContextWindow", () => {
	test("prefers a positive API-reported value", () => {
		expect(inferContextWindow("qwen3.7-plus", 262_144)).toBe(262_144);
		expect(inferContextWindow("anything", 50_000)).toBe(50_000);
	});

	test("ignores a missing or non-positive API value and infers by family", () => {
		expect(inferContextWindow("qwen3.7-plus")).toBe(1_000_000);
		expect(inferContextWindow("qwen3.7-plus", 0)).toBe(1_000_000);
		expect(inferContextWindow("qwen3.7-plus", -1)).toBe(1_000_000);
	});

	test("infers large context for Qwen / MiniMax", () => {
		expect(inferContextWindow("minimax-m2.7")).toBe(1_000_000);
		expect(inferContextWindow("qwen/qwen3-32b")).toBe(1_000_000);
	});

	test("infers Gemini windows (flash vs pro)", () => {
		expect(inferContextWindow("gemini-2.5-pro")).toBe(2_000_000);
		expect(inferContextWindow("gemini-2.5-flash")).toBe(1_000_000);
	});

	test("infers Kimi / GLM / MiMo / GPT-5 / Claude families", () => {
		expect(inferContextWindow("kimi-k2.6")).toBe(256_000);
		expect(inferContextWindow("glm-5.1")).toBe(200_000);
		expect(inferContextWindow("mimo-v2-pro")).toBe(200_000);
		expect(inferContextWindow("gpt-5.4")).toBe(400_000);
		expect(inferContextWindow("claude-sonnet-4")).toBe(200_000);
	});

	test("uses the provider hint when the model id is opaque", () => {
		expect(inferContextWindow("models/abc-123", undefined, "google")).toBe(2_000_000);
	});

	test("falls back to 128k for unknown families", () => {
		expect(inferContextWindow("deepseek-v4-pro")).toBe(128_000);
		expect(inferContextWindow("some-random-model")).toBe(128_000);
	});
});
