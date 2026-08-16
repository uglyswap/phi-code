#!/usr/bin/env node
/**
 * phi-code eval runner. Executes each task with the baseline strategy (a single
 * `phi --print` call), runs the task's deterministic verifier, and writes a
 * markdown report. The scoring/aggregation is in lib.ts (unit-tested); this file
 * is the side-effecting shell.
 *
 * Usage:
 *   npx tsx evals/run.ts [--tasks <dir>] [--out <file.md>] [--model <id>]
 *
 * Requires a configured provider (run `/setup` in phi first, or set an API key
 * env var). See evals/README.md for methodology and the /plan comparison plan.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertUniqueIds, type EvalTask, formatReport, summarize, type TaskRunResult, validateTask } from "./lib.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv: string[]) {
	const args: Record<string, string> = {};
	for (let i = 0; i < argv.length; i++) {
		if (argv[i].startsWith("--")) args[argv[i].slice(2)] = argv[i + 1] ?? "";
	}
	return args;
}

function loadTasks(dir: string): EvalTask[] {
	const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
	const tasks = files.map((f) => validateTask(JSON.parse(readFileSync(join(dir, f), "utf-8")), f));
	assertUniqueIds(tasks);
	return tasks;
}

/** Baseline strategy: one `phi --print` call in an isolated dir. */
function runBaseline(task: EvalTask, workDir: string, model?: string): { durationMs: number; error?: string } {
	// Build one shell command string rather than passing an args array with
	// shell:true — the latter concatenates args unquoted, so a prompt with
	// spaces/parentheses reaches phi mangled (it then hangs → timeout on
	// Windows). Our prompts contain no double quotes; wrap defensively anyway.
	const q = (s: string) => `"${s.replace(/"/g, '\\"')}"`;
	const modelPart = model ? `--model ${q(model)} ` : "";
	const cmd = `phi --print ${modelPart}${q(task.prompt)}`;
	const start = Date.now();
	const res = spawnSync(cmd, {
		cwd: workDir,
		encoding: "utf-8",
		timeout: (task.timeoutSec ?? 180) * 1000,
		shell: true,
		env: { ...process.env, PI_SKIP_VERSION_CHECK: "1" },
	});
	const durationMs = Date.now() - start;
	if (res.error) return { durationMs, error: res.error.message };
	if (res.status !== 0) return { durationMs, error: `phi exited ${res.status}` };
	return { durationMs };
}

function verify(task: EvalTask, workDir: string): boolean {
	const res = spawnSync(task.verify, { cwd: workDir, encoding: "utf-8", shell: true, timeout: 60_000 });
	return res.status === 0;
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	const tasksDir = resolve(args.tasks ?? join(HERE, "tasks"));
	const outFile = resolve(args.out ?? join(HERE, "report.md"));
	const model = args.model || undefined;

	if (!existsSync(tasksDir)) {
		console.error(`Tasks dir not found: ${tasksDir}`);
		process.exit(1);
	}
	const tasks = loadTasks(tasksDir);
	console.log(`Loaded ${tasks.length} task(s). Model: ${model ?? "(phi default)"}\n`);

	const results: TaskRunResult[] = [];
	for (const task of tasks) {
		const workDir = mkdtempSync(join(tmpdir(), `eval-${task.id}-`));
		try {
			process.stdout.write(`▶ ${task.id} (baseline)... `);
			const { durationMs, error } = runBaseline(task, workDir, model);
			const passed = error ? false : verify(task, workDir);
			results.push({ taskId: task.id, strategy: "baseline", passed, durationMs, error });
			console.log(error ? `error: ${error}` : passed ? `PASS (${(durationMs / 1000).toFixed(1)}s)` : "FAIL");
		} finally {
			// Windows keeps file handles briefly after the child exits, so a bare
			// rmSync races with EPERM — retry a few times.
			try {
				rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
			} catch {
				/* leave the temp dir; the OS will reap it */
			}
		}
	}

	const summaries = summarize(results);
	const report = formatReport(results, summaries);
	writeFileSync(outFile, report, "utf-8");
	console.log(`\n${report}\nReport written to ${outFile}`);
}

main();
