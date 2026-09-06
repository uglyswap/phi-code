/**
 * Bounded parallel sub-agent executor with worktree isolation.
 *
 * Each task runs inside its own git worktree (via worktree.ts) so concurrent
 * writes never collide; after the task completes its diff is merged back onto
 * the main tree, and conflicting merges surface an explicit conflict report
 * (both diffs) in the structured result instead of overwriting silently.
 *
 * Spawn policy: depth = 1. Tasks run at depth 0; a sub-agent (depth >= 1)
 * cannot fan out again — runParallel throws if called at depth >= 1.
 *
 * Also hosts the live agent registry (registerAgent/finishAgent/killAgent/
 * listAgents) consumed by the /agents command.
 */

import { createWorktree, type MergeConflictInfo, mergeWorktree, removeWorktree } from "./worktree.ts";

export const DEFAULT_MAX_CONCURRENCY = 3;
export const MAX_SPAWN_DEPTH = 1;

export type Verdict = "success" | "failure" | "conflict" | "killed" | "error";

export interface TaskContext {
	/** Working directory for the task: its isolated worktree path (or repoRoot when useWorktrees=false). */
	cwd: string;
	/** Spawn depth of this task. Tasks at depth >= MAX_SPAWN_DEPTH must not fan out. */
	depth: number;
	signal: AbortSignal;
}

export interface ParallelTask {
	id: string;
	/** Injected task body (no LLM coupling): returns its output text. */
	run: (ctx: TaskContext) => Promise<string> | string;
}

export interface AgentResult {
	id: string;
	verdict: Verdict;
	output: string;
	conflicts?: MergeConflictInfo;
}

export interface RunParallelOptions {
	/** Repo root for worktree isolation. Required unless useWorktrees=false. */
	repoRoot?: string;
	maxConcurrency?: number;
	/** Current spawn depth; >= MAX_SPAWN_DEPTH refuses to run. */
	depth?: number;
	/** Set false for read-only tasks that need no isolation. */
	useWorktrees?: boolean;
}

// ─── Live agent registry (consumed by /agents) ───────────────────

export interface AgentInfo {
	id: string;
	status: "running" | "finished" | "killed" | "error";
	startedAt: number;
	finishedAt?: number;
	verdict?: Verdict;
	output?: string;
}

const registry = new Map<string, AgentInfo & { controller: AbortController }>();

export function registerAgent(id: string): void {
	registry.set(id, { id, status: "running", startedAt: Date.now(), controller: new AbortController() });
}

export function finishAgent(id: string, verdict: Verdict, output?: string): void {
	const entry = registry.get(id);
	if (!entry) return;
	entry.status = verdict === "killed" ? "killed" : verdict === "error" ? "error" : "finished";
	entry.verdict = verdict;
	entry.output = output;
	entry.finishedAt = Date.now();
}

/** Abort a running agent. Returns false if unknown or already finished. */
export function killAgent(id: string): boolean {
	const entry = registry.get(id);
	if (!entry || entry.status !== "running") return false;
	entry.controller.abort();
	entry.status = "killed";
	entry.finishedAt = Date.now();
	return true;
}

/** Live snapshot of all known agents (running first, then most recent). */
export function listAgents(): AgentInfo[] {
	return [...registry.values()]
		.map(({ controller: _c, ...info }) => info)
		.sort((a, b) => {
			if ((a.status === "running") !== (b.status === "running")) return a.status === "running" ? -1 : 1;
			return b.startedAt - a.startedAt;
		});
}

/** Drop finished/killed entries from the registry. */
export function clearFinishedAgents(): void {
	for (const [id, entry] of registry) {
		if (entry.status !== "running") registry.delete(id);
	}
}

/**
 * Build the explicit conflict report appended to an agent's output when its
 * merge fails: lists the conflicting files and BOTH diffs (incoming vs current
 * main tree) so the director can decide. Nothing is overwritten silently.
 */
export function formatConflictReport(conflict: MergeConflictInfo): string {
	return [
		"## MERGE CONFLICT",
		`Files: ${conflict.files.join(", ")}`,
		"",
		"### Incoming diff (this agent)",
		conflict.incomingDiff || "(empty)",
		"",
		"### Current diff (main tree)",
		conflict.currentDiff || "(empty)",
	].join("\n");
}

function agentSignal(id: string): AbortSignal {
	const entry = registry.get(id);
	return entry ? entry.controller.signal : new AbortController().signal;
}

// ─── Executor ────────────────────────────────────────────────────

async function runOne(
	task: ParallelTask,
	opts: Required<Pick<RunParallelOptions, "depth" | "useWorktrees">> & RunParallelOptions,
): Promise<AgentResult> {
	registerAgent(task.id);
	let output = "";
	let verdict: Verdict = "error";
	let conflicts: MergeConflictInfo | undefined;
	let wtPath: string | undefined;
	try {
		if (opts.useWorktrees) {
			if (!opts.repoRoot) throw new Error("repoRoot is required when useWorktrees=true");
			wtPath = createWorktree(opts.repoRoot, task.id).path;
		}
		const cwd = wtPath ?? opts.repoRoot ?? process.cwd();
		const signal = agentSignal(task.id);
		output = await task.run({ cwd, depth: opts.depth, signal });
		if (signal.aborted) {
			verdict = "killed";
		} else if (wtPath && opts.repoRoot) {
			const merge = mergeWorktree(opts.repoRoot, task.id);
			if (merge.ok) {
				verdict = "success";
			} else {
				verdict = "conflict";
				conflicts = merge.conflict;
				if (conflicts) output += `\n\n${formatConflictReport(conflicts)}`;
			}
		} else {
			verdict = "success";
		}
	} catch (e) {
		verdict = agentSignal(task.id).aborted ? "killed" : "error";
		output = output || String(e);
	} finally {
		if (wtPath && opts.repoRoot) {
			try {
				removeWorktree(opts.repoRoot, task.id);
			} catch {
				/* best effort cleanup */
			}
		}
		finishAgent(task.id, verdict, output);
	}
	const result: AgentResult = { id: task.id, verdict, output };
	if (conflicts) result.conflicts = conflicts;
	return result;
}

/**
 * Run tasks with bounded concurrency, each in an isolated worktree.
 * Never throws for individual task failures; throws synchronously when the
 * spawn-depth policy is violated.
 */
export async function runParallel(tasks: ParallelTask[], opts: RunParallelOptions = {}): Promise<AgentResult[]> {
	const depth = opts.depth ?? 0;
	if (depth >= MAX_SPAWN_DEPTH) {
		throw new Error(`spawn depth limit reached (${MAX_SPAWN_DEPTH}): sub-agents cannot spawn sub-agents`);
	}
	const maxConcurrency = Math.max(1, opts.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY);
	const useWorktrees = opts.useWorktrees ?? true;
	const results: AgentResult[] = new Array(tasks.length);
	let next = 0;
	const worker = async () => {
		while (next < tasks.length) {
			const i = next++;
			results[i] = await runOne(tasks[i], { ...opts, depth, useWorktrees });
		}
	};
	await Promise.all(Array.from({ length: Math.min(maxConcurrency, tasks.length) }, worker));
	return results;
}
