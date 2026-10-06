// Shared helpers for the install smoke test (see .github/workflows/install-smoke.yml).
//
// A "run directory" holds one isolated global install:
//   <run>/prefix  npm global prefix (`npm install -g --prefix`)
//   <run>/home    fresh HOME / USERPROFILE (no ~/.phi, no npm config, no caches)
//   <run>/agent   PHI_CODING_AGENT_DIR (postinstall copies extensions/skills/agents here)
//   <run>/work    cwd for every phi process
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

export const IS_WINDOWS = process.platform === "win32";

export function layout(runDirArg) {
	const runDir = resolve(runDirArg);
	const prefix = join(runDir, "prefix");
	// npm's global layout differs: <prefix>/node_modules + shims in <prefix> on
	// Windows, <prefix>/lib/node_modules + <prefix>/bin elsewhere.
	const globalModules = IS_WINDOWS ? join(prefix, "node_modules") : join(prefix, "lib", "node_modules");
	const binDir = IS_WINDOWS ? prefix : join(prefix, "bin");
	const pkgDir = join(globalModules, "@phi-code-admin", "phi-code");
	const home = join(runDir, "home");
	return {
		runDir,
		prefix,
		globalModules,
		binDir,
		pkgDir,
		cli: join(pkgDir, "dist", "cli.js"),
		home,
		agentDir: join(runDir, "agent"),
		work: join(runDir, "work"),
		localAppData: join(home, "AppData", "Local"),
	};
}

// Anything that looks like a credential or a phi/pi setting from the runner is
// dropped: the install must work with no API key and no pre-existing config.
const DROPPED_ENV = /KEY|TOKEN|SECRET|PASSWORD|OPENAI|ANTHROPIC|Z_AI|GEMINI|GOOGLE|AWS|AZURE|^PHI_|^PI_|CLAUDE|^CI$|^XDG_/i;

/** Environment of a fresh user: isolated HOME, agent dir and caches, no secrets, no CI flag. */
export function isolatedEnv(runDirArg, extra = {}) {
	const l = layout(runDirArg);
	const env = {};
	for (const [k, v] of Object.entries(process.env)) {
		if (!DROPPED_ENV.test(k)) env[k] = v;
	}
	env.HOME = l.home;
	env.USERPROFILE = l.home;
	env.PHI_CODING_AGENT_DIR = l.agentDir;
	if (IS_WINDOWS) {
		env.LOCALAPPDATA = l.localAppData;
		env.APPDATA = join(l.home, "AppData", "Roaming");
	}
	const pathKey = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
	env[pathKey] = [l.binDir, env[pathKey]].filter(Boolean).join(IS_WINDOWS ? ";" : ":");
	for (const dir of [l.home, l.agentDir, l.work, ...(IS_WINDOWS ? [l.localAppData, env.APPDATA] : [])]) {
		mkdirSync(dir, { recursive: true });
	}
	return { ...env, ...extra };
}

/**
 * Runs a command (without a shell unless asked), captures stdout+stderr, kills it after
 * timeoutMs. Resolves { code, signal, output, timedOut }.
 */
export function run(command, args, { env, cwd, timeoutMs = 120_000, input, shell = false } = {}) {
	return new Promise((resolvePromise) => {
		const child = spawn(command, args, { env, cwd, stdio: ["pipe", "pipe", "pipe"], shell });
		let output = "";
		let timedOut = false;
		child.stdout.on("data", (d) => {
			output += d;
		});
		child.stderr.on("data", (d) => {
			output += d;
		});
		child.on("error", (error) => {
			output += `\n[spawn error] ${error.message}\n`;
		});
		if (input !== undefined) child.stdin.write(input);
		child.stdin.end();
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, timeoutMs);
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			resolvePromise({ code, signal, output, timedOut });
		});
	});
}

/** Removes ANSI escape sequences (CSI, OSC, single-char escapes). */
export function stripAnsi(text) {
	return text
		.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
		.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "")
		.replace(/\x1b[=>()][0-9A-Za-z]?/g, "");
}

/** Check result protocol: each check script ends with one line `RESULT <PASS|FAIL|SKIP> <message>`. */
export function result(status, message) {
	console.log(`RESULT ${status} ${message}`);
	process.exitCode = status === "FAIL" ? 1 : 0;
}
