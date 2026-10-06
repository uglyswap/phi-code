/**
 * FIX4-BINBROWSER: first-use install of the camofox-browser server for the
 * standalone Bun executable, which ships @phi-code-admin/browser without it
 * (packages/browser/src/server-runtime.ts). npm is faked by a script run with
 * the real Node, so no network is used.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	assertSupportedNode,
	ensureRuntimeServerEntry,
	findNpmCli,
	INSTALL_MARKER,
	installedServerEntry,
	LOCK_DIR,
	type NpmCommand,
	pinnedServerVersion,
	resolveNpmCommand,
	SERVER_PACKAGE,
} from "../../browser/src/server-runtime.ts";

const browserPackageJson = JSON.parse(
	readFileSync(join(import.meta.dirname, "..", "..", "browser", "package.json"), "utf8"),
) as { dependencies: Record<string, string> };

// Fake `npm-cli.js`: records each call, installs a stub server for `install`.
const FAKE_NPM = `
const fs = require("fs");
const path = require("path");
const cmd = process.argv[2];
fs.appendFileSync(path.join(process.cwd(), "npm-calls.log"), cmd + "\\n");
console.log("fake npm " + cmd);
const exit = Number(process.env.FIX4_FAKE_NPM_EXIT || 0);
setTimeout(() => {
	if (exit === 0 && cmd === "install") {
		const version = JSON.parse(fs.readFileSync("package.json", "utf8")).dependencies["${SERVER_PACKAGE}"];
		const dir = path.join("node_modules", "@phi-code-admin", "camofox-browser");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "${SERVER_PACKAGE}", version, main: "server.js" }));
		fs.writeFileSync(path.join(dir, "server.js"), "");
	}
	if (exit !== 0) console.error("npm error code E404");
	process.exit(exit);
}, 200);
`;

const NODE = { version: "22.20.0", abi: "127" };

let root: string;
let installDir: string;
let npm: NpmCommand;

function npmCalls(): string[] {
	const log = join(installDir, "npm-calls.log");
	return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "fix4-binbrowser-"));
	installDir = join(root, "agent", "runtime", "browser");
	const cli = join(root, "fake-npm-cli.cjs");
	writeFileSync(cli, FAKE_NPM);
	npm = { command: process.execPath, prefixArgs: [cli] };
	delete process.env.FIX4_FAKE_NPM_EXIT;
});

afterEach(() => {
	delete process.env.FIX4_FAKE_NPM_EXIT;
	rmSync(root, { recursive: true, force: true });
});

describe("pinned server version", () => {
	it("is the exact version @phi-code-admin/browser depends on", () => {
		expect(pinnedServerVersion()).toBe(browserPackageJson.dependencies[SERVER_PACKAGE]);
		expect(pinnedServerVersion()).toMatch(/^\d+\.\d+\.\d+$/);
	});
});

describe("node and npm discovery", () => {
	it("requires Node.js >= 22 with an actionable message", () => {
		expect(() => assertSupportedNode({ version: "20.11.1", abi: "115" }, "C:\\node\\node.exe")).toThrow(
			/Node\.js >= 22.*C:\\node\\node\.exe.*20\.11\.1.*PHI_BROWSER_DISABLED/s,
		);
		expect(() => assertSupportedNode({ version: "22.0.0", abi: "127" }, "node")).not.toThrow();
		expect(() => assertSupportedNode({ version: "24.1.0", abi: "137" }, "node")).not.toThrow();
	});

	it("finds npm-cli.js next to node (Windows layout) and under lib/ (Unix layout)", () => {
		const win = join(root, "win");
		mkdirSync(join(win, "node_modules", "npm", "bin"), { recursive: true });
		writeFileSync(join(win, "node.exe"), "");
		writeFileSync(join(win, "node_modules", "npm", "bin", "npm-cli.js"), "");
		expect(findNpmCli(join(win, "node.exe"))).toBe(join(win, "node_modules", "npm", "bin", "npm-cli.js"));

		const unix = join(root, "usr");
		mkdirSync(join(unix, "bin"), { recursive: true });
		mkdirSync(join(unix, "lib", "node_modules", "npm", "bin"), { recursive: true });
		writeFileSync(join(unix, "bin", "node"), "");
		writeFileSync(join(unix, "lib", "node_modules", "npm", "bin", "npm-cli.js"), "");
		expect(findNpmCli(join(unix, "bin", "node"))).toBe(
			join(unix, "bin", "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
		);

		expect(findNpmCli(join(root, "nowhere", "node"))).toBeUndefined();
	});

	it("runs npm-cli.js with node (no shell), falls back to npm.cmd through cmd.exe on Windows", () => {
		const win = join(root, "win");
		mkdirSync(join(win, "node_modules", "npm", "bin"), { recursive: true });
		writeFileSync(join(win, "node_modules", "npm", "bin", "npm-cli.js"), "");
		expect(resolveNpmCommand(join(win, "node.exe"), "", "win32")).toEqual({
			command: join(win, "node.exe"),
			prefixArgs: [join(win, "node_modules", "npm", "bin", "npm-cli.js")],
		});

		const shims = join(root, "shims");
		mkdirSync(shims);
		writeFileSync(join(shims, "npm.cmd"), "");
		const fallback = resolveNpmCommand(join(root, "other", "node.exe"), shims, "win32");
		expect(fallback?.prefixArgs).toEqual(["/d", "/s", "/c", "npm.cmd"]);
		expect(fallback?.windowsVerbatimArguments).toBe(true);

		expect(resolveNpmCommand(join(root, "other", "node.exe"), join(root, "empty"), "win32")).toBeUndefined();
		expect(resolveNpmCommand(join(root, "other", "node"), join(root, "empty"), "linux")).toBeUndefined();
	});
});

describe("ensureRuntimeServerEntry", () => {
	it("installs the pinned version once, reports progress, then reuses it", async () => {
		const progress: string[] = [];
		const entry = await ensureRuntimeServerEntry({
			installDir,
			nodeExecutable: process.execPath,
			version: "1.1.3",
			npm,
			nodeInfo: NODE,
			onProgress: (message) => progress.push(message),
		});
		expect(entry).toBe(join(installDir, "node_modules", "@phi-code-admin", "camofox-browser", "server.js"));
		const manifest = JSON.parse(readFileSync(join(installDir, "package.json"), "utf8"));
		expect(manifest.dependencies).toEqual({ [SERVER_PACKAGE]: "1.1.3" });
		expect(JSON.parse(readFileSync(join(installDir, INSTALL_MARKER), "utf8"))).toEqual({
			version: "1.1.3",
			abi: "127",
		});
		expect(existsSync(join(installDir, LOCK_DIR))).toBe(false);
		expect(progress[0]).toMatch(/Installing the browser runtime .*1\.1\.3.*Node\.js 22\.20\.0/);
		expect(progress).toContain("npm: fake npm install");
		expect(progress.at(-1)).toBe("Browser runtime installed.");

		await ensureRuntimeServerEntry({
			installDir,
			nodeExecutable: process.execPath,
			version: "1.1.3",
			npm,
			nodeInfo: NODE,
		});
		expect(npmCalls()).toEqual(["install"]);
	});

	it("serialises concurrent installs: npm runs once, the other caller waits", async () => {
		const progress: string[] = [];
		const options = {
			installDir,
			nodeExecutable: process.execPath,
			version: "1.1.3",
			npm,
			nodeInfo: NODE,
			onProgress: (message: string) => progress.push(message),
		};
		const [a, b] = await Promise.all([ensureRuntimeServerEntry(options), ensureRuntimeServerEntry(options)]);
		expect(a).toBe(b);
		expect(npmCalls()).toEqual(["install"]);
		expect(progress).toContain("Another phi process is installing the browser runtime, waiting for it to finish...");
	});

	it("takes over the lock of a dead process", async () => {
		mkdirSync(join(installDir, LOCK_DIR), { recursive: true });
		writeFileSync(
			join(installDir, LOCK_DIR, "owner.json"),
			JSON.stringify({ pid: 2 ** 22 + 12345, startedAt: Date.now() }),
		);
		await ensureRuntimeServerEntry({
			installDir,
			nodeExecutable: process.execPath,
			version: "1.1.3",
			npm,
			nodeInfo: NODE,
		});
		expect(npmCalls()).toEqual(["install"]);
	});

	it("fails with npm's output and the manual command, and leaves no marker", async () => {
		process.env.FIX4_FAKE_NPM_EXIT = "1";
		const error = await ensureRuntimeServerEntry({
			installDir,
			nodeExecutable: process.execPath,
			version: "1.1.3",
			npm,
			nodeInfo: NODE,
		}).catch((e: unknown) => e as Error);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toMatch(/npm install exited with code 1/);
		expect((error as Error).message).toContain(`npm install ${SERVER_PACKAGE}@1.1.3`);
		expect((error as Error).message).toContain("npm error code E404");
		expect(existsSync(join(installDir, INSTALL_MARKER))).toBe(false);
		expect(existsSync(join(installDir, LOCK_DIR))).toBe(false);
		expect(installedServerEntry(installDir, "1.1.3")).toBeUndefined();
	});

	it("rebuilds the native modules when the system Node's ABI changed", async () => {
		await ensureRuntimeServerEntry({
			installDir,
			nodeExecutable: process.execPath,
			version: "1.1.3",
			npm,
			nodeInfo: NODE,
		});
		await ensureRuntimeServerEntry({
			installDir,
			nodeExecutable: process.execPath,
			version: "1.1.3",
			npm,
			nodeInfo: { version: "24.1.0", abi: "137" },
		});
		expect(npmCalls()).toEqual(["install", "install", "rebuild"]);
		expect(JSON.parse(readFileSync(join(installDir, INSTALL_MARKER), "utf8")).abi).toBe("137");
	});

	it("refuses a too old Node before running npm", async () => {
		await expect(
			ensureRuntimeServerEntry({
				installDir,
				nodeExecutable: process.execPath,
				version: "1.1.3",
				npm,
				nodeInfo: { version: "18.19.0", abi: "108" },
			}),
		).rejects.toThrow(/Node\.js >= 22/);
		expect(npmCalls()).toEqual([]);
	});

	it("ignores an interrupted install (package present, no marker)", async () => {
		const dir = join(installDir, "node_modules", "@phi-code-admin", "camofox-browser");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(installDir, "package.json"), "{}");
		writeFileSync(
			join(dir, "package.json"),
			JSON.stringify({ name: SERVER_PACKAGE, version: "1.1.3", main: "server.js" }),
		);
		writeFileSync(join(dir, "server.js"), "");
		expect(installedServerEntry(installDir, "1.1.3")).toBeUndefined();
		writeFileSync(join(installDir, INSTALL_MARKER), JSON.stringify({ version: "1.1.3", abi: "127" }));
		expect(installedServerEntry(installDir, "1.1.3", "127")).toBe(join(dir, "server.js"));
		expect(installedServerEntry(installDir, "1.1.4", "127")).toBeUndefined();
	});
});
