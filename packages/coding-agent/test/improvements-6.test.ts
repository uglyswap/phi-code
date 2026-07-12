import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCandidateWorktree, worktreePatch } from "../extensions/phi/providers/candidate-fanout.js";
import { reproAuditInstruction } from "../extensions/phi/providers/debug-build-commands.js";
import { shotBudgetMs } from "../extensions/phi/providers/escalation.js";
import { parseRunsJsonl, summarizeRuns } from "../extensions/phi/providers/telemetry.js";
import {
	type DiscoverySeams,
	discoverTargetedTests,
	testCandidatesFor,
} from "../extensions/phi/providers/test-discovery.js";
import { looksLikeBugReport } from "../extensions/phi/providers/triage.js";

// ── 1. Targeted test discovery (flask-4992 oracle upgrade) ────────────
describe("test-discovery", () => {
	const seams = (existing: string[], pkg: object | null = null): DiscoverySeams => ({
		exists: (p) => existing.includes(p),
		readPackageJson: () => pkg as never,
	});

	it("maps a python module to its conventional test locations", () => {
		expect(testCandidatesFor("flask/src/blueprints.py")).toContain("flask/src/test_blueprints.py");
		expect(testCandidatesFor("flask/src/blueprints.py")).toContain("tests/test_blueprints.py");
	});
	it("a test file maps to itself", () => {
		expect(testCandidatesFor("tests/test_x.py")).toEqual(["tests/test_x.py"]);
	});
	it("builds a pytest command from existing files only", () => {
		const t = discoverTargetedTests(["src/app.py", "src/db.py"], seams(["tests/test_app.py"]));
		expect(t.files).toEqual(["tests/test_app.py"]);
		expect(t.command).toBe("python -m pytest tests/test_app.py -x -q");
	});
	it("uses vitest for JS when present in package.json", () => {
		const t = discoverTargetedTests(
			["src/util.ts"],
			seams(["test/util.test.ts"], { devDependencies: { vitest: "^3" } }),
		);
		expect(t.command).toContain("npx vitest run test/util.test.ts");
	});
	it("returns no command when nothing exists (never invents a suite)", () => {
		expect(discoverTargetedTests(["src/x.py"], seams([])).command).toBeUndefined();
	});
	it("caps the number of discovered files", () => {
		const files = Array.from({ length: 9 }, (_, i) => `m${i}.py`);
		const existing = files.map((f) => `test_${f}`);
		expect(discoverTargetedTests(files, seams(existing)).files.length).toBeLessThanOrEqual(5);
	});
});

// ── 2. Repro audit (2148/4992 lesson) ─────────────────────────────────
describe("reproAuditInstruction", () => {
	const ins = reproAuditInstruction({ expected: "iter_content should yield str" });
	it("asks the single adversarial question and demands literal comparison", () => {
		expect(ins).toMatch(/NOT covered/i);
		expect(ins).toMatch(/LITERALLY/i);
	});
	it("requires the (possibly updated) REPRO-CMD line and a still-failing repro", () => {
		expect(ins).toContain("REPRO-CMD:");
		expect(ins).toMatch(/must still FAIL/i);
	});
});

// ── 3. Tiered shot budgets ─────────────────────────────────────────────
describe("shotBudgetMs", () => {
	it("gives an easy task room and a hard one a fast-fail budget", () => {
		expect(shotBudgetMs("single-shot")).toBeGreaterThan(shotBudgetMs("debug"));
		expect(shotBudgetMs("debug")).toBeGreaterThan(shotBudgetMs("build"));
		expect(shotBudgetMs("build")).toBe(shotBudgetMs("plan"));
	});
});

