/**
 * Triage / adaptive depth — pick the CHEAPEST mode consistent with the signals.
 *
 * The measured lesson (docs/design/plan-debug-build.md): the 6–14× overhead of
 * the full pipeline is only worth paying when a single shot fails the real
 * oracle. So this classifier defaults to the least machinery and escalates only
 * on concrete signals — a supplied failing state routes to /debug, a large or
 * under-specified build routes to /build, everything else is a single shot.
 */

export type Route = "debug" | "single-shot" | "build" | "plan";

export interface TriageSignals {
	/** A concrete failing test / trace / repro command was supplied. */
	hasFailingState?: boolean;
	/** Rough number of files the task will touch (undefined = estimate from text). */
	estimatedFiles?: number;
	/** The task text, for cheap keyword signals. */
	text?: string;
	/** Caller forces a specific mode (an explicit /debug, /build, /plan). */
	forced?: Route;
	/** Caller wants only a plan artifact, not the execution loop. */
	planOnly?: boolean;
}

export interface TriageDecision {
	route: Route;
	/** "minimal" = do the least; "full" = the multi-phase pipeline is justified. */
	depth: "minimal" | "full";
	reason: string;
}

const BUILD_KEYWORDS =
	/\b(build|scaffold|application|app|feature|end[- ]?to[- ]?end|full[- ]?stack|from scratch|new (project|service|module|api|endpoint|component|page)|several files|multiple files)\b/i;

/** At/above this many touched files, a single shot is unlikely to stay coherent. */
export const MULTI_FILE_THRESHOLD = 3;

/**
 * Cheap file-count estimate from a request: count distinct path-like tokens.
 * Deliberately conservative — defaults to 1 when nothing looks like a path.
 */
export function estimateFiles(text: string): number {
	if (!text.trim()) return 1;
	const paths = new Set<string>();
	for (const m of text.matchAll(/\b[\w./-]+\.[a-z]{1,6}\b/gi)) {
		paths.add(m[0].toLowerCase());
	}
	return Math.max(1, paths.size);
}

/**
 * Map signals to a route + depth. Pure and deterministic: same signals in, same
 * decision out. Order matters — a forced mode wins, then a real failing state
 * (cheapest useful oracle), then build-scale, else single shot.
 */
export function triage(signals: TriageSignals): TriageDecision {
	if (signals.forced) {
		return {
			route: signals.forced,
			depth: signals.forced === "single-shot" ? "minimal" : "full",
			reason: `explicit /${signals.forced}`,
		};
	}

	if (signals.hasFailingState) {
		return {
			route: "debug",
			depth: "minimal",
			reason: "a reproducible failing state was supplied — fix it directly, skip planning",
		};
	}

	const text = signals.text ?? "";
	const files = signals.estimatedFiles ?? estimateFiles(text);
	const buildy = BUILD_KEYWORDS.test(text);
	const large = files >= MULTI_FILE_THRESHOLD;

	if (buildy || large) {
		const why = large ? `~${files} files touched (≥ ${MULTI_FILE_THRESHOLD})` : "build-scale request";
		if (signals.planOnly) {
			return {
				route: "plan",
				depth: "full",
				reason: `${why}; plan-only requested — decompose without the run loop`,
			};
		}
		return { route: "build", depth: "full", reason: `${why} — decompose and run the build→verify→debug loop` };
	}

	return {
		route: "single-shot",
		depth: "minimal",
		reason: "small, self-contained — try one shot and verify before escalating",
	};
}
