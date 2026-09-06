import { describe, expect, it } from "vitest";
import {
	computeSessionCostUsd,
	formatCostUsd,
	formatGitSegment,
	GitDirtyCache,
	parseGitPorcelainDirty,
	resolveStatusLineSegments,
} from "../src/modes/interactive/components/status-segments.ts";

describe("status line segments", () => {
	it("defaults to the full composition when config is missing", () => {
		expect(resolveStatusLineSegments(undefined)).toContain("cost");
		expect(resolveStatusLineSegments(undefined)).toContain("model");
		expect(resolveStatusLineSegments(null)).toHaveLength(7);
	});

	it("filters unknown ids and dedupes", () => {
		expect(resolveStatusLineSegments(["model", "bogus", "model", "cost"])).toEqual(["model", "cost"]);
	});

	it("falls back to default when only unknown ids are given", () => {
		expect(resolveStatusLineSegments(["bogus"])).toHaveLength(7);
	});

	it("computes session cost from provider total first", () => {
		expect(computeSessionCostUsd({ input: 1e6, output: 0, cacheRead: 0, cacheWrite: 0, cost: 2.5 })).toBe(2.5);
	});

	it("estimates cost from catalogue rates when provider cost is zero", () => {
		const cost = computeSessionCostUsd(
			{ input: 1_000_000, output: 500_000, cacheRead: 0, cacheWrite: 0, cost: 0 },
			{ input: 2, output: 10, cacheRead: 0, cacheWrite: 0 },
		);
		expect(cost).toBeCloseTo(7);
	});

	it("returns 0 when nothing is known", () => {
		expect(computeSessionCostUsd({ input: 100, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 })).toBe(0);
	});

	it("formats USD compactly", () => {
		expect(formatCostUsd(0)).toBe("$0.000");
		expect(formatCostUsd(0.0004)).toBe("$<0.001");
		expect(formatCostUsd(0.1234)).toBe("$0.123");
		expect(formatCostUsd(123.4)).toBe("$123");
	});

	it("parses git porcelain dirty state", () => {
		expect(parseGitPorcelainDirty("")).toBe(false);
		expect(parseGitPorcelainDirty(" M src/a.ts\n")).toBe(true);
	});

	it("formats the git segment with dirty marker", () => {
		expect(formatGitSegment(null, false)).toBeNull();
		expect(formatGitSegment("main", false)).toBe("main");
		expect(formatGitSegment("main", true)).toBe("main*");
	});

	it("caches git dirty lookups within the TTL", () => {
		let calls = 0;
		let now = 1000;
		const cache = new GitDirtyCache(
			() => {
				calls++;
				return " M file";
			},
			() => now,
		);
		expect(cache.isDirty("/repo")).toBe(true);
		expect(cache.isDirty("/repo")).toBe(true);
		expect(calls).toBe(1);
		now += 3000;
		expect(cache.isDirty("/repo")).toBe(true);
		expect(calls).toBe(2);
	});

	it("returns null when git is unavailable", () => {
		const cache = new GitDirtyCache(() => null);
		expect(cache.isDirty("/nowhere")).toBeNull();
	});
});
