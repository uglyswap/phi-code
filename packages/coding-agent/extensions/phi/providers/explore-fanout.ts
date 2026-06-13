/**
 * Opt-in parallel EXPLORE fan-out for the /plan orchestrator.
 *
 * Spawns a small number of read-only `pi` sub-explorers, each with a narrow focus
 * (architecture / impacted files / risks), and merges their findings into the
 * EXPLORE phase context. This is the perspective-diverse pattern applied to the
 * front of the pipeline: a more complete map of the codebase means better
 * downstream plan/code/test phases.
 *
 * GUARDRAILS (this whole module is best-effort and NEVER throws):
 *  - Read-only only: sub-explorers get a read-only tool set, no write/edit/bash.
 *  - Hard concurrency cap of 2 (a single rate-limited proxy key is the constraint).
 *  - Adaptive fallback: if any sub-explorer reports a 429 / rate limit, the
 *    remaining ones run sequentially (concurrency drops to 1).
 *  - Per-explorer timeout, with the process killed on expiry.
 *  - Any failure (spawn error, timeout, no output, rate limit) degrades to "no
 *    findings" so the orchestrator simply runs the normal single-agent EXPLORE.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename } from "node:path";

export interface ExplorerSpec {
	focus: string;
	prompt: string;
}

export interface ExplorerResult {
	focus: string;
	text: string;
	ok: boolean;
	rateLimited: boolean;
	error?: string;
}

export interface FanoutOptions {
	model?: string;
	tools?: string[];
	cwd?: string;
	concurrency?: number;
	timeoutMs?: number;
}

/** Read-only tools handed to every sub-explorer. */
export const READONLY_EXPLORER_TOOLS = ["read", "grep", "glob", "ls", "find", "memory_search", "memory_read"];

const HARD_CONCURRENCY_CAP = 2;
const DEFAULT_TIMEOUT_MS = 4 * 60 * 1000;

/** Re-invoke the current phi binary (so the sub-explorer is the same build). */
function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) return { command: process.execPath, args };
	return { command: "pi", args };
}

export function isRateLimited(text: string): boolean {
	return /\b429\b|rate.?limit(ed)?|too many requests|overloaded|quota exceeded|resource exhausted/i.test(text);
}

/** Strip the model's reasoning blocks so they do not pollute the merged brief. */
export function stripThinking(text: string): string {
	return text
		.replace(/<think>[\s\S]*?<\/think>/gi, "")
		.replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/** Run one sub-explorer. Never throws; always resolves to an ExplorerResult. */
function runOneExplorer(spec: ExplorerSpec, opts: FanoutOptions): Promise<ExplorerResult> {
	return new Promise((resolve) => {
		const args = ["--mode", "json", "-p", "--no-session"];
		if (opts.model) args.push("--model", opts.model);
		const tools = opts.tools && opts.tools.length > 0 ? opts.tools : READONLY_EXPLORER_TOOLS;
		args.push("--tools", tools.join(","));
		args.push(`Task: ${spec.prompt}`);

		let proc: ReturnType<typeof spawn>;
		try {
			const inv = getPiInvocation(args);
			proc = spawn(inv.command, inv.args, { cwd: opts.cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
		} catch (e) {
			resolve({ focus: spec.focus, text: "", ok: false, rateLimited: false, error: String(e) });
			return;
		}

		let buffer = "";
		let finalText = "";
		let stderr = "";
		let errorMessage = "";
		let settled = false;

		const timer = setTimeout(() => {
			try {
				proc.kill();
			} catch {
				/* best effort */
			}
		}, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

		const processLine = (line: string) => {
			if (!line.trim()) return;
			let event: any;
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}
			if (event?.type === "message_end" && event.message?.role === "assistant") {
				const parts = event.message.content;
				if (Array.isArray(parts)) {
					for (const p of parts) {
						if (p?.type === "text" && typeof p.text === "string") finalText = p.text;
					}
				}
				if (event.message.errorMessage) errorMessage = String(event.message.errorMessage);
			}
		};

		const finish = (timedOut: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (buffer.trim()) processLine(buffer);
			const blob = `${finalText}\n${errorMessage}\n${stderr}`;
			const rateLimited = isRateLimited(blob);
			const ok = !timedOut && finalText.trim().length > 0 && !rateLimited;
			resolve({
				focus: spec.focus,
				text: finalText,
				ok,
				rateLimited,
				error: errorMessage || (ok ? undefined : timedOut ? "timeout" : "no output"),
			});
		};

		proc.stdout?.on("data", (data) => {
			buffer += data.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";
			for (const line of lines) processLine(line);
		});
		proc.stderr?.on("data", (data) => {
			stderr += data.toString();
		});
		proc.on("error", (e) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ focus: spec.focus, text: "", ok: false, rateLimited: false, error: String(e) });
		});
		proc.on("close", () => finish(false));
	});
}

/**
 * Run the sub-explorers with a hard concurrency cap of 2; if a batch hits a rate
 * limit, drop to sequential for the rest. Returns the merged findings (markdown)
 * plus the raw results. Best-effort: callers should fall back to the normal
 * single-agent EXPLORE when `merged` is empty.
 */
export async function runExploreFanout(
	specs: ExplorerSpec[],
	opts: FanoutOptions,
): Promise<{ results: ExplorerResult[]; merged: string; rateLimited: boolean }> {
	let concurrency = Math.max(1, Math.min(opts.concurrency ?? HARD_CONCURRENCY_CAP, HARD_CONCURRENCY_CAP));
	const results: ExplorerResult[] = [];
	let i = 0;
	while (i < specs.length) {
		const batch = specs.slice(i, i + concurrency);
		const batchResults = await Promise.all(batch.map((s) => runOneExplorer(s, opts)));
		results.push(...batchResults);
		i += batch.length;
		// Adaptive backoff: a rate limit means the single key is saturated, so
		// serialize whatever is left rather than push harder.
		if (batchResults.some((r) => r.rateLimited)) concurrency = 1;
	}
	const ok = results.filter((r) => r.ok && r.text.trim());
	const merged = ok
		.map((r) => `### Exploration — ${r.focus}\n${stripThinking(r.text)}`)
		.filter((block) => block.trim().length > 0)
		.join("\n\n");
	return { results, merged, rateLimited: results.some((r) => r.rateLimited) };
}

/** The default narrow-mandate explorer specs for a /plan request. */
export function defaultExplorerSpecs(description: string): ExplorerSpec[] {
	const base = `Read-only exploration. Do NOT modify any file. Be concise and cite file:line.`;
	return [
		{
			focus: "architecture & reusable patterns",
			prompt: `${base}\nProject request: ${description}\nExplore the codebase architecture: tech stack, key modules/directories, the conventions and existing utilities/functions to REUSE, and how the pieces fit together.`,
		},
		{
			focus: "impacted files",
			prompt: `${base}\nProject request: ${description}\nIdentify the files and code that will be IMPACTED: grep the relevant symbols, find callers and callees, and list the exact files (file:line) that will likely need changes and why.`,
		},
		{
			focus: "risks & constraints",
			prompt: `${base}\nProject request: ${description}\nIdentify risks, edge cases, and constraints to NOT break: behaviour that must be preserved, error handling, security, and tests that cover the area.`,
		},
	];
}
