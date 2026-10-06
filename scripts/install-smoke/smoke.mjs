#!/usr/bin/env node
// Usage: node scripts/install-smoke/smoke.mjs <runDir> [expectedVersion]
// Runs every post-install check against the global install in <runDir> (see
// install.mjs), each in its own process with a fresh-user environment, and
// prints a summary (also appended to $GITHUB_STEP_SUMMARY when set).
// Exit code 1 when any check FAILS; SKIP never hides a failure, it is only
// used where the platform has no way to run the check (TUI on Windows).
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveNpmInvocation } from "../npm-command.mjs";
import { IS_WINDOWS, isolatedEnv, layout, run } from "./common.mjs";

const [runArg, expectedVersion = ""] = process.argv.slice(2);
if (!runArg) {
	console.error("Usage: smoke.mjs <runDir> [expectedVersion]");
	process.exit(2);
}
const l = layout(runArg);
const here = dirname(fileURLToPath(import.meta.url));
const only = process.env.SMOKE_ONLY ? new Set(process.env.SMOKE_ONLY.split(",")) : undefined;

// typescript-language-server for the LSP check: a user-installed tool, as the
// lsp extension documents (it is not a phi dependency). Installed from npmjs
// outside the isolated phi install.
async function installLspTools() {
	const toolsDir = join(l.runDir, "..", "lsp-tools");
	mkdirSync(toolsDir, { recursive: true });
	writeFileSync(join(toolsDir, "package.json"), '{ "name": "lsp-tools", "private": true }\n');
	const { command, prefixArgs } = resolveNpmInvocation();
	const res = await run(
		command,
		[...prefixArgs, "install", "typescript-language-server@5.1.3", "typescript@5.9.3", "--no-audit", "--no-fund", "--registry", "https://registry.npmjs.org/"],
		{ cwd: toolsDir, env: process.env, timeoutMs: 5 * 60_000 },
	);
	if (res.code !== 0) console.log(`LSP tools install failed:\n${res.output}`);
	return join(toolsDir, "node_modules", ".bin");
}

const checks = [
	{ name: "cli", script: "check-cli.mjs", args: [expectedVersion].filter(Boolean), timeoutMs: 3 * 60_000 },
	{ name: "native", script: "check-native.mjs", timeoutMs: 3 * 60_000 },
	{ name: "session", script: "check-session.mjs", timeoutMs: 20 * 60_000, lsp: true },
	{ name: "rpc", script: "check-rpc.mjs", timeoutMs: 5 * 60_000 },
	{ name: "tui", script: "check-tui.mjs", timeoutMs: 3 * 60_000 },
	{ name: "browser", script: "check-browser.mjs", timeoutMs: 10 * 60_000 },
];

const summary = [];
for (const check of checks) {
	if (only && !only.has(check.name)) continue;
	const extra = {};
	if (check.lsp) {
		const binDir = await installLspTools();
		const base = isolatedEnv(l.runDir);
		const pathKey = Object.keys(base).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
		extra[pathKey] = `${base[pathKey]}${IS_WINDOWS ? ";" : ":"}${binDir}`;
	}
	console.log(`\n::group::check ${check.name}`);
	const t0 = Date.now();
	const res = await run(process.execPath, [join(here, check.script), l.runDir, ...(check.args ?? [])], {
		env: isolatedEnv(l.runDir, extra),
		cwd: l.work,
		timeoutMs: check.timeoutMs,
	});
	console.log(res.output);
	console.log("::endgroup::");
	const line = res.output.match(/^RESULT (PASS|FAIL|SKIP) (.*)$/m);
	let status = line?.[1] ?? "FAIL";
	let message = line?.[2] ?? `no RESULT line (exit ${res.code}${res.timedOut ? ", TIMEOUT" : ""})`;
	if (status !== "FAIL" && res.code !== 0) {
		status = "FAIL";
		message = `${message} (but exit code ${res.code})`;
	}
	const subChecks = [...res.output.matchAll(/^CHECK (PASS|FAIL|SKIP) (.*)$/gm)].map((m) => `${m[1]} ${m[2]}`);
	summary.push({ name: check.name, status, message, seconds: Math.round((Date.now() - t0) / 1000), subChecks });
	console.log(`==> ${check.name}: ${status} ${message}`);
}

const os = `${process.platform}-${process.arch} node ${process.version}`;
console.log(`\n===== install smoke summary (${os}) =====`);
for (const s of summary) console.log(`${s.status.padEnd(4)} ${s.name.padEnd(8)} ${s.seconds}s  ${s.message}`);
if (process.env.GITHUB_STEP_SUMMARY) {
	const md = [
		`### Install smoke: ${os}`,
		"",
		"| check | status | time | detail |",
		"|---|---|---|---|",
		...summary.map((s) => `| ${s.name} | ${s.status} | ${s.seconds}s | ${s.message.replace(/\|/g, "\\|").slice(0, 300)} |`),
		"",
		...summary.flatMap((s) => (s.subChecks.length ? [`<details><summary>${s.name}</summary>`, "", ...s.subChecks.map((c) => `- ${c.replace(/\|/g, "\\|").slice(0, 300)}`), "", "</details>"] : [])),
		"",
	].join("\n");
	appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
}
process.exit(summary.some((s) => s.status === "FAIL") ? 1 : 0);
