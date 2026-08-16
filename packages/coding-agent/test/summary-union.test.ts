import { describe, expect, test } from "vitest";
import { resolveSummaryUnion } from "../src/core/compaction/compaction.ts";

describe("resolveSummaryUnion (anti-drift guard)", () => {
	test("no previous summary returns the new summary unchanged", () => {
		expect(resolveSummaryUnion(undefined, "fresh summary")).toBe("fresh summary");
	});

	test("keeps the new summary when size is stable and no paths were dropped", () => {
		const previous = "worked on src/core/foo.ts and fixed the parser";
		const next = "continued work on src/core/foo.ts, parser fixed and tested end to end";
		expect(resolveSummaryUnion(previous, next)).toBe(next);
	});

	test("unions when the new summary shrinks by more than 40%", () => {
		const previous = "x".repeat(1000);
		const next = "y".repeat(100);
		const result = resolveSummaryUnion(previous, next);
		expect(result).toContain(previous);
		expect(result).toContain("## Updated Summary");
		expect(result).toContain(next);
	});

	test("unions when a referenced file path disappears", () => {
		const previous = "touched src/core/alpha.ts and src/core/beta.ts during the refactor";
		// Same order of magnitude in size, but beta.ts is gone.
		const next = "touched src/core/alpha.ts during the refactor, everything green";
		const result = resolveSummaryUnion(previous, next);
		expect(result).toContain("## Updated Summary");
		expect(result).toContain("beta.ts");
	});

	test("caps the union: past the ceiling the newest summary wins", () => {
		// A huge previous summary (e.g. the result of repeated unions) must not
		// keep growing monotonically: the guard yields to the cap.
		const previous = "x".repeat(70_000);
		const next = "y".repeat(100);
		expect(resolveSummaryUnion(previous, next)).toBe(next);
	});

	test("union survives below the cap even across repeated shrink triggers", () => {
		// Two consecutive unions below the cap still work (the cap only stops
		// the snowball, not the safety net).
		const first = resolveSummaryUnion("a".repeat(2000), "b".repeat(200));
		expect(first).toContain("## Updated Summary");
		const second = resolveSummaryUnion(first, "c".repeat(200));
		expect(second).toContain("## Updated Summary");
		expect(second.length).toBeLessThan(60_000);
	});
});
