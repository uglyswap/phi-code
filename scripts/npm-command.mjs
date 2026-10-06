import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Resolve how to spawn npm without a shell.
 *
 * On Windows `npm` is `npm.cmd`, and since the CVE-2024-27980 fix Node refuses
 * to spawn a .cmd/.bat file without `shell: true` (spawnSync fails with EINVAL,
 * status null). Running npm's JavaScript entry point with the current Node avoids
 * both the shell and argument re-quoting.
 */
export function resolveNpmInvocation(env = process.env, platform = process.platform, execPath = process.execPath) {
	if (platform !== "win32") {
		return { command: "npm", prefixArgs: [] };
	}
	const candidates = [
		// Set by npm itself when the script runs through `npm run`.
		env.npm_execpath,
		// Standard Node.js for Windows layout: npm ships next to node.exe.
		join(dirname(execPath), "node_modules", "npm", "bin", "npm-cli.js"),
	];
	for (const candidate of candidates) {
		if (candidate && /npm-cli\.js$/i.test(candidate) && existsSync(candidate)) {
			return { command: execPath, prefixArgs: [candidate] };
		}
	}
	throw new Error(
		"Cannot locate npm-cli.js to run npm without a shell on Windows. Run this script through `npm run`, or use the Node.js installation that bundles npm.",
	);
}

/** spawnSync npm with the given arguments (never through a shell). */
export function spawnNpmSync(args, options = {}) {
	const { command, prefixArgs } = resolveNpmInvocation();
	return spawnSync(command, [...prefixArgs, ...args], { ...options, shell: false });
}
