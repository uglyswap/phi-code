/**
 * Runtime install of the camofox-browser server for phi builds that do not
 * ship it, i.e. the standalone Bun executable (GitHub Release archives).
 *
 * The server must run under the system Node.js (it is an Express +
 * Playwright app, engines node >= 22) and depends on native modules
 * (better-sqlite3...) built for that Node's ABI, so no prebuilt copy can be
 * embedded in the archive. On first use it is installed with the system
 * npm, at the version pinned by this package, into a stable directory under
 * the agent dir (`<agentDir>/runtime/browser`). A lock directory serialises
 * concurrent installs (several phi processes), and a marker written last
 * tells a complete install from an interrupted one.
 *
 * The npm install path never reaches this code: there the server is a
 * regular dependency and `require.resolve` finds it.
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";

export const SERVER_PACKAGE = "@phi-code-admin/camofox-browser";
export const MIN_NODE_MAJOR = 22;
/** Written once npm succeeded: { version, abi }. */
export const INSTALL_MARKER = ".phi-browser-runtime.json";
export const LOCK_DIR = ".install.lock";

const INSTALL_TIMEOUT_MS = 20 * 60_000;
/** Longer than an install may take: an older lock belongs to a dead install. */
const STALE_LOCK_MS = INSTALL_TIMEOUT_MS + 5 * 60_000;
const LOCK_POLL_MS = 500;
const OUTPUT_TAIL_LINES = 30;

export type ProgressListener = (message: string) => void;

/** How to run npm: `command ...prefixArgs <npm args>`. */
export interface NpmCommand {
	command: string;
	prefixArgs: string[];
	/** Needed when going through cmd.exe (arguments passed verbatim). */
	windowsVerbatimArguments?: boolean;
}

export interface NodeInfo {
	version: string;
	/** process.versions.modules: native addons are only valid for this ABI. */
	abi: string;
}

export interface RuntimeInstallOptions {
	installDir: string;
	nodeExecutable: string;
	onProgress?: ProgressListener;
	/** Defaults to the version this package depends on. */
	version?: string;
	/** Overrides for tests. */
	npm?: NpmCommand;
	nodeInfo?: NodeInfo;
	signal?: AbortSignal;
}

function isFile(candidate: string): boolean {
	try {
		return statSync(candidate).isFile();
	} catch {
		return false;
	}
}

function readJson(file: string): unknown {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
}

/**
 * The exact camofox-browser version this package requires (from its own
 * package.json, one level above dist/ or src/). Must be an exact version:
 * the runtime install has to match what the npm install would get.
 */
export function pinnedServerVersion(): string {
	const pkg = createRequire(import.meta.url)("../package.json") as { dependencies?: Record<string, string> };
	const version = pkg.dependencies?.[SERVER_PACKAGE];
	if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
		throw new Error(`@phi-code-admin/browser must pin an exact ${SERVER_PACKAGE} version (found ${version ?? "none"})`);
	}
	return version;
}

/** Throws the actionable error when the system Node is too old. */
export function assertSupportedNode(info: NodeInfo, nodeExecutable: string): void {
	const major = Number.parseInt(info.version.replace(/^v/, ""), 10);
	if (Number.isFinite(major) && major >= MIN_NODE_MAJOR) return;
	throw new Error(
		`The browser tools need Node.js >= ${MIN_NODE_MAJOR} to run the camofox-browser server, but ${nodeExecutable} ` +
			`is Node.js ${info.version}. Install a current Node.js LTS (https://nodejs.org), make sure it comes first ` +
			"on PATH, and restart phi (or set PHI_BROWSER_DISABLED=1 to hide the browser tools).",
	);
}

