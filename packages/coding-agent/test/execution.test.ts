import { describe, expect, it } from "vitest";
import {
	type CommandResult,
	passed,
	runArgv,
	runArgvAsync,
	runCommand,
	runCommandAsync,
	summarize,
	tail,
} from "../extensions/phi/providers/execution.ts";

const result = (over: Partial<CommandResult> = {}): CommandResult => ({
	command: "cmd",
	exitCode: 0,
	stdout: "",
	stderr: "",
	durationMs: 100,
	timedOut: false,
	...over,
});

describe("passed", () => {
	it("is true only on exit 0 without timeout", () => {
		expect(passed(result({ exitCode: 0 }))).toBe(true);
		expect(passed(result({ exitCode: 1 }))).toBe(false);
		expect(passed(result({ exitCode: 0, timedOut: true }))).toBe(false);
		expect(passed(result({ exitCode: null }))).toBe(false);
	});
});

describe("summarize / tail", () => {
	it("summarizes exit and timeout", () => {
		expect(summarize(result({ exitCode: 1, durationMs: 2000 }))).toContain("exit 1");
		expect(summarize(result({ timedOut: true, durationMs: 3000 }))).toContain("TIMED OUT");
	});
	it("tails the combined output", () => {
		const r = result({ stdout: "a\nb\nc\nd", stderr: "e" });
		expect(tail(r, 2)).toBe("d\ne");
		expect(tail(r, 10)).toContain("a");
	});
});

describe("runCommand (real spawn)", () => {
	it("captures exit 0 and stdout", () => {
		const r = runCommand("echo hello-exec");
		expect(passed(r)).toBe(true);
		expect(r.stdout).toContain("hello-exec");
		expect(r.exitCode).toBe(0);
	});

	it("captures a non-zero exit without throwing", () => {
		const r = runCommand("exit 3");
		expect(r.exitCode).toBe(3);
		expect(passed(r)).toBe(false);
	});

	it("reports a timeout instead of hanging", () => {
		// A command that would run longer than the timeout.
		const r = runCommand(process.platform === "win32" ? "ping -n 5 127.0.0.1 > NUL" : "sleep 5", {
			timeoutMs: 500,
		});
		expect(r.timedOut).toBe(true);
		expect(passed(r)).toBe(false);
	});

	it("runs in the given cwd", () => {
		const r = runCommand(process.platform === "win32" ? "cd" : "pwd", { cwd: process.cwd() });
		expect(passed(r)).toBe(true);
	});
});

describe("runCommandAsync / runArgvAsync (the drift fix)", () => {
	it("captures a passing run without blocking", async () => {
		const r = await runCommandAsync(`node -e "process.stdout.write('async-ok')"`);
		expect(passed(r)).toBe(true);
		expect(r.stdout).toContain("async-ok");
	});

	it("reports a non-zero exit as data", async () => {
		const r = await runCommandAsync(`node -e "process.exit(7)"`);
		expect(r.exitCode).toBe(7);
		expect(passed(r)).toBe(false);
	});

	it("kills the tree on timeout and reports timedOut", { timeout: 60_000 }, async () => {
		const r = await runCommandAsync(`node -e "setTimeout(()=>{},60000)"`, { timeoutMs: 800 });
		expect(r.timedOut).toBe(true);
		expect(passed(r)).toBe(false);
		expect(r.durationMs).toBeLessThan(15_000);
	});

	it("KEEPS THE EVENT LOOP ALIVE during a run (the 6h-drift regression test)", async () => {
		// With spawnSync, this timer could never fire mid-run; with spawn it must.
		let timerFired = false;
		const t = setTimeout(() => {
			timerFired = true;
		}, 300);
		const r = await runCommandAsync(`node -e "setTimeout(()=>{},1200)"`, { timeoutMs: 10_000 });
		clearTimeout(t);
		expect(r.durationMs).toBeGreaterThan(1000);
		expect(timerFired).toBe(true); // fired DURING the child run
	});

	it("runArgvAsync spawns without a shell and honours the label", async () => {
		const r = await runArgvAsync(process.execPath, ["-e", "process.stdout.write(process.argv[1])", "a;b|c"], {
			label: "docker run …",
		});
		expect(r.stdout).toBe("a;b|c");
		expect(r.command).toBe("docker run …");
	});

	it("reports an unspawnable program as data, never throws", async () => {
		const r = await runArgvAsync("definitely-not-a-binary-zzz", ["--v"]);
		expect(r.exitCode).toBeNull();
		expect(passed(r)).toBe(false);
	});
});

describe("runArgv (no-shell argv spawn)", () => {
	it("captures stdout and a passing exit without a shell", () => {
		const r = runArgv(process.execPath, ["-e", "process.stdout.write('argv-ok')"]);
		expect(passed(r)).toBe(true);
		expect(r.stdout).toContain("argv-ok");
	});

	it("reports a non-zero exit without throwing", () => {
		const r = runArgv(process.execPath, ["-e", "process.exit(4)"]);
		expect(r.exitCode).toBe(4);
		expect(passed(r)).toBe(false);
	});

	it("does not shell-interpret its arguments (safe with special chars)", () => {
		// If this went through a shell, the ; && | would break it apart.
		const r = runArgv(process.execPath, ["-e", "process.stdout.write(process.argv[1])", "a; rm -rf / && b | c"]);
		expect(r.stdout).toBe("a; rm -rf / && b | c");
	});

	it("returns a null exit code when the program cannot be spawned", () => {
		const r = runArgv("definitely-not-a-real-binary-xyz", ["--version"]);
		expect(r.exitCode).toBeNull();
		expect(passed(r)).toBe(false);
	});

	it("uses the label as the reported command when given", () => {
		const r = runArgv(process.execPath, ["-e", ""], { label: "docker run ..." });
		expect(r.command).toBe("docker run ...");
	});
});
