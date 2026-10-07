import type { Task, TaskStatus } from "../tool/types.ts";

/**
 * Allowed forward transitions per source status. `completed` is one-way to
 * `deleted` (never back to `in_progress`); `deleted` is terminal.
 *
 * Idempotent same→same is checked separately in `isTransitionValid` so this
 * table only enumerates actual transitions.
 */
export const VALID_TRANSITIONS: Record<TaskStatus, ReadonlySet<TaskStatus>> = {
	pending: new Set(["in_progress", "completed", "deleted"]),
	in_progress: new Set(["pending", "completed", "deleted"]),
	completed: new Set(["deleted"]),
	deleted: new Set(),
};

export function isTransitionValid(from: TaskStatus, to: TaskStatus): boolean {
	if (from === to) return true;
	return VALID_TRANSITIONS[from].has(to);
}

// ---------------------------------------------------------------------------
// Cross-task invariants.
//
// The tool guideline "Exactly one task should be in_progress at a time" is a
// CROSS-TASK invariant: no per-task transition table can express it. Before
// this block existed nothing enforced it and nothing surfaced a violation — a
// session could run two tasks in_progress for minutes, or leave one open across
// turns, with `list` reporting it as normal.
// ---------------------------------------------------------------------------

/** Maximum number of simultaneously in_progress (non-deleted) tasks. */
export const MAX_IN_PROGRESS = 1;

/** An in_progress task older than this is surfaced as stale. */
export const STALE_IN_PROGRESS_MS = 10 * 60 * 1000;

export function countInProgress(tasks: readonly Task[]): number {
	let n = 0;
	for (const t of tasks) if (t.status === "in_progress") n += 1;
	return n;
}

/**
 * Non-deleted in_progress tasks other than `excludeId`, oldest first.
 * Unstamped tasks sort first (`""` < any ISO string) so a legacy task is the
 * one reported first; the caller demotes all of them regardless.
 */
export function findOtherInProgress(tasks: readonly Task[], excludeId: number): Task[] {
	return tasks
		.filter((t) => t.id !== excludeId && t.status === "in_progress")
		.sort((a, b) => (a.inProgressSince ?? "").localeCompare(b.inProgressSince ?? ""));
}

/** Milliseconds the task has been continuously in_progress; undefined when unstamped. */
export function inProgressAgeMs(task: Task, now: number = Date.now()): number | undefined {
	if (task.status !== "in_progress" || !task.inProgressSince) return undefined;
	const since = Date.parse(task.inProgressSince);
	return Number.isFinite(since) ? Math.max(0, now - since) : undefined;
}

/** Human-readable age ("4m", "1h12m") — shared by `list` and the overlay. */
export function formatAge(ms: number): string {
	const totalMinutes = Math.floor(ms / 60_000);
	if (totalMinutes < 1) return "<1m";
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	return hours > 0 ? `${hours}h${String(minutes).padStart(2, "0")}m` : `${totalMinutes}m`;
}

/**
 * In_progress tasks past `STALE_IN_PROGRESS_MS`. An UNSTAMPED in_progress task
 * counts as stale: its freshness cannot be proven, and it can only come from a
 * session written before this field existed.
 */
export function findStaleInProgress(tasks: readonly Task[], now: number = Date.now()): Task[] {
	return tasks.filter((t) => {
		if (t.status !== "in_progress") return false;
		const age = inProgressAgeMs(t, now);
		return age === undefined || age >= STALE_IN_PROGRESS_MS;
	});
}
