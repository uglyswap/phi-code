/**
 * Escalation core — the pure decisions behind /fix (single-shot first, oracle
 * next, escalate to /debug only on red).
 *
 * Measured rationale (n=13, official SWE-bench harness): the single-shot
 * baseline resolved 7/13 while the full /debug pipeline resolved 6/13 at ~2.5×
 * the time — and on 11/13 instances both arms converged to the same verdict.
 * So the right architecture is neither: pay the single-shot price always, pay
 * the pipeline price only when a REAL run says the single shot failed. By
 * construction /fix is never worse than the baseline, and inherits /debug's
 * upside exactly where it can matter.
 */

import type { FailingState } from "./debug-contract.js";
import { type CommandResult, passed, tail } from "./execution.js";

export type EscalationDecision =
	| { action: "done-green"; evidence: string }
	| { action: "escalate"; failing: FailingState; diagnostic: string }
	| { action: "done-unverified"; reason: string };

export interface OracleRuns {
	/** The reproduction run (null = no runnable reproduction was available). */
	repro: CommandResult | null;
	/** The project suite run (null = no suite command known). */
	suite: CommandResult | null;
}

/**
 * Decide after the single shot: green oracle → done at baseline cost; any red
 * run → escalate to /debug with the red run as the concrete failing state
 * (never a paraphrase — the exact command and its tail). Nothing runnable →
 * done, honestly labelled unverified.
 */
export function decideEscalation(state: FailingState, runs: OracleRuns): EscalationDecision {
	const { repro, suite } = runs;

	if (repro !== null && !passed(repro)) {
		return {
			action: "escalate",
			failing: {
				...state,
				reproCommand: state.failingTest?.trim() || state.reproCommand?.trim() || repro.command,
				trace: tail(repro, 30),
			},
			diagnostic: `reproduction still red after the single shot: \`${repro.command}\` → exit ${repro.exitCode ?? "?"}${repro.timedOut ? " (TIMEOUT)" : ""}`,
		};
	}

	if (suite !== null && !passed(suite)) {
		return {
			action: "escalate",
			failing: {
				...state,
				failingTest: suite.command,
				trace: tail(suite, 30),
			},
			diagnostic: `the suite is red after the single shot: \`${suite.command}\` → exit ${suite.exitCode ?? "?"}${suite.timedOut ? " (TIMEOUT)" : ""}`,
		};
	}

	if (repro === null && suite === null) {
		return {
			action: "done-unverified",
			reason: "no runnable reproduction and no known suite command — the single shot could not be oracle-checked",
		};
	}

	const parts: string[] = [];
	if (repro) parts.push(`repro \`${repro.command}\` → exit 0`);
	if (suite) parts.push(`suite \`${suite.command}\` → exit 0`);
	return { action: "done-green", evidence: parts.join("; ") };
}

/**
 * Parse the `REPRO-CMD: <command>` line the REPRODUCE phase is instructed to
 * put in its handoff, so the driver can re-run the exact reproduction
 * deterministically (multi-candidate arbitration, /fix oracle). Returns
 * undefined when absent/malformed — callers must degrade gracefully.
 */
export function parseReproCmd(handoff: string | null | undefined): string | undefined {
	if (!handoff) return undefined;
	const m = handoff.match(/^\s*REPRO-CMD:\s*(.+)\s*$/im);
	const cmd = m?.[1]?.trim();
	return cmd && cmd.length > 1 ? cmd : undefined;
}

/**
 * Tiered shot budget (drift guard, measured on sympy/sphinx): a hard instance
 * must fail FAST at the shot so the escalation inherits real budget; an easy
 * one deserves a longer single attempt since escalation is unlikely.
 */
export function shotBudgetMs(triageRoute: "single-shot" | "debug" | "build" | "plan"): number {
	switch (triageRoute) {
		case "single-shot":
			return 12 * 60 * 1000; // likely to finish here — give it room
		case "debug":
			return 8 * 60 * 1000;
		default:
			return 6 * 60 * 1000; // build-scale/hard: fail fast, escalate with budget left
	}
}

/** Minimal shape of routing.json this module needs (kept structural). */
export interface RoutingLike {
	routes?: Record<string, { preferredModel?: string; fallback?: string } | undefined>;
	default?: { model?: string };
}

/**
 * Pick up to `n` DISTINCT model refs for candidate generation, favouring family
 * diversity: the coder first (it knows the task), then reviewer/test/explore
 * families, then fallbacks. Diversity proposes — the oracle disposes.
 */
export function pickCandidateModels(routing: RoutingLike, n: number): string[] {
	const routes = routing.routes ?? {};
	const ordered = [
		routes.code?.preferredModel,
		routes.review?.preferredModel,
		routes.test?.preferredModel,
		routes.explore?.preferredModel,
		routes.code?.fallback,
		routes.review?.fallback,
		routes.test?.fallback,
		routing.default?.model,
	];
	const out: string[] = [];
	for (const ref of ordered) {
		if (typeof ref === "string" && ref.trim() && !out.includes(ref)) out.push(ref);
		if (out.length >= n) break;
	}
	return out.slice(0, Math.max(1, n));
}
