/**
 * Execution oracle — run real commands and report objective results.
 *
 * This is the ground truth the /plan → /debug → /build design turns on: an
 * accept/reject decision must come from RUNNING code, not from a model reviewing
 * its own output (see docs/design/plan-debug-build.md). Everything here is thin
 * and deterministic so the result interpretation can be unit-tested; the spawn
 * itself is exercised with trivial real commands.
 */

import { spawnSync } from "node:child_process";

const DEFAULT_MAX_BUFFER = 32 * 1024 * 1024;

export interface CommandResult {
	command: string;
	exitCode: number | null;
	stdout: string;
	stderr: string;
	durationMs: number;
	timedOut: boolean;
}

/** A command passed iff it exited 0 and did not time out. */
export function passed(result: CommandResult): boolean {
	return result.exitCode === 0 && !result.timedOut;
}

/** One-line summary for a phase report / handoff. */
export function summarize(result: CommandResult): string {
	if (result.timedOut) return `\`${result.command}\` → TIMED OUT after ${Math.round(result.durationMs / 1000)}s`;
	return `\`${result.command}\` → exit ${result.exitCode ?? "?"} (${Math.round(result.durationMs / 1000)}s)`;
}

/** Last N lines of the combined output — what a model needs to see to react. */
export function tail(result: CommandResult, lines = 40): string {
	const combined = `${result.stdout}\n${result.stderr}`.trimEnd();
	const all = combined.split("\n");
	return all.slice(Math.max(0, all.length - lines)).join("\n");
}

export interface RunOptions {
	cwd?: string;
	timeoutMs?: number;
	env?: NodeJS.ProcessEnv;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Run a shell command and capture its result. Never throws — a non-zero exit,
 * a spawn error, or a timeout all come back as a CommandResult so callers make
 * decisions from data, not exceptions.
 */
export function runCommand(command: string, options: RunOptions = {}): CommandResult {
	const start = Date.now();
	const res = spawnSync(command, {
		cwd: options.cwd,
		timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
		env: options.env ?? process.env,
		shell: true,
		encoding: "utf-8",
		maxBuffer: DEFAULT_MAX_BUFFER,
	});
	const durationMs = Date.now() - start;
	// spawnSync sets error with code "ETIMEDOUT" on timeout, and signal SIGTERM.
	const timedOut = res.error !== undefined && (res.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
	const spawnFailed = res.error !== undefined && !timedOut;
	return {
		command,
		exitCode: spawnFailed ? null : (res.status ?? (timedOut ? null : null)),
		stdout: res.stdout ?? "",
		stderr: spawnFailed ? `${(res.error as Error).message}\n${res.stderr ?? ""}` : (res.stderr ?? ""),
		durationMs,
		timedOut,
	};
}

/**
 * Run a program by ARGV with NO shell. This is what the Docker sandbox uses:
 * passing `docker` + its arguments directly avoids shell quoting and — on
 * Windows Git Bash — the MSYS path mangling that corrupts `-v C:\x:/work` and
 * `//var/run/docker.sock`. `label` is the human-readable command echoed back in
 * the result (the argv itself is not a shell string). Never throws.
 */
export function runArgv(file: string, args: string[], options: RunOptions & { label?: string } = {}): CommandResult {
	const start = Date.now();
	const res = spawnSync(file, args, {
		cwd: options.cwd,
		timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
		env: options.env ?? process.env,
		shell: false,
		encoding: "utf-8",
		maxBuffer: DEFAULT_MAX_BUFFER,
	});
	const durationMs = Date.now() - start;
	const timedOut = res.error !== undefined && (res.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
	const spawnFailed = res.error !== undefined && !timedOut;
	return {
		command: options.label ?? `${file} ${args.join(" ")}`.trim(),
		exitCode: spawnFailed ? null : (res.status ?? null),
		stdout: res.stdout ?? "",
		stderr: spawnFailed ? `${(res.error as Error).message}\n${res.stderr ?? ""}` : (res.stderr ?? ""),
		durationMs,
		timedOut,
	};
}
