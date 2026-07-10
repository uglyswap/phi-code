import { describe, expect, it } from "vitest";
import {
	analyzePhaseMessages,
	buildNextBrief,
	buildPhaseSummary,
	decidePhaseTransition,
	type PhaseEndAnalysis,
} from "../extensions/phi/providers/phase-machine.js";

const MAX = 60;

// ─── Message fixtures (Pi's loose message shapes) ────────────────────────────
const toolResult = (name: string, content: string, extra: Record<string, unknown> = {}) => ({
	role: "toolResult",
	name,
	content,
	...extra,
});
const assistant = (content: string, extra: Record<string, unknown> = {}) => ({ role: "assistant", content, ...extra });

function baseAnalysis(overrides: Partial<PhaseEndAnalysis> = {}): PhaseEndAnalysis {
	return {
		userAborted: false,
		hasAuthError: false,
		transient: false,
		toolCallCount: 5,
		filesWritten: [],
		filesEdited: [],
		errorsHit: [],
		testResults: [],
		calledMemorySearch: true,
		calledMemoryWrite: true,
		...overrides,
	};
}

describe("analyzePhaseMessages", () => {
	it("counts tool calls and extracts written/edited files", () => {
		const a = analyzePhaseMessages([
			assistant("working on it"),
			toolResult("write", "Successfully wrote 128 bytes to src/a.ts"),
			toolResult("edit", "Successfully replaced 2 block(s) in src/b.ts."),
			toolResult("memory_search", "no results"),
			toolResult("memory_write", "saved"),
		]);
		expect(a.toolCallCount).toBe(4);
		expect(a.filesWritten).toEqual(["src/a.ts"]);
		expect(a.filesEdited).toEqual(["src/b.ts"]);
		expect(a.calledMemorySearch).toBe(true);
		expect(a.calledMemoryWrite).toBe(true);
	});

	it("treats edit old-text mismatch as a retry, not an error", () => {
		const a = analyzePhaseMessages([
			toolResult("edit", "ERR: The old text does not match", { isError: true }),
			toolResult("edit", "old_text not found"),
		]);
		expect(a.errorsHit).toEqual([]);
	});

	it("captures genuine tool errors", () => {
		const a = analyzePhaseMessages([toolResult("bash", "Error: command failed with exit 1")]);
		expect(a.errorsHit.length).toBe(1);
		expect(a.errorsHit[0]).toContain("bash");
	});

	it("detects user abort from an aborted assistant message", () => {
		expect(analyzePhaseMessages([assistant("", { stopReason: "aborted" })]).userAborted).toBe(true);
		expect(analyzePhaseMessages([assistant("done", { stopReason: "stop" })]).userAborted).toBe(false);
	});

	it("detects a genuine 401 auth error but not a bare 401 in prose", () => {
		expect(analyzePhaseMessages([assistant("HTTP 401: invalid access token")]).hasAuthError).toBe(true);
		expect(analyzePhaseMessages([assistant("the endpoint returned 401 rows")]).hasAuthError).toBe(false);
	});

	it("flags missing mandatory memory tools", () => {
		const a = analyzePhaseMessages([toolResult("write", "Successfully wrote 10 bytes to x.ts")]);
		expect(a.calledMemorySearch).toBe(false);
		expect(a.calledMemoryWrite).toBe(false);
	});

	it("handles empty and malformed message lists without throwing", () => {
		expect(analyzePhaseMessages([]).toolCallCount).toBe(0);
		expect(analyzePhaseMessages([{}, { role: "toolResult" }, { content: null }]).toolCallCount).toBe(1);
	});
});

describe("decidePhaseTransition — priority ordering", () => {
	const phase = (key: string, retried = false) => ({ key, retried });

	it("user abort wins over everything", () => {
		const d = decidePhaseTransition({
			analysis: baseAnalysis({ userAborted: true, hasAuthError: true, transient: true }),
			phase: phase("code"),
			verdict: "BLOCKED",
			hasReport: true,
			reviewFixRounds: 0,
			maxToolCallsPerPhase: MAX,
		});
		expect(d).toEqual({ action: "stop", reason: "user-abort" });
	});

	it("auth error wins over transient retry", () => {
		const d = decidePhaseTransition({
			analysis: baseAnalysis({ hasAuthError: true, transient: true }),
			phase: phase("code"),
			verdict: null,
			hasReport: true,
			reviewFixRounds: 0,
			maxToolCallsPerPhase: MAX,
		});
		expect(d).toEqual({ action: "stop", reason: "auth-error" });
	});

	it("retries once on a transient error, but not after the phase already retried", () => {
		const input = {
			analysis: baseAnalysis({ transient: true }),
			verdict: null,
			hasReport: true,
			reviewFixRounds: 0,
			maxToolCallsPerPhase: MAX,
		};
		expect(decidePhaseTransition({ ...input, phase: phase("explore", false) }).action).toBe("retry-fallback");
		// Already retried → fall through to continue, not a second retry.
		expect(decidePhaseTransition({ ...input, phase: phase("explore", true) }).action).toBe("continue");
	});

	it("pauses on a BLOCKED verdict", () => {
		const d = decidePhaseTransition({
			analysis: baseAnalysis(),
			phase: phase("test"),
			verdict: "BLOCKED",
			hasReport: true,
			reviewFixRounds: 0,
			maxToolCallsPerPhase: MAX,
		});
		expect(d.action).toBe("pause-blocked");
	});

	it("opens exactly one review-fix cycle on REVIEW FAIL", () => {
		const input = {
			analysis: baseAnalysis(),
			phase: phase("review"),
			verdict: "FAIL" as const,
			hasReport: true,
			maxToolCallsPerPhase: MAX,
		};
		expect(decidePhaseTransition({ ...input, reviewFixRounds: 0 }).action).toBe("review-fix-cycle");
		// Second time (round already spent) → continue, no infinite fix loop.
		expect(decidePhaseTransition({ ...input, reviewFixRounds: 1 }).action).toBe("continue");
	});

	it("does NOT open a fix cycle when a FAIL review is also looping (tool-call storm)", () => {
		const d = decidePhaseTransition({
			analysis: baseAnalysis({ toolCallCount: MAX + 50 }),
			phase: phase("review"),
			verdict: "FAIL",
			hasReport: true,
			reviewFixRounds: 0,
			maxToolCallsPerPhase: MAX,
		});
		expect(d.action).toBe("continue");
	});

	it("FAIL on a non-review phase just continues (only review gates)", () => {
		const d = decidePhaseTransition({
			analysis: baseAnalysis(),
			phase: phase("test"),
			verdict: "FAIL",
			hasReport: true,
			reviewFixRounds: 0,
			maxToolCallsPerPhase: MAX,
		});
		expect(d.action).toBe("continue");
	});
});

