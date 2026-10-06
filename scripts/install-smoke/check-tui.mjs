#!/usr/bin/env node
// Usage (isolated env set by smoke.mjs): node check-tui.mjs <runDir> [seconds]
// Starts the installed CLI in interactive (TUI) mode inside a pseudo-terminal
// provided by `script` (Linux: util-linux, macOS: BSD), with no API key.
// Answers the trust / first-run prompts, checks it is still running after a
// few seconds without a crash, then quits with ctrl+c twice.
// Windows has no `script`: the check is skipped and says so.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { IS_WINDOWS, layout, result, stripAnsi } from "./common.mjs";

const l = layout(process.argv[2]);
const seconds = Number(process.argv[3] ?? 12);
if (IS_WINDOWS) {
	result("SKIP", "no `script` pseudo-terminal on Windows (TUI not exercised here)");
	process.exit();
}
const quote = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
// `script` sizes the pty from its stdin, which is a pipe here: set a real size first.
const inner = `stty cols 120 rows 40 2>/dev/null; exec ${quote(process.execPath)} ${quote(l.cli)}`;
const args =
	process.platform === "darwin" ? ["-q", "/dev/null", "/bin/sh", "-c", inner] : ["-q", "-e", "-c", `/bin/sh -c ${quote(inner)}`, "/dev/null"];
const child = spawn("script", args, {
	cwd: l.work,
	env: { ...process.env, TERM: "xterm-256color" },
	stdio: ["pipe", "pipe", "pipe"],
});
let raw = "";
let exited = null;
const answered = new Set();
const answerOnce = (key, pattern, keys) => {
	if (!answered.has(key) && pattern.test(stripAnsi(raw))) {
		answered.add(key);
		setTimeout(() => child.stdin.write(keys), 500);
	}
};
const onData = (d) => {
	raw += d;
	answerOnce("trust", /Trust project folder\?/, "\r");
	answerOnce("welcome", /Bienvenue dans Phi Code|Welcome to Phi/i, "\x1b");
};
child.stdout.on("data", onData);
child.stderr.on("data", onData);
child.on("error", (error) => {
	raw += `\n[spawn error] ${error.message}\n`;
});
child.on("exit", (code, signal) => {
	exited = { code, signal };
});

await new Promise((r) => setTimeout(r, seconds * 1000));
const aliveAfterWait = exited === null;
child.stdin.write("\x03");
await new Promise((r) => setTimeout(r, 400));
child.stdin.write("\x03");
const deadline = Date.now() + 8000;
while (exited === null && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
const exitedOnCtrlC = exited !== null;
if (!exitedOnCtrlC) child.kill("SIGKILL");

writeFileSync(join(l.runDir, "tui-raw.txt"), raw);
const text = stripAnsi(raw);
const lines = text
	.split(/\r?\n/)
	.map((line) => line.trimEnd())
	.filter((line) => line.trim());
console.log(`alive after ${seconds}s: ${aliveAfterWait}; exit after ctrl+c: ${JSON.stringify(exited)}`);
console.log(lines.slice(-40).join("\n"));

const problems = [];
if (!aliveAfterWait) problems.push(`TUI exited early: ${JSON.stringify(exited)}`);
if (!exitedOnCtrlC) problems.push("TUI did not exit on ctrl+c twice");
if (/TypeError|ReferenceError|SyntaxError|Cannot find module|ERR_MODULE_NOT_FOUND|\n\s+at .+:\d+:\d+\)/.test(text)) {
	problems.push("crash/stack trace in the TUI output");
}
if (text.trim().length < 50) problems.push("TUI rendered (almost) nothing");
result(problems.length ? "FAIL" : "PASS", problems.length ? problems.join("; ") : `TUI ran ${seconds}s and quit cleanly`);
