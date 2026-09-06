import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorktree, mergeWorktree, removeWorktree, worktreePath } from "../src/core/worktree.ts";

function git(cwd: string, args: string[]): string {
	return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8" }).toString();
}

describe("worktree", () => {
	let repo: string;

	beforeEach(() => {
		repo = mkdtempSync(join(tmpdir(), "phi-worktree-test-"));
		git(repo, ["init"]);
		git(repo, ["config", "user.email", "test@example.com"]);
		git(repo, ["config", "user.name", "Test"]);
		writeFileSync(join(repo, "a.txt"), "alpha\n");
		writeFileSync(join(repo, "b.txt"), "beta\n");
		git(repo, ["add", "."]);
		git(repo, ["commit", "-m", "init"]);
	});

	afterEach(() => {
		rmSync(repo, { recursive: true, force: true });
	});

	it("creates a worktree under .phi/worktrees with the base content", () => {
		const wt = createWorktree(repo, "agent-1");
		expect(wt.path).toBe(worktreePath(repo, "agent-1"));
		expect(readFileSync(join(wt.path, "a.txt"), "utf-8")).toBe("alpha\n");
		expect(git(repo, ["worktree", "list"])).toContain(wt.path);
	});

	it("sanitizes unsafe ids", () => {
		const wt = createWorktree(repo, "agent/one:evil");
		expect(wt.id).toBe("agent-one-evil");
		removeWorktree(repo, wt.id);
	});

	it("merges a worktree's changes back onto the main tree", () => {
		const wt = createWorktree(repo, "writer");
		writeFileSync(join(wt.path, "a.txt"), "alpha changed\n");
		const result = mergeWorktree(repo, "writer");
		expect(result.ok).toBe(true);
		expect(result.applied).toContain("alpha changed");
		expect(readFileSync(join(repo, "a.txt"), "utf-8")).toBe("alpha changed\n");
	});

	it("merges new (untracked) files created in the worktree", () => {
		const wt = createWorktree(repo, "creator");
		mkdirSync(join(wt.path, "sub"));
		writeFileSync(join(wt.path, "sub", "new.txt"), "fresh\n");
		const result = mergeWorktree(repo, "creator");
		expect(result.ok).toBe(true);
		expect(readFileSync(join(repo, "sub", "new.txt"), "utf-8")).toBe("fresh\n");
	});

	it("merges cleanly when the two sides touch different files", () => {
		const wt = createWorktree(repo, "a-writer");
		writeFileSync(join(wt.path, "a.txt"), "alpha changed\n");
		// Main tree moves on a different file
		writeFileSync(join(repo, "b.txt"), "beta changed\n");
		const result = mergeWorktree(repo, "a-writer");
		expect(result.ok).toBe(true);
		expect(readFileSync(join(repo, "a.txt"), "utf-8")).toBe("alpha changed\n");
		expect(readFileSync(join(repo, "b.txt"), "utf-8")).toBe("beta changed\n");
	});

	it("reports an explicit conflict with both diffs on the same file", () => {
		const wt = createWorktree(repo, "conflictor");
		writeFileSync(join(wt.path, "a.txt"), "alpha from worktree\n");
		writeFileSync(join(repo, "a.txt"), "alpha from main\n");
		const result = mergeWorktree(repo, "conflictor");
		expect(result.ok).toBe(false);
		expect(result.conflict).toBeDefined();
		expect(result.conflict?.files).toContain("a.txt");
		expect(result.conflict?.incomingDiff).toContain("alpha from worktree");
		expect(result.conflict?.currentDiff).toContain("alpha from main");
		// No silent overwrite: main tree keeps its own content
		expect(readFileSync(join(repo, "a.txt"), "utf-8")).toBe("alpha from main\n");
	});

	it("reports a conflict on an untracked file that already exists with different content", () => {
		const wt = createWorktree(repo, "dupe");
		writeFileSync(join(wt.path, "new.txt"), "from worktree\n");
		writeFileSync(join(repo, "new.txt"), "from main\n");
		const result = mergeWorktree(repo, "dupe");
		expect(result.ok).toBe(false);
		expect(result.conflict?.files).toContain("new.txt");
		expect(readFileSync(join(repo, "new.txt"), "utf-8")).toBe("from main\n");
	});

	it("removeWorktree cleans up the worktree", () => {
		const wt = createWorktree(repo, "temp");
		writeFileSync(join(wt.path, "dirty.txt"), "uncommitted\n");
		removeWorktree(repo, "temp");
		expect(git(repo, ["worktree", "list"])).not.toContain(wt.path);
		expect(() => mergeWorktree(repo, "temp")).toThrow();
	});

	it("throws on unknown worktree id", () => {
		expect(() => mergeWorktree(repo, "nope")).toThrow(/not found/);
	});
});
