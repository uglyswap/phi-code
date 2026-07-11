import { describe, expect, it } from "vitest";
import type { AcceptanceReport, CriterionResult } from "../extensions/phi/providers/acceptance.js";
import { decideBuildRound } from "../extensions/phi/providers/build-loop.js";
import type { BreakingCase } from "../extensions/phi/providers/redteam.js";

const crit = (description: string, satisfied: boolean | null, check?: string): CriterionResult => ({
	criterion: { description, check },
	satisfied,
	result:
		satisfied === null
			? undefined
			: {
					command: check ?? "",
					exitCode: satisfied ? 0 : 1,
					stdout: "",
					stderr: "",
					durationMs: 1,
					timedOut: false,
				},
});

const report = (results: CriterionResult[]): AcceptanceReport => {
	const failed = results.filter((r) => r.satisfied === false);
	const manual = results.filter((r) => r.satisfied === null);
	const checkable = results.filter((r) => r.satisfied !== null);
	return { results, failed, manual, allCheckablePassed: checkable.length > 0 && failed.length === 0 };
};

const brk = (regime: string): BreakingCase => ({ regime, test: `t-${regime}`, symptom: "red" });

describe("decideBuildRound", () => {
	it("SUCCESS when all checkable criteria pass and no break", () => {
		const d = decideBuildRound({
			round: 1,
			maxRounds: 4,
			acceptance: report([crit("a", true, "exit 0")]),
			breakingCases: [],
		});
		expect(d.status).toBe("success");
		expect(d.failures).toHaveLength(0);
	});

	it("SUCCESS still reports manual criteria as unverified, not as passed", () => {
		const d = decideBuildRound({
			round: 1,
			maxRounds: 4,
			acceptance: report([crit("checked", true, "exit 0"), crit("manual", null)]),
			breakingCases: [],
		});
		expect(d.status).toBe("success");
		expect(d.unverified).toEqual(["manual"]);
		expect(d.reason).toContain("unverified");
	});

	it("PARTIAL (not success) when nothing was executably verified", () => {
		const d = decideBuildRound({
			round: 1,
			maxRounds: 4,
			acceptance: report([crit("manual only", null)]),
			breakingCases: [],
		});
		expect(d.status).toBe("partial");
		expect(d.reason).toContain("nothing verified");
	});

	it("CONTINUE with failing criteria routed to /debug when under budget", () => {
		const d = decideBuildRound({
			round: 1,
			maxRounds: 4,
			acceptance: report([crit("login works", false, "pytest test_login.py")]),
			breakingCases: [],
			cwd: "/repo",
		});
		expect(d.status).toBe("continue");
		expect(d.failures).toHaveLength(1);
		expect(d.failures[0].reproCommand).toBe("pytest test_login.py");
		expect(d.failures[0].expected).toBe("login works");
		expect(d.failures[0].cwd).toBe("/repo");
	});

	it("includes red-team breaking cases as failures", () => {
		const d = decideBuildRound({
			round: 1,
			maxRounds: 4,
			acceptance: report([crit("ok", true, "exit 0")]),
			breakingCases: [brk("empty input")],
		});
		expect(d.status).toBe("continue");
		expect(d.failures).toHaveLength(1);
		expect(d.failures[0].reproCommand).toBe("t-empty input");
	});

	it("PARTIAL when the round budget is exhausted, listing what still fails", () => {
		const d = decideBuildRound({
			round: 4,
			maxRounds: 4,
			acceptance: report([crit("x", false, "pytest x")]),
			breakingCases: [brk("boundary value")],
		});
		expect(d.status).toBe("partial");
		expect(d.failures).toHaveLength(2);
		expect(d.reason).toContain("budget exhausted");
	});
});
