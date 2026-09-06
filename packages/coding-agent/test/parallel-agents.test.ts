import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	clearFinishedAgents,
	formatConflictReport,
	killAgent,
	listAgents,
	MAX_SPAWN_DEPTH,
	registerAgent,
	runParallel,
} from "../src/core/parallel-agents.ts";

function git(cwd: string, args: string[]): string {
	return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8" }).toString();
}

describe("parallel-agents", () => {
	let repo: string;

	beforeEach(() => {
		repo = mkdtempSync(join(tmpdir(), "phi-parallel-test-"));
		git(repo, ["init"]);
		git(repo, ["config", "user.email", "test@example.com"]);
		git(repo, ["config", "user.name", "Test"]);
		writeFileSync(join(repo, "shared.txt"), "base\n");
		writeFileSync(join(repo, "one.txt"), "1\n");
		writeFileSync(join(repo, "two.txt"), "2\n");
		git(repo, ["add", "."]);
		git(repo, ["commit", "-m", "init"]);
		clearFinishedAgents();
	});

	afterEach(() => {
		rmSync(repo, { recursive: true, force: true });
	});

	it("runs tasks in isolated worktrees and merges their changes", async () => {
		const results = await runParallel(
			[
				{
					id: "agent-a",
					run: ({ cwd }) => {
						writeFileSync(join(cwd, "one.txt"), "1 changed\n");
						return "did one";
					},
				},
				{
					id: "agent-b",
					run: ({ cwd }) => {
						writeFileSync(join(cwd, "two.txt"), "2 changed\n");
						return "did two";
					},
				},
			],
			{ repoRoot: repo },
		);
		expect(results.map((r) => r.verdict)).toEqual(["success", "success"]);
		expect(results.map((r) => r.output)).toEqual(["did one", "did two"]);
		expect(readFileSync(join(repo, "one.txt"), "utf-8")).toBe("1 changed\n");
		expect(readFileSync(join(repo, "two.txt"), "utf-8")).toBe("2 changed\n");
	});

	it("bounds concurrency", async () => {
		let active = 0;
		let peak = 0;
		const task = (id: string) => ({
			id,
			run: async () => {
				active++;
				peak = Math.max(peak, active);
				await new Promise((r) => setTimeout(r, 20));
				active--;
				return id;
			},
		});
		await runParallel([task("t1"), task("t2"), task("t3"), task("t4"), task("t5")], {
			repoRoot: repo,
			maxConcurrency: 2,
			useWorktrees: false,
		});
		expect(peak).toBe(2);
	});

	it("reports an explicit conflict when two agents modify the same file", async () => {
		const results = await runParallel(
			[
				{
					id: "first",
					run: ({ cwd }) => {
						writeFileSync(join(cwd, "shared.txt"), "from first\n");
						return "first done";
					},
				},
				{
					id: "second",
					run: async ({ cwd }) => {
						// Make sure "first" merges before "second" finishes
						await new Promise((r) => setTimeout(r, 50));
						writeFileSync(join(cwd, "shared.txt"), "from second\n");
						return "second done";
					},
				},
			],
			{ repoRoot: repo, maxConcurrency: 2 },
		);
		const byVerdict = results.map((r) => r.verdict).sort();
		expect(byVerdict).toEqual(["conflict", "success"]);
		const loser = results.find((r) => r.verdict === "conflict");
		expect(loser?.conflicts?.files).toContain("shared.txt");
		// Both diffs are present in the conflict report
		expect(loser?.conflicts?.incomingDiff).toBeTruthy();
		expect(loser?.conflicts?.currentDiff).toBeTruthy();
		expect(loser?.output).toContain("MERGE CONFLICT");
		// Winner's content is in the tree; no silent overwrite
		const content = readFileSync(join(repo, "shared.txt"), "utf-8");
		expect(["from first\n", "from second\n"]).toContain(content);
	});

	it("turns task errors into error verdicts without throwing", async () => {
		const results = await runParallel(
			[
				{
					id: "boom",
					run: () => {
						throw new Error("kaboom");
					},
				},
				{ id: "fine", run: () => "ok" },
			],
			{ repoRoot: repo },
		);
		expect(results.find((r) => r.id === "boom")?.verdict).toBe("error");
		expect(results.find((r) => r.id === "fine")?.verdict).toBe("success");
	});

	it("enforces the spawn depth policy (depth = 1)", async () => {
		expect(MAX_SPAWN_DEPTH).toBe(1);
		await expect(runParallel([], { repoRoot: repo, depth: 1 })).rejects.toThrow(/spawn depth/);
		// Depth 0 tasks receive depth 0 context and run fine
		const results = await runParallel([{ id: "x", run: ({ depth }) => `depth=${depth}` }], { repoRoot: repo });
		expect(results[0].output).toBe("depth=0");
	});

	it("exposes the registry: register, finish via run, list", async () => {
		await runParallel([{ id: "reg-agent", run: () => "done" }], { repoRoot: repo });
		const agents = listAgents();
		const entry = agents.find((a) => a.id === "reg-agent");
		expect(entry?.status).toBe("finished");
		expect(entry?.verdict).toBe("success");
	});

	it("kills a running agent via the registry", async () => {
		let startedResolve: () => void = () => {};
		const started = new Promise<void>((r) => {
			startedResolve = r;
		});
		const promise = runParallel(
			[
				{
					id: "long-runner",
					run: async ({ signal }) => {
						startedResolve();
						await new Promise((r) => setTimeout(r, 5000));
						if (signal.aborted) throw new Error("aborted");
						return "should not get here";
					},
				},
			],
			{ repoRoot: repo, useWorktrees: false },
		);
		await started;
		expect(listAgents().find((a) => a.id === "long-runner")?.status).toBe("running");
		expect(killAgent("long-runner")).toBe(true);
		const results = await promise;
		expect(results[0].verdict).toBe("killed");
		expect(killAgent("long-runner")).toBe(false); // already finished
		expect(killAgent("unknown")).toBe(false);
	});

	it("formats an explicit conflict report listing both diffs", () => {
		const report = formatConflictReport({
			files: ["shared.txt"],
			incomingDiff: "+from agent A",
			currentDiff: "+from agent B",
		});
		expect(report).toContain("MERGE CONFLICT");
		expect(report).toContain("shared.txt");
		expect(report).toContain("+from agent A");
		expect(report).toContain("+from agent B");
	});

	it("registers and finishes manual registry entries", () => {
		registerAgent("manual");
		expect(listAgents().find((a) => a.id === "manual")?.status).toBe("running");
		expect(killAgent("manual")).toBe(true);
		expect(listAgents().find((a) => a.id === "manual")?.status).toBe("killed");
	});
});
