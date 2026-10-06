#!/usr/bin/env node
// Usage: node scripts/install-smoke/install.mjs <runDir> <npmrc>
// `npm install -g @phi-code-admin/phi-code` from the local registry exactly as a
// new user would: install scripts ENABLED, fresh HOME and PHI_CODING_AGENT_DIR,
// no API key, CI unset (the postinstall skips its scaffolding under CI).
// Writes <runDir>/install.log and fails when npm fails or the postinstall did
// not run.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveNpmInvocation } from "../npm-command.mjs";
import { isolatedEnv, layout, run } from "./common.mjs";

const [runArg, npmrcArg] = process.argv.slice(2);
if (!runArg || !npmrcArg) {
	console.error("Usage: install.mjs <runDir> <npmrc>");
	process.exit(2);
}
const l = layout(runArg);
// No inherited npm_* / NPM_CONFIG_* variables (runner or `npm run` context):
// npm is resolved from the Node install itself, like a user's shell would.
const env = isolatedEnv(l.runDir);
for (const k of Object.keys(env)) if (/^npm_/i.test(k)) delete env[k];
const { command, prefixArgs } = resolveNpmInvocation(env);
const args = [
	...prefixArgs,
	"install",
	"-g",
	"@phi-code-admin/phi-code",
	"--prefix",
	l.prefix,
	"--userconfig",
	resolve(npmrcArg),
	"--cache",
	join(l.runDir, "npm-cache"),
	"--no-audit",
	"--no-fund",
	"--foreground-scripts",
];
console.log(`npm ${args.slice(prefixArgs.length).join(" ")}`);
const t0 = Date.now();
const res = await run(command, args, { env, cwd: l.work, timeoutMs: 25 * 60_000 });
writeFileSync(join(l.runDir, "install.log"), res.output);
console.log(res.output);
console.log(`npm exit=${res.code} signal=${res.signal} in ${Math.round((Date.now() - t0) / 1000)}s`);
if (res.code !== 0) {
	console.error("npm install -g failed");
	process.exit(1);
}
const problems = [];
if (!existsSync(l.cli)) problems.push(`CLI missing at ${l.cli}`);
const marker = join(l.agentDir, ".bundled-assets-version");
if (!existsSync(marker)) problems.push(`postinstall did not run: ${marker} missing`);
else {
	const version = JSON.parse(readFileSync(join(l.pkgDir, "package.json"), "utf8")).version;
	const recorded = readFileSync(marker, "utf8").trim();
	if (recorded !== version) problems.push(`postinstall recorded ${recorded}, package is ${version}`);
}
for (const sub of ["extensions", "skills", "agents"]) {
	if (!existsSync(join(l.agentDir, sub))) problems.push(`postinstall did not create ${join(l.agentDir, sub)}`);
}
if (/camoufox-js postinstall\].*(fail|error)/i.test(res.output)) {
	console.log("WARNING: the Camoufox download reported a problem (see above); the browser check will fail.");
}
if (problems.length > 0) {
	for (const p of problems) console.error(`FAIL ${p}`);
	process.exit(1);
}
console.log("install OK: CLI present, postinstall ran");
