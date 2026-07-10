/**
 * Pure core of the phi-code eval harness: task schema, scoring, aggregation and
 * report formatting. No I/O, no shell — everything here is unit-tested so the
 * numbers the runner reports are trustworthy. The runner (run.ts) does the
 * side-effects (temp dirs, spawning phi, running verifiers).
 */

export interface EvalTask {
	/** Stable id, used as the result key. */
	id: string;
	/** One-line description. */
	description: string;
	/** The prompt handed to the strategy under test. */
	prompt: string;
	/**
	 * Shell command run in the task's output directory after the strategy ran.
	 * Exit code 0 == the task's objective success criterion is met. Keep it
	 * deterministic (no network, no clock) so a pass means the code is correct.
	 */
	verify: string;
	/** Optional wall-clock budget for the strategy run, in seconds. */
	timeoutSec?: number;
}

export interface TaskRunResult {
	taskId: string;
	strategy: string;
	/** verifier exit code 0 */
	passed: boolean;
	/** strategy wall-clock in ms */
	durationMs: number;
	/** null when the strategy/tooling could not produce a result at all */
	error?: string;
}

export interface StrategySummary {
	strategy: string;
	total: number;
	passed: number;
	passRate: number;
	/** mean duration over runs that produced a result */
	meanDurationMs: number;
}

const TASK_REQUIRED = ["id", "description", "prompt", "verify"] as const;

/** Validate a parsed task object, throwing a precise error on the first problem. */
export function validateTask(raw: unknown, source = "task"): EvalTask {
	if (typeof raw !== "object" || raw === null) throw new Error(`${source}: expected an object`);
	const t = raw as Record<string, unknown>;
	for (const key of TASK_REQUIRED) {
		if (typeof t[key] !== "string" || (t[key] as string).length === 0) {
			throw new Error(`${source}: field "${key}" must be a non-empty string`);
		}
	}
	if (t.timeoutSec !== undefined && (typeof t.timeoutSec !== "number" || t.timeoutSec <= 0)) {
		throw new Error(`${source}: "timeoutSec" must be a positive number when set`);
	}
	return {
		id: t.id as string,
		description: t.description as string,
		prompt: t.prompt as string,
		verify: t.verify as string,
		timeoutSec: t.timeoutSec as number | undefined,
	};
}

/** Reject duplicate task ids up front (they would clobber each other in results). */
export function assertUniqueIds(tasks: EvalTask[]): void {
	const seen = new Set<string>();
	for (const t of tasks) {
		if (seen.has(t.id)) throw new Error(`duplicate task id: ${t.id}`);
		seen.add(t.id);
	}
}

/** Aggregate per-strategy pass rate and mean duration. */
export function summarize(results: TaskRunResult[]): StrategySummary[] {
	const byStrategy = new Map<string, TaskRunResult[]>();
	for (const r of results) {
		const list = byStrategy.get(r.strategy) ?? [];
		list.push(r);
		byStrategy.set(r.strategy, list);
	}
	const summaries: StrategySummary[] = [];
	for (const [strategy, list] of byStrategy) {
		const passed = list.filter((r) => r.passed).length;
		const timed = list.filter((r) => r.error === undefined);
		const meanDurationMs = timed.length ? Math.round(timed.reduce((s, r) => s + r.durationMs, 0) / timed.length) : 0;
		summaries.push({
			strategy,
			total: list.length,
			passed,
			passRate: list.length ? passed / list.length : 0,
			meanDurationMs,
		});
	}
	return summaries.sort((a, b) => b.passRate - a.passRate || a.meanDurationMs - b.meanDurationMs);
}

/** Format a markdown comparison report from raw results. */
export function formatReport(results: TaskRunResult[], summaries: StrategySummary[]): string {
	const lines: string[] = ["# phi-code eval report", ""];

	lines.push("## Summary", "");
	lines.push("| Strategy | Pass rate | Passed | Mean time |");
	lines.push("|----------|-----------|--------|-----------|");
	for (const s of summaries) {
		lines.push(
			`| ${s.strategy} | ${(s.passRate * 100).toFixed(0)}% | ${s.passed}/${s.total} | ${(s.meanDurationMs / 1000).toFixed(1)}s |`,
		);
	}
	lines.push("");

	lines.push("## Per-task", "");
	lines.push("| Task | Strategy | Result | Time |");
	lines.push("|------|----------|--------|------|");
	for (const r of results) {
		const result = r.error ? `error: ${r.error}` : r.passed ? "PASS" : "FAIL";
		lines.push(`| ${r.taskId} | ${r.strategy} | ${result} | ${(r.durationMs / 1000).toFixed(1)}s |`);
	}
	lines.push("");
	return lines.join("\n");
}
