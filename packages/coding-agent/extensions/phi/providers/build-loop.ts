/**
 * /build outer loop — the pure decision core that composes the two oracles
 * (docs/design/plan-debug-build.md): an acceptance RUN and an executable
 * red-team. It never runs anything itself; given this round's reports it decides
 * SUCCESS, CONTINUE (hand these real failures to /debug), or PARTIAL (budget
 * spent — report what still fails honestly, never a confident-wrong PASS).
 */

import type { AcceptanceReport, CriterionResult } from "./acceptance.ts";
import type { FailingState } from "./debug-contract.ts";
import { type BreakingCase, breakingCasesToFailingStates } from "./redteam.ts";

export type BuildStatus = "success" | "continue" | "partial";

export interface BuildDecision {
	status: BuildStatus;
	/** Real failures to route to /debug (continue) or to report (partial). */
	failures: FailingState[];
	/** Manual criteria that could not be executed — surfaced, never counted green. */
	unverified: string[];
	reason: string;
}

export interface BuildRoundInput {
	round: number;
	maxRounds: number;
	acceptance: AcceptanceReport;
	breakingCases: BreakingCase[];
	cwd?: string;
}

/** A failed acceptance criterion becomes a failing state /debug can reproduce. */
export function criterionToFailingState(r: CriterionResult, cwd?: string): FailingState {
	return {
		reproCommand: r.criterion.check,
		expected: r.criterion.description,
		trace: r.result ? `${r.result.command} exited ${r.result.exitCode}` : undefined,
		cwd,
	};
}

/**
 * Decide one round of the build loop. SUCCESS requires: at least one criterion
 * was actually checked, none failed, and the red-team found no break. Manual
 * criteria never count toward success — they are reported as `unverified`.
 */
export function decideBuildRound(input: BuildRoundInput): BuildDecision {
	const failedStates = input.acceptance.failed.map((r) => criterionToFailingState(r, input.cwd));
	const breakStates = breakingCasesToFailingStates(input.breakingCases, input.cwd);
	const failures = [...failedStates, ...breakStates];
	const unverified = input.acceptance.manual.map((r) => r.criterion.description);

	if (failures.length === 0) {
		if (!input.acceptance.allCheckablePassed) {
			// Nothing failed, but nothing was executably verified either.
			return {
				status: "partial",
				failures: [],
				unverified,
				reason: "no criterion could be executed — nothing verified; add checkable acceptance criteria",
			};
		}
		const note = unverified.length ? ` (${unverified.length} manual criteria still unverified)` : "";
		return {
			status: "success",
			failures: [],
			unverified,
			reason: `all checkable acceptance criteria passed and the red-team found no break${note}`,
		};
	}

	if (input.round >= input.maxRounds) {
		return {
			status: "partial",
			failures,
			unverified,
			reason: `budget exhausted after ${input.maxRounds} round(s); ${failures.length} failure(s) still open`,
		};
	}

	return {
		status: "continue",
		failures,
		unverified,
		reason: `${failures.length} real failure(s) this round → route to /debug (round ${input.round}/${input.maxRounds})`,
	};
}

export const DEFAULT_MAX_ROUNDS = 4;
