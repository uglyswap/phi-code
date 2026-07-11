import { describe, expect, it } from "vitest";
import { type CommandResult, passed, runCommand, summarize, tail } from "../extensions/phi/providers/execution.js";

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
