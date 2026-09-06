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
import { dirname, join } from "node:path";

export const WORKTREE_ROOT = join(".phi", "worktrees");

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

/** Create a detached worktree for `id` under .phi/worktrees/, based on baseRef. */
export function createWorktree(repoRoot: string, id: string, baseRef = "HEAD"): Worktree {
	const safeId = sanitizeId(id);
	const path = join(repoRoot, WORKTREE_ROOT, safeId);
	mkdirSync(dirname(path), { recursive: true });
	git(repoRoot, ["worktree", "add", "--detach", path, baseRef]);
	return { id: safeId, path, baseRef };
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
 * Applies the worktree diff (tracked files) with `git apply`, then copies new
 * untracked files. If the apply fails because the main tree already has
 * conflicting changes on the same files, returns an explicit conflict report
 * with both diffs; nothing is overwritten silently. Never throws on conflict;
 * throws only on unexpected git failures.
 */
export function mergeWorktree(repoRoot: string, id: string): MergeResult {
	const path = worktreePath(repoRoot, id);
	if (!existsSync(path)) throw new Error(`worktree ${id} not found at ${path}`);
	const baseRef = git(path, ["rev-parse", "HEAD"]).trim();
	const incomingDiff = git(path, ["diff", baseRef]);
	const incomingUntracked = untrackedFiles(path).filter((f) => !f.startsWith(`${WORKTREE_ROOT}/`));

	if (!incomingDiff.trim() && incomingUntracked.length === 0) {
		return { ok: true, applied: "" };
	}

	if (incomingDiff.trim()) {
		try {
			git(repoRoot, ["apply", "--whitespace=nowarn"], incomingDiff);
		} catch {
			const overlap = changedFiles(path, baseRef).filter((f) => changedFiles(repoRoot, baseRef).includes(f));
			return {
				ok: false,
				conflict: {
					files: overlap.length > 0 ? overlap : changedFiles(path, baseRef),
					incomingDiff,
					currentDiff: git(repoRoot, ["diff", baseRef]),
				},
			};
		}
	}

	// Copy new files; an existing file with different content is a conflict.
	for (const rel of incomingUntracked) {
		const src = join(path, rel);
		const dest = join(repoRoot, rel);
		const content = readFileSync(src);
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
