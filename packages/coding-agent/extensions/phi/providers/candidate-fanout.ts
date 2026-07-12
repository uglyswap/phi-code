/**
 * Parallel candidate generation in git WORKTREES (experimental).
 *
 * Sequential multi-candidate is safe (one tree, reset between attempts) but
 * pays N× wall-clock. Worktrees give each candidate an isolated copy of the
 * repo at HEAD, so N fixes run truly in parallel; the diffs come back to the
 * main tree where the existing deterministic arbitration (real runs) picks the
 * winner. Sub-candidates are separate phi processes (same pattern as
 * explore-fanout), so a crash in one never corrupts another.
 */

import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "./execution.js";
import { getPiInvocation, isRateLimited } from "./explore-fanout.js";

export interface CandidateSpec {
	/** Model ref for this candidate (e.g. "alibaba-codingplan/qwen3.7-plus"). */
	model: string;
	/** The FIX instruction (already includes the candidate protocol note). */
	instruction: string;
}

export interface CandidateOutcome {
	source: string;
	patch: string;
	ok: boolean;
	error?: string;
}

const CANDIDATE_TOOLS = ["read", "grep", "glob", "ls", "find", "edit", "write", "bash", "sandbox_run"];
const HARD_CONCURRENCY = 2;
const DEFAULT_TIMEOUT_MS = 12 * 60 * 1000;

function git(cwd: string, args: string): { ok: boolean; out: string } {
	const r = runCommand(`git ${args}`, { cwd, timeoutMs: 120_000 });
	return { ok: r.exitCode === 0 && !r.timedOut, out: r.stdout };
}

export interface Worktree {
	path: string;
	remove(): void;
}

/**
 * Create a detached worktree of HEAD in a temp dir, with the main tree's
 * .phi/sandbox.json copied in (the sub-candidate must target the SAME
 * guaranteed environment). Throws on failure — callers fall back to the
 * sequential pipeline.
 */
export function createCandidateWorktree(mainCwd: string, index: number): Worktree {
	const base = mkdtempSync(join(tmpdir(), `phi-cand-${index}-`));
	const wt = join(base, "wt");
	const add = git(mainCwd, `worktree add --detach "${wt}" HEAD`);
	if (!add.ok) {
		rmSync(base, { recursive: true, force: true });
		throw new Error(`git worktree add failed for candidate ${index}`);
	}
	const sandboxCfg = join(mainCwd, ".phi", "sandbox.json");
	if (existsSync(sandboxCfg)) {
		mkdirSync(join(wt, ".phi"), { recursive: true });
		copyFileSync(sandboxCfg, join(wt, ".phi", "sandbox.json"));
	}
	return {
		path: wt,
		remove() {
			git(mainCwd, `worktree remove --force "${wt}"`);
			rmSync(base, { recursive: true, force: true });
			// prune bookkeeping for safety (best effort)
			git(mainCwd, "worktree prune");
		},
	};
}

/** Diff of a worktree against its HEAD — the candidate's patch. */
export function worktreePatch(wtPath: string): string {
	const d = git(wtPath, "diff");
	return d.ok && d.out.trim() ? `${d.out.trim()}\n` : "";
}

/** Run one candidate as a phi sub-process inside its worktree. Never throws. */
export function runOneCandidate(
	wtPath: string,
	spec: CandidateSpec,
	timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<CandidateOutcome> {
	return new Promise((resolve) => {
		const args = [
			"--mode",
			"json",
			"-p",
			"--no-session",
			"--model",
			spec.model,
			"--tools",
			CANDIDATE_TOOLS.join(","),
		];
		args.push(`Task: ${spec.instruction}`);
		let proc: ReturnType<typeof spawn>;
		try {
			const inv = getPiInvocation(args);
			proc = spawn(inv.command, inv.args, { cwd: wtPath, shell: false, stdio: ["ignore", "pipe", "pipe"] });
		} catch (e) {
			resolve({ source: spec.model, patch: "", ok: false, error: String(e) });
			return;
		}
		let blob = "";
		const timer = setTimeout(() => {
			try {
				proc.kill();
			} catch {
				/* best effort */
			}
		}, timeoutMs);
		proc.stdout?.on("data", (d) => {
			blob += d.toString();
		});
		proc.stderr?.on("data", (d) => {
			blob += d.toString();
		});
		const finish = () => {
			clearTimeout(timer);
			const patch = worktreePatch(wtPath);
			resolve({
				source: spec.model,
				patch,
				ok: patch.length > 0,
				error: patch ? undefined : isRateLimited(blob) ? "rate-limited" : "no changes produced",
			});
		};
		proc.on("close", finish);
		proc.on("error", () => finish());
	});
}

export interface FanoutRun {
	outcomes: CandidateOutcome[];
	failures: string[];
}

/**
 * Run N candidates in parallel worktrees (concurrency-capped), ALWAYS cleaning
 * the worktrees up. Returns every outcome; the caller feeds non-empty patches
 * to the deterministic arbitration in the MAIN tree.
 */
export async function runCandidateFanout(
	mainCwd: string,
	specs: CandidateSpec[],
	timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<FanoutRun> {
	const outcomes: CandidateOutcome[] = [];
	const failures: string[] = [];
	for (let batch = 0; batch < specs.length; batch += HARD_CONCURRENCY) {
		const slice = specs.slice(batch, batch + HARD_CONCURRENCY);
		const settled = await Promise.all(
			slice.map(async (spec, j) => {
				let wt: Worktree | null = null;
				try {
					wt = createCandidateWorktree(mainCwd, batch + j);
					return await runOneCandidate(wt.path, spec, timeoutMs);
				} catch (e) {
					return { source: spec.model, patch: "", ok: false, error: String(e) } as CandidateOutcome;
				} finally {
					try {
						wt?.remove();
					} catch {
						/* best effort */
					}
				}
			}),
		);
		for (const o of settled) {
			outcomes.push(o);
			if (!o.ok) failures.push(`${o.source}: ${o.error ?? "failed"}`);
		}
	}
	return { outcomes, failures };
}
