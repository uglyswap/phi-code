import { describe, expect, it } from "vitest";
import {
	assertUniqueIds,
	type EvalTask,
	formatReport,
	summarize,
	type TaskRunResult,
	validateTask,
} from "../evals/lib.js";

const task = (id: string): EvalTask => ({ id, description: "d", prompt: "p", verify: "true" });

describe("validateTask", () => {
	it("accepts a well-formed task", () => {
		const t = validateTask({ id: "a", description: "d", prompt: "p", verify: "node -e 1", timeoutSec: 60 });
		expect(t.id).toBe("a");
		expect(t.timeoutSec).toBe(60);
	});
	it("rejects missing/empty required fields", () => {
		expect(() => validateTask({ id: "a", description: "d", prompt: "p" }, "x.json")).toThrow(/verify/);
		expect(() => validateTask({ id: "", description: "d", prompt: "p", verify: "v" })).toThrow(/id/);
		expect(() => validateTask(null)).toThrow();
	});
	it("rejects a non-positive timeout", () => {
		expect(() => validateTask({ id: "a", description: "d", prompt: "p", verify: "v", timeoutSec: 0 })).toThrow(
			/timeoutSec/,
		);
	});
});

describe("assertUniqueIds", () => {
	it("passes on unique ids and throws on duplicates", () => {
		expect(() => assertUniqueIds([task("a"), task("b")])).not.toThrow();
		expect(() => assertUniqueIds([task("a"), task("a")])).toThrow(/duplicate task id: a/);
	});
});

describe("summarize", () => {
	const results: TaskRunResult[] = [
		{ taskId: "t1", strategy: "baseline", passed: true, durationMs: 1000 },
		{ taskId: "t2", strategy: "baseline", passed: false, durationMs: 3000 },
		{ taskId: "t3", strategy: "baseline", passed: true, durationMs: 2000 },
		{ taskId: "t1", strategy: "plan", passed: true, durationMs: 5000 },
		{ taskId: "t2", strategy: "plan", passed: true, durationMs: 7000 },
		{ taskId: "t3", strategy: "plan", passed: true, durationMs: 6000 },
	];

	it("computes pass rate and mean duration per strategy", () => {
		const s = summarize(results);
		const baseline = s.find((x) => x.strategy === "baseline")!;
		const plan = s.find((x) => x.strategy === "plan")!;
		expect(baseline.passed).toBe(2);
		expect(baseline.total).toBe(3);
		expect(baseline.passRate).toBeCloseTo(2 / 3);
		expect(baseline.meanDurationMs).toBe(2000);
		expect(plan.passRate).toBe(1);
	});

	it("sorts by pass rate desc, then mean duration asc", () => {
		const s = summarize(results);
		expect(s[0].strategy).toBe("plan"); // 100% beats 67%
	});

	it("excludes errored runs from the mean duration", () => {
		const s = summarize([
			{ taskId: "t1", strategy: "x", passed: false, durationMs: 9999, error: "phi exited 1" },
			{ taskId: "t2", strategy: "x", passed: true, durationMs: 1000 },
		]);
		expect(s[0].meanDurationMs).toBe(1000); // the errored 9999 is not averaged in
		expect(s[0].passed).toBe(1);
		expect(s[0].total).toBe(2);
	});

	it("handles an empty result set", () => {
		expect(summarize([])).toEqual([]);
	});
});

describe("formatReport", () => {
	it("renders a summary table and per-task rows including errors", () => {
		const results: TaskRunResult[] = [
			{ taskId: "t1", strategy: "baseline", passed: true, durationMs: 1500 },
			{ taskId: "t2", strategy: "baseline", passed: false, durationMs: 2500, error: "phi exited 1" },
		];
		const report = formatReport(results, summarize(results));
		expect(report).toContain("# phi-code eval report");
		expect(report).toContain("| baseline |");
		expect(report).toContain("t1");
		expect(report).toContain("PASS");
		expect(report).toContain("error: phi exited 1");
	});
});
