import { describe, expect, it } from "vitest";
import {
	buildVerifyInstruction,
	debugPhaseInstructions,
	formatFailingState,
} from "../extensions/phi/providers/debug-build-commands.js";

describe("formatFailingState", () => {
	it("renders each supplied field and omits the rest", () => {
		const md = formatFailingState({ failingTest: "pytest x", expected: "no crash", cwd: "/repo" });
		expect(md).toContain("pytest x");
		expect(md).toContain("no crash");
		expect(md).toContain("/repo");
		expect(md).not.toContain("Trace");
	});
	it("has a clear placeholder when nothing is supplied", () => {
		expect(formatFailingState({})).toContain("no structured failing state");
	});
});

describe("debugPhaseInstructions", () => {
	const ins = debugPhaseInstructions({ failingTest: "pytest tests/test_x.py::test_y", expected: "unicode not bytes" });

	it("puts the repro command in REPRODUCE and forbids inventing a bug", () => {
		expect(ins.reproduce).toContain("pytest tests/test_x.py::test_y");
		expect(ins.reproduce).toContain("BLOCKED: cannot reproduce");
		expect(ins.reproduce).toContain("no executable environment");
	});
	it("REPRODUCE observes only, does not edit", () => {
		expect(ins.reproduce).toMatch(/do not edit/i);
	});
	it("FIX enforces minimality", () => {
		expect(ins.fix).toMatch(/minimal|smallest/i);
		expect(ins.fix).toMatch(/liability/i);
	});
	it("VERIFY requires two real runs and forbids least-bad", () => {
		expect(ins.verify).toMatch(/re-run the reproduction|Re-run the reproduction/);
		expect(ins.verify).toMatch(/test suite/i);
		expect(ins.verify).toContain("VERDICT: FIXED | BLOCKED");
		expect(ins.verify).toMatch(/least-bad/i);
	});
	it("every phase carries the execution-is-oracle rules", () => {
		for (const text of [ins.reproduce, ins.localize, ins.fix, ins.verify]) {
			expect(text).toMatch(/Execution is the only oracle/i);
			expect(text).toMatch(/No fabricated PASS/i);
		}
	});
});

describe("buildVerifyInstruction", () => {
	const ins = buildVerifyInstruction("Build a REST API with JWT auth");

	it("embeds the spec and the run→acceptance→red-team→debug loop", () => {
		expect(ins).toContain("Build a REST API with JWT auth");
		expect(ins).toMatch(/Run recipe/i);
		expect(ins).toMatch(/Acceptance/i);
		expect(ins).toMatch(/red-team/i);
		expect(ins).toMatch(/\/debug protocol/i);
	});
	it("forbids counting unverifiable criteria as passing", () => {
		expect(ins).toMatch(/NEVER count ❔ as passing/);
	});
	it("distinguishes SUCCESS from an honest PARTIAL", () => {
		expect(ins).toContain("BUILD: SUCCESS");
		expect(ins).toContain("BUILD: PARTIAL");
		expect(ins).toMatch(/never a confident-wrong SUCCESS/i);
	});
});
