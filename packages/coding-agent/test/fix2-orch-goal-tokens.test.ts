/**
 * Regression: the /goal --tokens budget counts the tokens each turn really
 * consumed (output + input processed fresh, cache writes included), never the
 * cached context re-read on every turn.
 */
import { describe, expect, it } from "vitest";
import { consumedTokens } from "../extensions/phi/goal/index.ts";

describe("goal consumedTokens", () => {
	it("counts input, cacheWrite and output but not cacheRead", () => {
		expect(
			consumedTokens({ input: 10, output: 200, cacheRead: 50_000, cacheWrite: 1_500, totalTokens: 51_710 }),
		).toBe(1_710);
	});

	it("ignores missing, negative or non-numeric fields", () => {
		expect(consumedTokens(undefined)).toBe(0);
		expect(consumedTokens({ input: "12", output: -3, cacheWrite: Number.NaN })).toBe(0);
		expect(consumedTokens({ output: 7 })).toBe(7);
	});

	it("grows linearly over a cached multi-turn run (the re-sent context is not recounted)", () => {
		// Anthropic-like turns: each turn re-reads the whole prior context from the
		// cache and writes only its new 1k-token delta.
		let context = 10_000;
		let total = 0;
		for (let turn = 0; turn < 20; turn++) {
			total += consumedTokens({ input: 5, cacheRead: context, cacheWrite: 1_000, output: 300 });
			context += 1_300;
		}
		expect(total).toBe(20 * 1_305);
	});
});
