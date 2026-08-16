/**
 * /debug contract — turn a REAL failing state green, or honestly say BLOCKED.
 *
 * The whole point (docs/design/plan-debug-build.md): /debug never guesses what
 * is wrong. It is given a reproducible failure, confirms it fails on the current
 * code, fixes it, and VERIFIES by re-running — repro passes AND the existing
 * suite does not regress — selecting the minimal passing candidate. There is no
 * path to FIXED without execution.
 */

import { type FixCandidate, selectMinimalPassingCandidate } from "./candidate-select.ts";
import { type CommandResult, passed } from "./execution.ts";

/** A concrete, reproducible failing state — /debug's input. */
export interface FailingState {
	/** A test command, e.g. "pytest tests/x.py::test_y". */
	failingTest?: string;
	/** A stack trace / error output pasted from a real run. */
	trace?: string;
	/** A command that exhibits the bug. */
	reproCommand?: string;
	/** What should happen instead (from the user/spec). */
	expected?: string;
	cwd?: string;
}

/** How to run the existing suite, to catch regressions. */
export interface SuiteRecipe {
	test?: string;
}

export type DebugVerdict = "FIXED" | "BLOCKED";

export interface DebugOutcome {
	verdict: DebugVerdict;
	patch?: string;
	evidence?: { reproBefore: "fail"; reproAfter: "pass"; suite: "green" | "skipped" };
	reason?: string;
}

/** True when the input actually gives something runnable to reproduce. */
export function hasReproducibleFailure(state: FailingState): boolean {
	return Boolean(state.failingTest?.trim() || state.reproCommand?.trim());
}

/** The command that reproduces the failure (test preferred over generic repro). */
export function reproCommand(state: FailingState): string | undefined {
	return state.failingTest?.trim() || state.reproCommand?.trim() || undefined;
}

export type ReproduceDecision = { action: "proceed"; symptom: string } | { action: "blocked"; reason: string };

/**
 * REPRODUCE gate: the failing state must FAIL on the current code. If there is
 * nothing runnable, or it already passes, /debug stops — it will not fabricate a
 * bug or a repro from imagination.
 */
export function decideReproduce(state: FailingState, runOnCurrentCode: CommandResult | null): ReproduceDecision {
	if (!hasReproducibleFailure(state)) {
		return { action: "blocked", reason: "no reproducible failing state (need a failing test or a repro command)" };
	}
	if (runOnCurrentCode === null) {
		return { action: "blocked", reason: "could not run the reproduction (no executable environment)" };
	}
	if (passed(runOnCurrentCode)) {
		return { action: "blocked", reason: "the reported failure does not reproduce — it passes on the current code" };
	}
	return { action: "proceed", symptom: `${runOnCurrentCode.command} exited ${runOnCurrentCode.exitCode}` };
}

/** A fix candidate paired with its verification runs. */
export interface VerifiedCandidate {
	source: string;
	patch: string;
	/** The reproduction re-run WITH this candidate applied. */
	reproAfter: CommandResult | null;
	/** The existing suite re-run WITH this candidate applied (null = no suite). */
	suite: CommandResult | null;
}

/**
 * VERIFY: a candidate is accepted only if the repro now PASSES and the suite (if
 * any) is green. Among accepted candidates, pick the minimal diff. If none is
 * accepted, BLOCKED — never ship the least-bad.
 */
export function decideVerify(candidates: VerifiedCandidate[], hasSuite: boolean): DebugOutcome {
	const fixCandidates: FixCandidate[] = candidates.map((c) => {
		const reproOk = c.reproAfter !== null && passed(c.reproAfter);
		const suiteOk = !hasSuite || (c.suite !== null && passed(c.suite));
		return { source: c.source, patch: c.patch, passedRepro: reproOk && suiteOk };
	});
	const selection = selectMinimalPassingCandidate(fixCandidates);
	if (!selection.chosen) {
		return {
			verdict: "BLOCKED",
			reason: fixCandidates.some((c) => c.patch.trim())
				? "no candidate makes the reproduction pass without regressing the suite"
				: "no candidate produced a patch",
		};
	}
	return {
		verdict: "FIXED",
		patch: selection.chosen.patch,
		evidence: { reproBefore: "fail", reproAfter: "pass", suite: hasSuite ? "green" : "skipped" },
		reason: selection.reason,
	};
}

/** Parse a /debug argument string / structured input into a FailingState. */
export function parseFailingState(arg: string, structured?: Partial<FailingState>): FailingState {
	const a = arg.trim();
	const state: FailingState = { ...structured };
	// Heuristic: a bare test-runner invocation is a failing test; anything else
	// with a command shape is a repro command; free prose is `expected`.
	if (!state.failingTest && !state.reproCommand && a) {
		// Test-runner invocations → a failing test. Bare `node x.js` / `python x.py`
		// / `./x` are script runs → a repro command. Free prose → expected.
		if (
			/^(pytest|jest|vitest|mocha|go test|cargo test|npm (run )?test|npx (vitest|jest|mocha|playwright)|python -m pytest)\b/.test(
				a,
			)
		) {
			state.failingTest = a;
		} else if (/^(node|python|python3|\.\/|bash|sh|deno|bun|ruby|php)\b|[|&;><]/.test(a)) {
			state.reproCommand = a;
		} else {
			state.expected = state.expected || a;
		}
	}
	return state;
}
