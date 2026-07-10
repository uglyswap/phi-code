/**
 * Minimality guard — pick the best of several candidate fixes.
 *
 * Lesson from the SWE-bench-lite head-to-head: /plan's extra deliberation made
 * it produce a MORE elaborate (and wrong) fix than a single shot on the missed
 * instance, while its diff was better-formed (it applied; the baseline's did
 * not). The winning move is to generate more than one candidate and keep the
 * SIMPLEST one that actually passes an executable acceptance repro — combining
 * /plan's well-formed diffs with single-shot's tendency to stay minimal.
 *
 * This module is the pure decision core (no I/O): the caller runs each
 * candidate against the same acceptance repro and reports `passedRepro`; this
 * picks the winner. "Simplest" = fewest changed source lines in the unified
 * diff (a robust, language-agnostic proxy for over-engineering).
 */

export interface FixCandidate {
	/** Where it came from, for diagnostics: "single-shot", "plan", "plan-fix", ... */
	source: string;
	/** Unified diff. */
	patch: string;
	/**
	 * Did this candidate pass the model's own falsify-first acceptance repro
	 * (the repro that FAILS on the pre-fix code and must PASS after)? Undefined
	 * when no repro was available to gate on.
	 */
	passedRepro?: boolean;
}

export interface CandidateSelection {
	chosen: FixCandidate | null;
	/** Human-readable rationale (surfaced to the user and asserted in tests). */
	reason: string;
	/** Changed-source-line count of the chosen patch (0 when none). */
	chosenSize: number;
}

/**
 * Count changed source lines in a unified diff: added/removed lines, excluding
 * diff/hunk headers (---, +++, @@, diff --git, index) so the number reflects
 * real edits, not file boilerplate.
 */
export function diffChangedLines(patch: string): number {
	if (!patch) return 0;
	let n = 0;
	for (const line of patch.split("\n")) {
		if (line.startsWith("+++") || line.startsWith("---")) continue;
		if ((line.startsWith("+") || line.startsWith("-")) && line.length > 0) n++;
	}
	return n;
}

const hasPatch = (c: FixCandidate) => c.patch.trim().length > 0;

/**
 * Select the best candidate:
 *  1. Among candidates that PASSED the acceptance repro, pick the smallest diff
 *     (ties → the earliest in the list, so callers can order by preference).
 *  2. If none is known to pass but some were never gated (passedRepro undefined),
 *     pick the smallest non-empty patch among those (best effort).
 *  3. If a repro existed and every candidate FAILED it, choose nothing — the
 *     honest outcome is "no candidate is verified", not "ship the least-bad".
 *  4. No non-empty patches → nothing.
 */
export function selectMinimalPassingCandidate(candidates: FixCandidate[]): CandidateSelection {
	const nonEmpty = candidates.filter(hasPatch);
	if (nonEmpty.length === 0) {
		return { chosen: null, reason: "no candidate produced a non-empty patch", chosenSize: 0 };
	}

	const passed = nonEmpty.filter((c) => c.passedRepro === true);
	if (passed.length > 0) {
		const chosen = smallest(passed);
		const others = passed.filter((c) => c !== chosen);
		const note = others.length
			? ` (over ${others.map((c) => `${c.source}:${diffChangedLines(c.patch)}`).join(", ")})`
			: "";
		return {
			chosen,
			reason: `smallest patch that passes the acceptance repro: ${chosen.source} (${diffChangedLines(chosen.patch)} changed lines)${note}`,
			chosenSize: diffChangedLines(chosen.patch),
		};
	}

	const anyGated = nonEmpty.some((c) => c.passedRepro === true || c.passedRepro === false);
	if (anyGated) {
		// A repro existed and nothing passed it — do not pretend a candidate is verified.
		return { chosen: null, reason: "an acceptance repro existed but no candidate passed it", chosenSize: 0 };
	}

	// No repro to gate on: fall back to the smallest non-empty patch (best effort).
	const chosen = smallest(nonEmpty);
	return {
		chosen,
		reason: `no acceptance repro to gate on; smallest non-empty patch: ${chosen.source} (${diffChangedLines(chosen.patch)} changed lines)`,
		chosenSize: diffChangedLines(chosen.patch),
	};
}

/** Smallest by changed-line count; ties keep list order (stable). */
function smallest(cs: FixCandidate[]): FixCandidate {
	let best = cs[0];
	let bestSize = diffChangedLines(best.patch);
	for (let i = 1; i < cs.length; i++) {
		const s = diffChangedLines(cs[i].patch);
		if (s < bestSize) {
			best = cs[i];
			bestSize = s;
		}
	}
	return best;
}
