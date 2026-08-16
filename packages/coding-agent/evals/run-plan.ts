#!/usr/bin/env node
/**
 * Headless /plan runner — runs the 5-phase orchestrator in batch, WITHOUT the
 * TUI, so /plan can be measured against the baseline (see run.ts). This is what
 * unblocks the /plan-vs-baseline head-to-head: /plan chains phases via UI events
 * that print mode does not pump, so it is driven here through the SDK
 * (createAgentSession) and a poll on the orchestrator's completion flag.
 *
 * The orchestrator extension is loaded from the phi install (~/.phi/agent), so
 * `npm i -g @phi-code-admin/phi-code` must match the code under test. Point the
 * SDK at a specific build with --sdk <path-to-dist/index.js>.
 *
 * Usage (from packages/coding-agent):
 *   npx tsx evals/run-plan.ts --model opencode-go/glm-5.2 [--tasks <dir>] [--out <file.md>]
 *   npx tsx evals/run-plan.ts --sdk /abs/path/to/dist/index.js
 */

import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertUniqueIds, type EvalTask, formatReport, summarize, type TaskRunResult, validateTask } from "./lib.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLAN_TIMEOUT_MS = 20 * 60 * 1000;

function parseArgs(argv: string[]) {
	const args: Record<string, string> = {};
	for (let i = 0; i < argv.length; i++) if (argv[i].startsWith("--")) args[argv[i].slice(2)] = argv[i + 1] ?? "";
	return args;
}

function loadTasks(dir: string): EvalTask[] {
	const tasks = readdirSync(dir)
		.filter((f) => f.endsWith(".json"))
		.map((f) => validateTask(JSON.parse(readFileSync(join(dir, f), "utf-8")), f));
	assertUniqueIds(tasks);
	return tasks;
}

function resolveSdkUrl(explicit?: string): string {
	if (explicit) return pathToFileURL(resolve(explicit)).href;
	// Resolve the installed package's entry.
	try {
		return pathToFileURL(createRequire(import.meta.url).resolve("@phi-code-admin/phi-code")).href;
	} catch {
		// Fall back to the global npm install on Windows.
		const g = join(
			process.env.APPDATA ?? "",
			"npm",
			"node_modules",
			"@phi-code-admin",
			"phi-code",
			"dist",
			"index.js",
		);
		if (existsSync(g)) return pathToFileURL(g).href;
		throw new Error("Cannot resolve @phi-code-admin/phi-code; pass --sdk <path-to-dist/index.js>");
	}
}

async function runPlan(
	sdk: any,
	task: EvalTask,
	model: any,
	workDir: string,
): Promise<{ durationMs: number; error?: string }> {
	const { createAgentSession, AuthStorage, ModelRegistry } = sdk;
	const authStorage = AuthStorage.create();
	const modelRegistry = ModelRegistry.create(authStorage);
	await (modelRegistry.load?.() ?? Promise.resolve());

	const prevCwd = process.cwd();
	process.chdir(workDir);
	execSync(
		"git init -q && git config user.email e@x.co && git config user.name t && git commit -q --allow-empty -m init",
		{ cwd: workDir },
	);
	const start = Date.now();
	try {
		const { session } = await createAgentSession({ model, cwd: workDir, authStorage, modelRegistry });
		await session.prompt(`/plan ${task.prompt}`);
		const g = globalThis as unknown as { __phiOrchestrationActive?: boolean };
		while (g.__phiOrchestrationActive === true && Date.now() - start < PLAN_TIMEOUT_MS) {
			await new Promise((r) => setTimeout(r, 2000));
		}
		const timedOut = g.__phiOrchestrationActive === true;
		try {
			await session.dispose?.();
		} catch {
			/* best effort */
		}
		return { durationMs: Date.now() - start, error: timedOut ? "orchestration timeout" : undefined };
	} catch (err) {
		return { durationMs: Date.now() - start, error: err instanceof Error ? err.message : String(err) };
	} finally {
		process.chdir(prevCwd);
	}
}

function verify(task: EvalTask, workDir: string): boolean {
	return spawnSync(task.verify, { cwd: workDir, shell: true, timeout: 60_000 }).status === 0;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const tasksDir = resolve(args.tasks ?? join(HERE, "tasks"));
	const outFile = resolve(args.out ?? join(HERE, "report-plan.md"));
	const sdk = await import(resolveSdkUrl(args.sdk));
	const { AuthStorage, ModelRegistry } = sdk;
	const registry = ModelRegistry.create(AuthStorage.create());
	await (registry.load?.() ?? Promise.resolve());
	const available = await registry.getAvailable();
	const [prov, id] = (args.model ?? "").split("/");
	const model = available.find((m: any) => m.provider === prov && m.id === id) ?? available[0];
	if (!model) throw new Error("No available model (configure a provider first)");

	const tasks = loadTasks(tasksDir);
	console.log(`Loaded ${tasks.length} task(s). Strategy: plan. Model: ${model.provider}/${model.id}\n`);

	const results: TaskRunResult[] = [];
	for (const task of tasks) {
		const workDir = mkdtempSync(join(tmpdir(), `plan-${task.id}-`));
		try {
			process.stdout.write(`▶ ${task.id} (plan)... `);
			const { durationMs, error } = await runPlan(sdk, task, model, workDir);
			const passed = error ? false : verify(task, workDir);
			results.push({ taskId: task.id, strategy: "plan", passed, durationMs, error });
			console.log(error ? `error: ${error}` : passed ? `PASS (${(durationMs / 1000).toFixed(0)}s)` : "FAIL");
		} finally {
			try {
				rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
			} catch {
				/* OS reaps temp */
			}
		}
	}

	const report = formatReport(results, summarize(results));
	writeFileSync(outFile, report, "utf-8");
	console.log(`\n${report}\nReport written to ${outFile}`);
}

main();