export function probeNode(nodeExecutable: string): NodeInfo {
	const result = spawnSync(nodeExecutable, ["-p", "JSON.stringify([process.versions.node, process.versions.modules])"], {
		encoding: "utf8",
		timeout: 30_000,
		windowsHide: true,
	});
	const parsed = result.status === 0 ? (JSON.parse(result.stdout.trim() || "null") as unknown) : undefined;
	if (!Array.isArray(parsed) || typeof parsed[0] !== "string" || typeof parsed[1] !== "string") {
		const reason = result.error?.message ?? (result.stderr || `exit code ${result.status}`).trim();
		throw new Error(`Could not run ${nodeExecutable} to check its version: ${reason}`);
	}
	return { version: parsed[0], abi: parsed[1] };
}

/**
 * npm's CLI script shipped with this Node: run with `node npm-cli.js`, it
 * needs no shell (npm.cmd on Windows cannot be spawned without one).
 * Windows layout: <nodeDir>/node_modules/npm; Unix: <prefix>/lib/node_modules/npm.
 */
export function findNpmCli(nodeExecutable: string): string | undefined {
	const bases = [nodeExecutable];
	try {
		bases.push(realpathSync(nodeExecutable));
	} catch {
		// keep the path as given
	}
	for (const base of bases) {
		const dir = path.dirname(base);
		for (const candidate of [
			path.join(dir, "node_modules", "npm", "bin", "npm-cli.js"),
			path.join(dir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
		]) {
			if (isFile(candidate)) return candidate;
		}
	}
	return undefined;
}

function findOnPath(name: string, pathValue: string | undefined, platform: NodeJS.Platform): string | undefined {
	const delimiter = platform === "win32" ? ";" : ":";
	for (const rawDir of (pathValue ?? "").split(delimiter)) {
		const dir = rawDir.replace(/^"(.*)"$/, "$1");
		if (!dir) continue;
		const candidate = path.join(dir, name);
		if (isFile(candidate)) return candidate;
	}
	return undefined;
}

export function resolveNpmCommand(
	nodeExecutable: string,
	pathValue: string | undefined = process.env.PATH,
	platform: NodeJS.Platform = process.platform,
): NpmCommand | undefined {
	const cli = findNpmCli(nodeExecutable);
	if (cli) return { command: nodeExecutable, prefixArgs: [cli] };
	if (platform !== "win32") {
		const npm = findOnPath("npm", pathValue, platform);
		return npm ? { command: npm, prefixArgs: [] } : undefined;
	}
	// Last resort on Windows: npm.cmd through cmd.exe. Only constant arguments
	// are passed (the install dir is the working directory), so nothing is
	// interpolated into the command line.
	if (!findOnPath("npm.cmd", pathValue, platform)) return undefined;
	return {
		command: process.env.ComSpec || "cmd.exe",
		prefixArgs: ["/d", "/s", "/c", "npm.cmd"],
		windowsVerbatimArguments: true,
	};
}

/**
 * Entry file of a complete runtime install of `version`, or undefined.
 * `abi`, when given, must match the ABI the native modules were built for.
 */
export function installedServerEntry(installDir: string, version: string, abi?: string): string | undefined {
	const marker = readJson(path.join(installDir, INSTALL_MARKER)) as { version?: unknown; abi?: unknown } | undefined;
	if (marker?.version !== version) return undefined;
	if (abi !== undefined && marker.abi !== abi) return undefined;
	try {
		const req = createRequire(path.join(installDir, "package.json"));
		const pkg = readJson(req.resolve(`${SERVER_PACKAGE}/package.json`)) as { version?: unknown } | undefined;
		if (pkg?.version !== version) return undefined;
		return req.resolve(SERVER_PACKAGE);
	} catch {
		return undefined;
	}
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM: the process exists but belongs to someone else.
		return errorCode(error) === "EPERM";
	}
}

