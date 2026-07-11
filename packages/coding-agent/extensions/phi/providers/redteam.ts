/**
 * Executable red-team — the adversary's deliverable is a FAILING RUN, not an
 * opinion (docs/design/plan-debug-build.md). This is the pure decision core: it
 * turns the outcome of each adversarial attempt into a loop step, so a "breaking
 * case" is only ever recorded when a real test went RED. Prose can't lie its way
 * to a finding here — execution is the oracle.
 *
 * Why this exists: in the 3362 measurement an over-clever guard survived a
 * different model's careful written review because the reviewer shared the
 * misconception. It would NOT have survived the assertion being *run*. So the
 * adversary must attack the specific input regime the diff touched, and express
 * the attack as an executed test.
 */

import type { FailingState } from "./debug-contract.js";
import { type CommandResult, passed, tail } from "./execution.js";

/** One adversarial attempt: a runnable test aimed at a specific input regime. */
export interface RedTeamAttempt {
	/** Which boundary/regime it targets (e.g. "buffered vs streaming"). */
	regime: string;
	/** The runnable breaking test (a command). */
	test: string;
	/** The execution of that test (null = it could not be run). */
	result: CommandResult | null;
}

/** A confirmed break: an attempt whose test actually ran RED. */
export interface BreakingCase {
	regime: string;
	test: string;
	symptom: string;
}

export interface RedTeamState {
	/** Consecutive rounds that failed to break the code. */
	dry: number;
	attemptsUsed: number;
	breakingCases: BreakingCase[];
}

export interface RedTeamConfig {
	/** Stop after this many consecutive rounds that could not break the code. */
	dryRoundsToStop: number;
	/** Hard budget on attempts. */
	maxAttempts: number;
}

export const DEFAULT_REDTEAM_CONFIG: RedTeamConfig = { dryRoundsToStop: 2, maxAttempts: 8 };

export function initRedTeam(): RedTeamState {
	return { dry: 0, attemptsUsed: 0, breakingCases: [] };
}

/** Keep going only while under budget and not yet K dry rounds in a row. */
export function shouldContinueRedTeam(state: RedTeamState, config: RedTeamConfig): boolean {
	return state.attemptsUsed < config.maxAttempts && state.dry < config.dryRoundsToStop;
}

/**
 * Fold one attempt into the state. A RED run (test failed) is a breaking case
 * and resets the dry counter; a GREEN run (or one that could not be executed at
 * all) counts as a dry round — you cannot claim a break you did not run.
 */
export function recordAttempt(state: RedTeamState, attempt: RedTeamAttempt, config: RedTeamConfig): RedTeamState {
	const attemptsUsed = state.attemptsUsed + 1;
	const ran = attempt.result !== null;
	const broke = ran && !passed(attempt.result as CommandResult);

	if (broke) {
		const result = attempt.result as CommandResult;
		return {
			dry: 0,
			attemptsUsed,
			breakingCases: [
				...state.breakingCases,
				{ regime: attempt.regime, test: attempt.test, symptom: tail(result, 20) || `exit ${result.exitCode}` },
			],
		};
	}
	// Green, or unrunnable: this round produced no finding.
	void config;
	return { dry: state.dry + 1, attemptsUsed, breakingCases: state.breakingCases };
}

/** Turn confirmed breaks into failing states that /debug can consume directly. */
export function breakingCasesToFailingStates(cases: BreakingCase[], cwd?: string): FailingState[] {
	return cases.map((c) => ({
		reproCommand: c.test,
		trace: c.symptom,
		expected: `input regime "${c.regime}" must not break the change`,
		cwd,
	}));
}

const STREAMING_HINT = /\b(stream|iter|chunk|read|io|http|response|decode|encode|buffer|socket|pipe)\b/i;
const PARSE_HINT = /\b(parse|json|yaml|xml|deserialize|decode|token|lexer)\b/i;
const NUMERIC_HINT = /\b(sum|count|index|offset|length|size|range|price|amount|math|float|int)\b/i;
const AUTH_HINT = /\b(auth|login|token|session|password|permission|role|jwt)\b/i;

/**
 * Cheap enumeration of the input regimes worth attacking, given hints from the
 * change (file names + keywords). Always includes the universal boundaries;
 * adds domain-specific ones when the hints match. The adversary attacks these,
 * not the whole app.
 */
export function enumerateInputRegimes(hints: { changedFiles?: string[]; keywords?: string } = {}): string[] {
	const blob = `${(hints.changedFiles ?? []).join(" ")} ${hints.keywords ?? ""}`;
	const regimes = ["empty input", "null/undefined", "boundary value", "wrong type", "large input"];
	if (STREAMING_HINT.test(blob)) regimes.push("buffered vs streaming");
	if (PARSE_HINT.test(blob)) regimes.push("malformed/partial input", "non-ASCII / unicode");
	if (NUMERIC_HINT.test(blob)) regimes.push("zero / negative", "overflow / very large number");
	if (AUTH_HINT.test(blob)) regimes.push("missing credentials", "expired / tampered token");
	return regimes;
}