// ── 4. Telemetry aggregation ───────────────────────────────────────────
describe("summarizeRuns / parseRunsJsonl", () => {
	const rec = (
		mode: string,
		outcome: string,
		phases: { key: string; durationMs?: number; verdict?: string | null }[] = [],
	) =>
		JSON.stringify({
			mode,
			startedAt: "2026-07-12T00:00:00.000Z",
			durationMs: 60_000,
			phases: phases.map((p) => ({
				key: p.key,
				label: p.key,
				model: "m",
				verdict: p.verdict ?? null,
				retried: false,
				blockedRetried: false,
				durationMs: p.durationMs,
			})),
			completedPhases: phases.length,
			skippedPhases: 0,
			sandboxExecs: 3,
			outcome,
		});

	it("parses tolerant of garbage lines", () => {
		const rs = parseRunsJsonl(
			`${rec("fix", "✅ /fix finished GREEN at single-shot cost")}\nnot json\n\n${rec("debug", "⏸️ BLOCKED")}`,
		);
		expect(rs).toHaveLength(2);
	});
	it("summarizes the promise metric (green-at-shot vs escalated) and timeouts", () => {
		const blob = [
			rec("fix", "✅ /fix finished GREEN at single-shot cost", [{ key: "shot", durationMs: 90_000 }]),
			rec("fix", "✅ /fix finished.", [{ key: "shot" }, { key: "localize", durationMs: 200_000 }, { key: "fix" }]),
			rec("fix", "⚠️ UNVERIFIED", [{ key: "shot", verdict: "TIMEOUT", durationMs: 600_000 }]),
			rec("debug", "⏸️ stopped: BLOCKED"),
		].join("\n");
		const md = summarizeRuns(parseRunsJsonl(blob));
		expect(md).toContain("4 run(s)");
		expect(md).toMatch(/green at single-shot cost 33%/);
		expect(md).toMatch(/escalated 33%/);
		expect(md).toMatch(/1 phase timeout/);
		expect(md).toMatch(/Slowest phases/);
	});
	it("says so when empty", () => {
		expect(summarizeRuns([])).toContain("No runs recorded yet");
	});
});

// ── 5. Worktree candidates (real git) ──────────────────────────────────
describe("candidate worktrees", () => {
	let repo: string;
	afterEach(() => rmSync(repo, { recursive: true, force: true }));

	it("creates an isolated worktree with sandbox config, captures its patch, removes cleanly", () => {
		repo = mkdtempSync(join(tmpdir(), "wt-repo-"));
		const g = (a: string) => execSync(`git ${a}`, { cwd: repo, stdio: "pipe" });
		g("init -q");
		g("config user.email t@t.t");
		g("config user.name t");
		writeFileSync(join(repo, "app.py"), "x = 1\n");
		mkdirSync(join(repo, ".phi"), { recursive: true });
		writeFileSync(join(repo, ".phi", "sandbox.json"), `{"backend":"local"}`);
		g("add app.py");
		g("commit -qm init");

		const wt = createCandidateWorktree(repo, 0);
		try {
			// isolated copy at HEAD, with the sandbox config carried over
			expect(worktreePatch(wt.path)).toBe("");
			writeFileSync(join(wt.path, "app.py"), "x = 2\n");
			const patch = worktreePatch(wt.path);
			expect(patch).toContain("-x = 1");
			expect(patch).toContain("+x = 2");
			// the MAIN tree is untouched by the candidate's edit
			expect(execSync("git diff", { cwd: repo, stdio: "pipe" }).toString().trim()).toBe("");
		} finally {
			wt.remove();
		}
		// worktree gone from git's bookkeeping
		const list = execSync("git worktree list", { cwd: repo, stdio: "pipe" }).toString();
		expect(list.trim().split("\n")).toHaveLength(1);
	});
});

// ── 6. /fix suggestion ─────────────────────────────────────────────────
describe("looksLikeBugReport", () => {
	it("matches bug-shaped prose", () => {
		expect(looksLikeBugReport("the login route crashes with a TypeError traceback")).toBe(true);
		expect(looksLikeBugReport("mon script plante avec une exception bizarre")).toBe(true);
	});
	it("ignores commands, short texts and neutral asks", () => {
		expect(looksLikeBugReport("/debug pytest x")).toBe(false);
		expect(looksLikeBugReport("fails")).toBe(false);
		expect(looksLikeBugReport("add a dark mode toggle to the settings page")).toBe(false);
	});
});
