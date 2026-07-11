/**
 * Acceptance criteria and run recipe — the executable contract for /plan and
 * /build. Criteria are derived from the SPEC (not the code), and each carries an
 * optional `check` command so "is it satisfied?" is answered by running
 * something, not by a model's opinion (see docs/design/plan-debug-build.md).
 */

import { type CommandResult, passed, type RunOptions, runCommand, summarize } from "./execution.js";

/** How to build/run/test the project. Emitted by /plan, consumed by /build. */
export interface RunRecipe {
	build?: string;
	run?: string;
	test?: string;
	/** A substring that, once seen in run output, means the app is ready. */
	readySignal?: string;
}

export interface AcceptanceCriterion {
	/** Human statement traced to the spec, e.g. "POST /login returns 200 + a JWT". */
	description: string;
	/**
	 * Optional command that exits 0 iff the criterion holds. When absent the
	 * criterion is "manual" — it can only be judged by a human/agent, never
	 * auto-marked satisfied (that is the anti-circularity rule).
	 */
	check?: string;
}

export interface CriterionResult {
	criterion: AcceptanceCriterion;
	/** true = ran and passed; false = ran and failed; null = manual (no check). */
	satisfied: boolean | null;
	result?: CommandResult;
}

export interface AcceptanceReport {
	results: CriterionResult[];
	/** Criteria with a check that failed — the concrete work for /debug. */
	failed: CriterionResult[];
	/** Criteria with no check — cannot be auto-verified, surfaced honestly. */
	manual: CriterionResult[];
	/** All checkable criteria passed (manual ones are NOT counted as passing). */
	allCheckablePassed: boolean;
}

/**
 * Run every criterion's check command and classify. A criterion with no check
 * is reported as `manual` (satisfied: null) — never silently counted as passed.
 */
export function checkAcceptance(criteria: AcceptanceCriterion[], options: RunOptions = {}): AcceptanceReport {
	const results: CriterionResult[] = criteria.map((criterion) => {
		if (!criterion.check || !criterion.check.trim()) {
			return { criterion, satisfied: null };
		}
		const result = runCommand(criterion.check, options);
		return { criterion, satisfied: passed(result), result };
	});

	const failed = results.filter((r) => r.satisfied === false);
	const manual = results.filter((r) => r.satisfied === null);
	const checkable = results.filter((r) => r.satisfied !== null);
	return {
		results,
		failed,
		manual,
		allCheckablePassed: checkable.length > 0 && failed.length === 0,
	};
}

/** Markdown summary of an acceptance run for a report / handoff. */
export function formatAcceptance(report: AcceptanceReport): string {
	const line = (r: CriterionResult) => {
		const mark = r.satisfied === true ? "✅" : r.satisfied === false ? "❌" : "❔";
		const detail = r.result ? ` — ${summarize(r.result)}` : r.satisfied === null ? " — (no check, manual)" : "";
		return `- ${mark} ${r.criterion.description}${detail}`;
	};
	return report.results.map(line).join("\n");
}

/**
 * Validate a parsed RunRecipe/criteria object (e.g. from a phase_result), so a
 * malformed emission is caught at the boundary.
 */
export function validateCriteria(raw: unknown): AcceptanceCriterion[] {
	if (!Array.isArray(raw)) return [];
	const out: AcceptanceCriterion[] = [];
	for (const item of raw) {
		if (typeof item === "string" && item.trim()) {
			out.push({ description: item.trim() });
		} else if (item && typeof item === "object") {
			const o = item as Record<string, unknown>;
			if (typeof o.description === "string" && o.description.trim()) {
				out.push({
					description: o.description.trim(),
					check: typeof o.check === "string" && o.check.trim() ? o.check.trim() : undefined,
				});
			}
		}
	}
	return out;
}