function isStaleLock(lockDir: string): boolean {
	const owner = readJson(path.join(lockDir, "owner.json")) as { pid?: unknown; startedAt?: unknown } | undefined;
	let startedAt: number;
	if (typeof owner?.startedAt === "number") {
		startedAt = owner.startedAt;
	} else {
		// owner.json not written yet (lock just taken) or unreadable.
		try {
			startedAt = statSync(lockDir).mtimeMs;
		} catch {
			return false;
		}
	}
	if (Date.now() - startedAt > STALE_LOCK_MS) return true;
	return typeof owner?.pid === "number" && owner.pid !== process.pid && !isProcessAlive(owner.pid);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason);
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal?.reason);
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/** Runs `fn` while holding `<installDir>/.install.lock` (atomic mkdir). */
export async function withInstallLock<T>(
	installDir: string,
	fn: () => Promise<T>,
	onWait?: () => void,
	signal?: AbortSignal,
): Promise<T> {
	const lockDir = path.join(installDir, LOCK_DIR);
	let announced = false;
	for (;;) {
		try {
			mkdirSync(lockDir);
			break;
		} catch (error) {
			if (errorCode(error) !== "EEXIST") throw error;
		}
		if (isStaleLock(lockDir)) {
			rmSync(lockDir, { recursive: true, force: true });
			continue;
		}
		if (!announced) {
			announced = true;
			onWait?.();
		}
		await sleep(LOCK_POLL_MS, signal);
	}
	try {
		writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
		return await fn();
	} finally {
		rmSync(lockDir, { recursive: true, force: true });
	}
}

/** Same env as phi, with this Node first on PATH (npm lifecycle scripts run `node`). */
function npmEnvironment(nodeExecutable: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	// Windows spells it Path; a second PATH key would leave which one wins undefined.
	const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
	const delimiter = process.platform === "win32" ? ";" : ":";
	env[pathKey] = [path.dirname(nodeExecutable), env[pathKey]].filter(Boolean).join(delimiter);
	env.npm_config_update_notifier = "false";
	env.npm_config_fund = "false";
	env.npm_config_audit = "false";
	return env;
}

function runNpm(
	npm: NpmCommand,
	args: string[],
	options: { cwd: string; env: NodeJS.ProcessEnv; onLine: (line: string) => void; signal?: AbortSignal },
): Promise<{ code: number | null; tail: string[] }> {
	return new Promise((resolve, reject) => {
		const tail: string[] = [];
		const child = spawn(npm.command, [...npm.prefixArgs, ...args], {
			cwd: options.cwd,
			env: options.env,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
			windowsVerbatimArguments: npm.windowsVerbatimArguments,
		});
		const onData = (chunk: Buffer) => {
			for (const raw of chunk.toString().split(/\r?\n/)) {
				const line = raw.trim();
				if (!line) continue;
				tail.push(line);
				if (tail.length > OUTPUT_TAIL_LINES) tail.shift();
				options.onLine(line);
			}
		};
		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);
		const kill = () => {
			try {
				child.kill();
			} catch {
				// already gone
			}
		};
		const timer = setTimeout(() => {
			tail.push(`(npm killed after ${INSTALL_TIMEOUT_MS / 60_000} minutes)`);
			kill();
		}, INSTALL_TIMEOUT_MS);
		options.signal?.addEventListener("abort", kill, { once: true });
		child.on("error", (error) => {
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", kill);
			reject(new Error(`Could not start npm (${npm.command}): ${error.message}`));
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", kill);
			resolve({ code, tail });
		});
	});
}

/**
 * Path of the camofox-browser entry under `installDir`, installing it with the
 * npm of `nodeExecutable` first when needed. Throws an actionable error when
 * Node/npm are missing or too old, or when npm fails.
 */
function writeRuntimePackageJson(installDir: string, version: string): void {
	writeFileSync(
		path.join(installDir, "package.json"),
		`${JSON.stringify(
			{
				name: "phi-browser-runtime",
				private: true,
				description: "Managed by phi: the browser tools' server, installed on first use.",
				dependencies: { [SERVER_PACKAGE]: version },
			},
			null,
			2,
		)}\n`,
	);
}

interface RuntimeInstallContext {
	installDir: string;
	nodeExecutable: string;
	version: string;
	node: NodeInfo;
	npm: NpmCommand;
	manual: string;
	signal?: AbortSignal;
	onProgress: (message: string) => void;
}

