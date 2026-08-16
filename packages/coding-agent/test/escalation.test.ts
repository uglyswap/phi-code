import { describe, expect, it } from "vitest";
import {
	decideEscalation,
	parseReproCmd,
	pickCandidateModels,
	type RoutingLike,
} from "../extensions/phi/providers/escalation.ts";
import type { CommandResult } from "../extensions/phi/providers/execution.ts";

const run = (exitCode: number | null, over: Partial<CommandResult> = {}): CommandResult => ({
	command: "cmd",
	exitCode,
	stdout: "",
	stderr: "",
	durationMs: 5,
	timedOut: false,
	...over,
});

describe("decideEscalation — single-shot first, escalate only on red", () => {
	it("done-green when the repro and the suite both pass", () => {
		const d = decideEscalation(
			{ reproCommand: "node r.js" },
			{ repro: run(0, { command: "node r.js" }), suite: run(0, { command: "npm test" }) },
		);
		expect(d.action).toBe("done-green");
		if (d.action === "done-green") expect(d.evidence).toContain("exit 0");
	});

	it("done-green with only a green suite (no repro supplied)", () => {
		expect(decideEscalation({}, { repro: null, suite: run(0) }).action).toBe("done-green");
	});

	it("escalates when the reproduction is still red — with the exact command and trace", () => {
		const d = decideEscalation(
			{ reproCommand: "pytest -x t.py", expected: "should pass" },
			{ repro: run(1, { command: "pytest -x t.py", stderr: "AssertionError: boom" }), suite: null },
		);
		expect(d.action).toBe("escalate");
		if (d.action === "escalate") {
			expect(d.failing.reproCommand).toBe("pytest -x t.py");
			expect(d.failing.trace).toContain("boom");
			expect(d.failing.expected).toBe("should pass"); // original intent preserved
			expect(d.diagnostic).toContain("exit 1");
		}
	});

	it("escalates when the repro passes but the suite regressed", () => {
		const d = decideEscalation(
			{ reproCommand: "node r.js" },
			{ repro: run(0), suite: run(2, { command: "npm test", stdout: "3 failed" }) },
		);
		expect(d.action).toBe("escalate");
		if (d.action === "escalate") {
			expect(d.failing.failingTest).toBe("npm test");
			expect(d.diagnostic).toContain("suite is red");
		}
	});

	it("flags a timeout in the diagnostic (a hang is a failure)", () => {
		const d = decideEscalation({}, { repro: null, suite: run(null, { command: "npm test", timedOut: true }) });
		expect(d.action).toBe("escalate");
		if (d.action === "escalate") expect(d.diagnostic).toContain("TIMEOUT");
	});

	it("done-unverified when NOTHING was runnable — honest, never a fake green", () => {
		const d = decideEscalation({ expected: "prose only" }, { repro: null, suite: null });
		expect(d.action).toBe("done-unverified");
		if (d.action === "done-unverified") expect(d.reason).toContain("could not be oracle-checked");
	});
});

describe("parseReproCmd — the REPRODUCE handoff convention", () => {
	it("extracts the command from a REPRO-CMD line anywhere in the handoff", () => {
		expect(parseReproCmd("State: reproduced\nREPRO-CMD: pytest tests/x.py::test_y -x\nNext: localize")).toBe(
			"pytest tests/x.py::test_y -x",
		);
	});
	it("is case-insensitive and trims", () => {
		expect(parseReproCmd("repro-cmd:   node repro.js  ")).toBe("node repro.js");
	});
	it("returns undefined when absent or empty", () => {
		expect(parseReproCmd("State: done")).toBeUndefined();
		expect(parseReproCmd("REPRO-CMD: ")).toBeUndefined();
		expect(parseReproCmd(null)).toBeUndefined();
	});
});

describe("pickCandidateModels — diversity proposes", () => {
	const routing: RoutingLike = {
		routes: {
			explore: { preferredModel: "oc/minimax-m3", fallback: "ali/qwen" },
			code: { preferredModel: "ali/qwen", fallback: "oc/deepseek" },
			test: { preferredModel: "oc/mimo", fallback: "ali/qwen" },
			review: { preferredModel: "oc/deepseek", fallback: "oc/minimax-m3" },
		},
		default: { model: "ali/qwen" },
	};

	it("returns n distinct refs, coder first, then other families", () => {
		expect(pickCandidateModels(routing, 3)).toEqual(["ali/qwen", "oc/deepseek", "oc/mimo"]);
	});
	it("dedupes across routes", () => {
		expect(pickCandidateModels(routing, 4)).toEqual(["ali/qwen", "oc/deepseek", "oc/mimo", "oc/minimax-m3"]);
	});
	it("never returns more than available distinct refs", () => {
		expect(pickCandidateModels(routing, 10).length).toBe(4);
	});
	it("degrades to the default model on an empty routing", () => {
		expect(pickCandidateModels({ default: { model: "d/m" } }, 2)).toEqual(["d/m"]);
	});
});