describe("decidePhaseTransition — model deviating from the text contract", () => {
	it("flags a missing VERDICT line for phases that require one (test/review)", () => {
		for (const key of ["test", "review"]) {
			const d = decidePhaseTransition({
				analysis: baseAnalysis(),
				phase: { key },
				verdict: null, // model wrote a report but no parseable VERDICT
				hasReport: true,
				reviewFixRounds: 0,
				maxToolCallsPerPhase: MAX,
			});
			expect(d).toMatchObject({ action: "continue", missingVerdict: true });
		}
	});

	it("does not flag a missing verdict for phases that never write one (explore/plan/code)", () => {
		for (const key of ["explore", "plan", "code"]) {
			const d = decidePhaseTransition({
				analysis: baseAnalysis(),
				phase: { key },
				verdict: null,
				hasReport: true,
				reviewFixRounds: 0,
				maxToolCallsPerPhase: MAX,
			});
			expect(d).toMatchObject({ action: "continue", missingVerdict: false });
		}
	});

	it("does not flag a missing verdict when no report file was written at all", () => {
		// No report is a separate (handoff-fallback) situation, not a contract deviation.
		const d = decidePhaseTransition({
			analysis: baseAnalysis(),
			phase: { key: "review" },
			verdict: null,
			hasReport: false,
			reviewFixRounds: 0,
			maxToolCallsPerPhase: MAX,
		});
		expect(d).toMatchObject({ action: "continue", missingVerdict: false });
	});

	it("surfaces a text-only phase (0 tool calls) as a continue with the flag set", () => {
		const d = decidePhaseTransition({
			analysis: baseAnalysis({ toolCallCount: 0 }),
			phase: { key: "plan" },
			verdict: null,
			hasReport: false,
			reviewFixRounds: 0,
			maxToolCallsPerPhase: MAX,
		});
		expect(d).toMatchObject({ action: "continue", zeroToolCalls: true });
	});

	it("tolerates a null phase (queue race) without throwing", () => {
		const d = decidePhaseTransition({
			analysis: baseAnalysis(),
			phase: null,
			verdict: null,
			hasReport: false,
			reviewFixRounds: 0,
			maxToolCallsPerPhase: MAX,
		});
		expect(d.action).toBe("continue");
	});
});

describe("buildPhaseSummary / buildNextBrief", () => {
	it("summarizes files, tests and mandatory-tool omissions", () => {
		const s = buildPhaseSummary(
			baseAnalysis({
				toolCallCount: 3,
				filesWritten: ["a.ts"],
				testResults: ["PASS foo"],
				calledMemorySearch: false,
			}),
			MAX,
		);
		expect(s).toContain("Tool calls: 3");
		expect(s).toContain("Files created/written: a.ts");
		expect(s).toContain("PASS foo");
		expect(s).toContain("did NOT call memory_search");
	});

	it("warns on a tool-call storm above the limit", () => {
		expect(buildPhaseSummary(baseAnalysis({ toolCallCount: MAX + 1 }), MAX)).toContain("Possible loop detected");
	});

	it("prefers the HANDOFF block over the heuristic summary when present", () => {
		const brief = buildNextBrief(baseAnalysis({ toolCallCount: 7 }), "State: done\nNext: ship", "🔍 EXPLORE", MAX);
		expect(brief).toContain("## HANDOFF (from 🔍 EXPLORE)");
		expect(brief).toContain("Next: ship");
		expect(brief).toContain("Tool calls: 7");
	});

	it("falls back to the heuristic summary when no HANDOFF was written", () => {
		const brief = buildNextBrief(baseAnalysis({ filesWritten: ["x.ts"] }), "", "PLAN", MAX);
		expect(brief).not.toContain("## HANDOFF");
		expect(brief).toContain("Files created/written: x.ts");
	});
});
