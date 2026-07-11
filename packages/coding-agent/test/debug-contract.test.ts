import { describe, expect, it } from "vitest";
import {
	decideReproduce,
	decideVerify,
	type FailingState,
	hasReproducibleFailure,
	parseFailingState,
	reproCommand,
	type VerifiedCandidate,
} from "../extensions/phi/providers/debug-contract.js";
import type { CommandResult } from "../extensions/phi/providers/execution.js";

const run = (exitCode: number | null, over: Partial<CommandResult> = {}): CommandResult => ({
	command: "cmd",
	exitCode,
	stdout: "",
	stderr: "",
	durationMs: 10,
	timedOut: false,
	...over,
});

describe("hasReproducibleFailure / reproCommand", () => {
	it("requires a failing test or a repro command", () => {
		expect(hasReproducibleFailure({ failingTest: "pytest x" })).toBe(true);
		expect(hasReproducibleFailure({ reproCommand: "node r.js" })).toBe(true);
		expect(hasReproducibleFailure({ trace: "boom", expected: "no boom" })).toBe(false);
		expect(hasReproducibleFailure({})).toBe(false);
	});
	it("prefers the failing test as the repro command", () => {
		expect(reproCommand({ failingTest: "pytest x", reproCommand: "node r.js" })).toBe("pytest x");
		expect(reproCommand({ reproCommand: "node r.js" })).toBe("node r.js");
	});
});

describe("decideReproduce (the FALSIFY gate)", () => {
	it("blocks when there is nothing runnable", () => {
		expect(decideReproduce({ trace: "boom" }, null).action).toBe("blocked");
	});
	it("blocks when the repro could not be run at all", () => {
		const d = decideReproduce({ failingTest: "pytest x" }, null);
		expect(d).toMatchObject({ action: "blocked" });
		expect((d as { reason: string }).reason).toContain("environment");
	});
	it("blocks when the failure does NOT reproduce (passes on current code)", () => {
		const d = decideReproduce({ failingTest: "pytest x" }, run(0));
		expect(d).toMatchObject({ action: "blocked" });
		expect((d as { reason: string }).reason).toContain("does not reproduce");
	});
	it("proceeds when the repro genuinely fails on current code", () => {
		const d = decideReproduce({ failingTest: "pytest x" }, run(1));
		expect(d.action).toBe("proceed");
	});
});

describe("decideVerify (repro-passes AND suite-green, minimal wins)", () => {
	const patch = (n: number) => `diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n${"+l\n".repeat(n)}`;

	it("accepts only a candidate whose repro passes and suite is green, minimal diff wins", () => {
		const cands: VerifiedCandidate[] = [
			{ source: "c-big", patch: patch(8), reproAfter: run(0), suite: run(0) },
			{ source: "c-small", patch: patch(3), reproAfter: run(0), suite: run(0) },
		];
		const out = decideVerify(cands, true);
		expect(out.verdict).toBe("FIXED");
		expect(out.evidence).toEqual({ reproBefore: "fail", reproAfter: "pass", suite: "green" });
		// smallest of the two passing candidates
		expect(out.reason).toContain("c-small");
	});

	it("rejects a candidate that fixes the repro but REGRESSES the suite", () => {
		const cands: VerifiedCandidate[] = [{ source: "regressing", patch: patch(2), reproAfter: run(0), suite: run(1) }];
		expect(decideVerify(cands, true).verdict).toBe("BLOCKED");
	});

	it("rejects a candidate whose repro still fails", () => {
		const cands: VerifiedCandidate[] = [{ source: "nofix", patch: patch(2), reproAfter: run(1), suite: run(0) }];
		expect(decideVerify(cands, true).verdict).toBe("BLOCKED");
	});

	it("skips the suite gate when there is no suite", () => {
		const cands: VerifiedCandidate[] = [{ source: "c", patch: patch(2), reproAfter: run(0), suite: null }];
		const out = decideVerify(cands, false);
		expect(out.verdict).toBe("FIXED");
		expect(out.evidence?.suite).toBe("skipped");
	});

	it("BLOCKED, never least-bad, when nothing passes", () => {
		const cands: VerifiedCandidate[] = [
			{ source: "a", patch: patch(2), reproAfter: run(1), suite: run(0) },
			{ source: "b", patch: patch(9), reproAfter: run(1), suite: run(0) },
		];
		const out = decideVerify(cands, true);
		expect(out.verdict).toBe("BLOCKED");
		expect(out.patch).toBeUndefined();
	});
});

describe("parseFailingState", () => {
	it("classifies a test runner invocation as a failing test", () => {
		expect(parseFailingState("pytest tests/x.py::test_y").failingTest).toBe("pytest tests/x.py::test_y");
		expect(parseFailingState("npm test").failingTest).toBe("npm test");
	});
	it("classifies a command as a repro command", () => {
		expect(parseFailingState("node repro.js").reproCommand).toBe("node repro.js");
	});
	it("treats free prose as expected behaviour", () => {
		const s = parseFailingState("it should return unicode not bytes");
		expect(s.expected).toContain("unicode");
		expect(s.failingTest).toBeUndefined();
	});
	it("merges structured input", () => {
		const s: FailingState = parseFailingState("", { failingTest: "pytest a", cwd: "/repo" });
		expect(s.failingTest).toBe("pytest a");
		expect(s.cwd).toBe("/repo");
	});
});