/** npm install (plus a rebuild when the Node ABI changed since the previous install). */
async function runRuntimeNpmSteps(ctx: RuntimeInstallContext, previousAbi: unknown): Promise<void> {
	const env = npmEnvironment(ctx.nodeExecutable);
	const steps: string[][] = [["install", "--omit=dev", "--foreground-scripts", "--no-audit", "--no-fund"]];
	// Same package version, other Node ABI: rebuild the native modules.
	if (previousAbi !== undefined && previousAbi !== ctx.node.abi) steps.push(["rebuild", "--foreground-scripts"]);
	for (const args of steps) {
		const { code, tail } = await runNpm(ctx.npm, args, {
			cwd: ctx.installDir,
			env,
			signal: ctx.signal,
			onLine: (line) => ctx.onProgress(`npm: ${line}`),
		});
		ctx.signal?.throwIfAborted();
		if (code !== 0) {
			throw new Error(
				`Installing ${SERVER_PACKAGE}@${ctx.version} for the browser tools failed (npm ${args[0]} exited with ` +
					`code ${code}). Check your network or npm registry settings, then retry, or install it ` +
					`manually: ${ctx.manual}\nLast npm output:\n${tail.join("\n")}`,
			);
		}
	}
}

/** Runs under the install lock: (re)installs the pinned server and returns its entry. */
async function installRuntimeServer(ctx: RuntimeInstallContext): Promise<string> {
	const { installDir, version, node } = ctx;
	// Another process may have finished the install while we waited.
	const done = installedServerEntry(installDir, version, node.abi);
	if (done) return done;
	const previous = readJson(path.join(installDir, INSTALL_MARKER)) as { abi?: unknown } | undefined;
	rmSync(path.join(installDir, INSTALL_MARKER), { force: true });
	writeRuntimePackageJson(installDir, version);
	ctx.onProgress(
		`Installing the browser runtime (${SERVER_PACKAGE}@${version} and the Camoufox browser) with Node.js ` +
			`${node.version} into ${installDir}. First use only: this can take a few minutes.`,
	);
	await runRuntimeNpmSteps(ctx, previous?.abi);
	writeFileSync(path.join(installDir, INSTALL_MARKER), JSON.stringify({ version, abi: node.abi }));
	const entry = installedServerEntry(installDir, version, node.abi);
	if (!entry) {
		rmSync(path.join(installDir, INSTALL_MARKER), { force: true });
		throw new Error(`npm reported success but ${SERVER_PACKAGE}@${version} is not installed in ${installDir}`);
	}
	ctx.onProgress("Browser runtime installed.");
	return entry;
}

export async function ensureRuntimeServerEntry(options: RuntimeInstallOptions): Promise<string> {
	const { installDir, nodeExecutable, signal } = options;
	const onProgress = options.onProgress ?? (() => {});
	const version = options.version ?? pinnedServerVersion();
	const node = options.nodeInfo ?? probeNode(nodeExecutable);
	const ready = installedServerEntry(installDir, version, node.abi);
	if (ready) return ready;

	assertSupportedNode(node, nodeExecutable);
	const npm = options.npm ?? resolveNpmCommand(nodeExecutable);
	const manual = `cd "${installDir}" && npm install ${SERVER_PACKAGE}@${version}`;
	if (!npm) {
		throw new Error(
			`The browser tools must install ${SERVER_PACKAGE}@${version} on first use, but no npm was found next to ` +
				`${nodeExecutable} nor on PATH. Install Node.js >= ${MIN_NODE_MAJOR} with npm (https://nodejs.org) and ` +
				`restart phi, or install it manually: ${manual}`,
		);
	}

	mkdirSync(installDir, { recursive: true });
	const ctx: RuntimeInstallContext = { installDir, nodeExecutable, version, node, npm, manual, signal, onProgress };
	return await withInstallLock(
		installDir,
		() => installRuntimeServer(ctx),
		() => onProgress("Another phi process is installing the browser runtime, waiting for it to finish..."),
		signal,
	);
}
