#!/usr/bin/env node
// Usage (isolated env set by smoke.mjs): node check-cli.mjs <runDir> [expectedVersion]
// Runs `phi --version` and `phi --help` through the bin shim npm created (the
// way a user types it), so a broken bin link / shebang / missing dist fails here.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { IS_WINDOWS, layout, result, run, stripAnsi } from "./common.mjs";

const l = layout(process.argv[2]);
const pkgVersion = JSON.parse(readFileSync(join(l.pkgDir, "package.json"), "utf8")).version;
const expected = process.argv[3] || pkgVersion;
const shim = join(l.binDir, IS_WINDOWS ? "phi.cmd" : "phi");
if (!existsSync(shim)) {
	result("FAIL", `bin shim missing: ${shim}`);
	process.exit();
}
// A .cmd shim can only run through cmd.exe (shell); the arguments are constants.
const invoke = (args) => run(shim, args, { env: process.env, cwd: l.work, timeoutMs: 60_000, shell: IS_WINDOWS });

const problems = [];
const version = await invoke(["--version"]);
const versionOut = stripAnsi(version.output).trim();
console.log(`phi --version -> exit ${version.code}: ${versionOut}`);
if (version.code !== 0 || !versionOut.includes(expected)) problems.push(`--version printed "${versionOut}", expected ${expected}`);
if (pkgVersion !== expected) problems.push(`installed package is ${pkgVersion}, repo is ${expected}`);

const help = await invoke(["--help"]);
const helpOut = stripAnsi(help.output);
console.log(`phi --help -> exit ${help.code}, ${helpOut.length} chars`);
console.log(helpOut.split("\n").slice(0, 15).join("\n"));
if (help.code !== 0 || !/--model|--provider/.test(helpOut)) problems.push(`--help exit ${help.code} or unexpected output`);
if (/Error:|at .+\.js:\d+/.test(helpOut)) problems.push("--help printed an error/stack");

result(problems.length ? "FAIL" : "PASS", problems.length ? problems.join("; ") : `phi ${expected}, --help OK`);
