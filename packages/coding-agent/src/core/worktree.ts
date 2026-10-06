/**
 * Git worktree isolation for parallel sub-agents.
 *
 * Each parallel agent gets its own worktree under `.phi/worktrees/<id>` so its
 * writes never touch the main working tree. After the agent finishes, its diff
 * (against the base ref) is applied back onto the main working tree with
 * explicit conflict detection: when the main tree has moved on the same files
 * (typically because another agent was merged first), the merge returns a
 * conflict report containing BOTH diffs instead of silently overwriting.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

export const WORKTREE_ROOT = join(".phi", "worktrees");
/** Same root as git prints it (always forward slashes, also on Windows). */
const WORKTREE_ROOT_GIT_PREFIX = ".phi/worktrees/";
/** File in the worktree's private git dir recording the commit it was created from. */
const BASE_MARKER = "phi-base-ref";

export interface Worktree {
	id: string;
	path: string;
	baseRef: string;
}

export interface MergeConflictInfo {
	/** Files touched by both the incoming worktree diff and the current main tree. */
	files: string[];
	/** The diff produced by the worktree being merged (incoming changes). */
	incomingDiff: string;
	/** The diff of the main working tree against the same base (already-applied changes). */
	currentDiff: string;
}

export interface MergeResult {
	ok: boolean;
	/** The incoming diff, when applied successfully. */
	applied?: string;
	conflict?: MergeConflictInfo;
}

function git(cwd: string, args: string[], input?: string): string {
	return execFileSync("git", ["-C", cwd, ...args], {
		encoding: "utf-8",
		...(input !== undefined ? { input } : {}),
	}).toString();
}

function sanitizeId(id: string): string {
	const safe = id.replace(/[^\w.-]/g, "-");
	if (!safe) throw new Error("worktree id must contain at least one safe character");
	return safe;
}

export function worktreePath(repoRoot: string, id: string): string {
	return join(repoRoot, WORKTREE_ROOT, sanitizeId(id));
}

function worktreeGitDir(path: string): string {
	const gitDir = git(path, ["rev-parse", "--git-dir"]).trim();
	return isAbsolute(gitDir) ? gitDir : join(path, gitDir);
}

/** Commit the worktree was created from (falls back to HEAD for worktrees made before the marker). */
function worktreeBase(path: string): string {
	try {
		const recorded = readFileSync(join(worktreeGitDir(path), BASE_MARKER), "utf-8").trim();
		if (recorded) return recorded;
	} catch {
		// No marker: worktree created by an older version.
	}
	return git(path, ["rev-parse", "HEAD"]).trim();
}

/** Create a detached worktree for `id` under .phi/worktrees/, based on baseRef. */
export function createWorktree(repoRoot: string, id: string, baseRef = "HEAD"): Worktree {
	const safeId = sanitizeId(id);
	const path = join(repoRoot, WORKTREE_ROOT, safeId);
	mkdirSync(dirname(path), { recursive: true });
	const baseCommit = git(repoRoot, ["rev-parse", "--verify", `${baseRef}^{commit}`]).trim();
	git(repoRoot, ["worktree", "add", "--detach", path, baseCommit]);
	// Remember the base: if the sub-agent commits inside its worktree, HEAD moves and
	// diffing against HEAD would silently drop those commits from the merge.
	writeFileSync(join(worktreeGitDir(path), BASE_MARKER), baseCommit);
	return { id: safeId, path, baseRef: baseCommit };
}

function changedFiles(cwd: string, baseRef: string): string[] {
	const out = git(cwd, ["diff", "--name-only", baseRef]).trim();
	return out ? out.split("\n").filter(Boolean) : [];
}

function untrackedFiles(cwd: string): string[] {
	const out = git(cwd, ["ls-files", "--others", "--exclude-standard"]).trim();
	return out ? out.split("\n").filter(Boolean) : [];
}

/**
 * Merge a worktree's changes back onto the main working tree.
 *
 * Checks the worktree diff (tracked files, including commits made inside the
 * worktree) with `git apply --check` and every new untracked file BEFORE writing
 * anything, then applies them. A conflict therefore never leaves the main tree
 * half-merged: it returns an explicit report with both diffs. Never throws on
 * conflict; throws only on unexpected git failures.
 */
export function mergeWorktree(repoRoot: string, id: string): MergeResult {
	const path = worktreePath(repoRoot, id);
	if (!existsSync(path)) throw new Error(`worktree ${id} not found at ${path}`);
	const baseRef = worktreeBase(path);
	// base..working tree: commits made in the worktree plus uncommitted edits.
	const incomingDiff = git(path, ["diff", baseRef]);
	const incomingUntracked = untrackedFiles(path).filter((f) => !f.startsWith(WORKTREE_ROOT_GIT_PREFIX));

	if (!incomingDiff.trim() && incomingUntracked.length === 0) {
		return { ok: true, applied: "" };
	}

	if (incomingDiff.trim()) {
		try {
			git(repoRoot, ["apply", "--check", "--whitespace=nowarn"], incomingDiff);
		} catch {
			const incomingFiles = changedFiles(path, baseRef);
			const currentFiles = new Set(changedFiles(repoRoot, baseRef));
			const overlap = incomingFiles.filter((f) => currentFiles.has(f));
			return {
				ok: false,
				conflict: {
					files: overlap.length > 0 ? overlap : incomingFiles,
					incomingDiff,
					currentDiff: git(repoRoot, ["diff", baseRef]),
				},
			};
		}
	}

	// An existing file with different content is a conflict.
	const newFiles: Array<{ dest: string; content: Buffer }> = [];
	for (const rel of incomingUntracked) {
		const content = readFileSync(join(path, rel));
		const dest = join(repoRoot, rel);
		if (existsSync(dest)) {
			if (!readFileSync(dest).equals(content)) {
				return {
					ok: false,
					conflict: {
						files: [rel],
						incomingDiff: `new file in worktree ${id}: ${rel}\n${content.toString("utf-8")}`,
						currentDiff: `existing file in main tree: ${rel}\n${readFileSync(dest).toString("utf-8")}`,
					},
				};
			}
			continue;
		}
		newFiles.push({ dest, content });
	}

	if (incomingDiff.trim()) git(repoRoot, ["apply", "--whitespace=nowarn"], incomingDiff);
	for (const { dest, content } of newFiles) {
		mkdirSync(dirname(dest), { recursive: true });
		writeFileSync(dest, content);
	}

	return { ok: true, applied: incomingDiff };
}

/** Remove a worktree and its directory (forced: pending changes are discarded). */
export function removeWorktree(repoRoot: string, id: string): void {
	const path = worktreePath(repoRoot, id);
	if (!existsSync(path)) return;
	try {
		git(repoRoot, ["worktree", "remove", "--force", path]);
	} catch {
		rmSync(path, { recursive: true, force: true });
		try {
			git(repoRoot, ["worktree", "prune"]);
		} catch {
			/* best effort */
		}
	}
}
