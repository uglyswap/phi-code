/**
 * syncBundledAssetsIfStale() re-runs scripts/postinstall.cjs when the agent dir does not
 * match the installed package: a stale version stamp, or an extensions/node_modules link
 * whose target is gone (an extension that cannot load is fatal without a UI). CI alone no
 * longer disables it (only PHI_SKIP_POSTINSTALL does), and concurrent processes sync once.
 */
import type * as ChildProcessModule from "node:child_process";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ConfigModule from "../src/config.ts";
import { BUNDLED_ASSETS_STAMP, syncBundledAssetsIfStale } from "../src/core/bundled-assets.ts";

const state = vi.hoisted(() => ({ packageDir: "", agentDir: "" }));
const spawnSyncMock = vi.hoisted(() => vi.fn());

vi.mock("../src/config.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof ConfigModule>();
	return {
		...actual,
		isBunBinary: false,
		VERSION: "9.9.9-test",
		getPackageDir: () => state.packageDir,
		getAgentDir: () => state.agentDir,
	};
});

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof ChildProcessModule>();
	return { ...actual, spawnSync: spawnSyncMock };
});

const require = createRequire(import.meta.url);

/** Another phi process: holds the sync lock, writes the stamp after 1.5 s, then releases it. */
const LOCK_HOLDER = `
const lockfile = require(process.argv[1]);
const { join } = require("node:path");
const { writeFileSync } = require("node:fs");
const agentDir = process.argv[2];
const release = lockfile.lockSync(agentDir, { realpath: false, stale: 90000, lockfilePath: join(agentDir, ".bundled-assets.lock") });
process.stdout.write("locked\\n");
setTimeout(() => {
	writeFileSync(join(agentDir, ".bundled-assets-version"), "9.9.9-test");
	release();
	process.exit(0);
}, 1500);
`;

let root: string;

function postinstallCalls(): unknown[][] {
	return spawnSyncMock.mock.calls.filter((call) =>
		String((call[1] as string[] | undefined)?.[0] ?? "").endsWith("postinstall.cjs"),
	);
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "bundled-assets-resync-"));
	state.packageDir = join(root, "package");
	state.agentDir = join(root, "agent");
	mkdirSync(join(state.packageDir, "scripts"), { recursive: true });
	writeFileSync(join(state.packageDir, "scripts", "postinstall.cjs"), "");
	mkdirSync(state.agentDir, { recursive: true });
	spawnSyncMock.mockReset();
	// vitest.config.ts sets PHI_SKIP_POSTINSTALL=1 for every test: undo it here.
	vi.stubEnv("PHI_SKIP_POSTINSTALL", undefined);
	vi.stubEnv("CI", undefined);
});

afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true });
});

describe("syncBundledAssetsIfStale", () => {
	it("does nothing when the stamp matches and no extension link is broken", () => {
		writeFileSync(join(state.agentDir, BUNDLED_ASSETS_STAMP), "9.9.9-test");
		syncBundledAssetsIfStale();
		expect(postinstallCalls()).toHaveLength(0);
	});

	it("re-runs the postinstall when an extensions/node_modules link no longer resolves", () => {
		writeFileSync(join(state.agentDir, BUNDLED_ASSETS_STAMP), "9.9.9-test");
		const target = join(root, "old-sigma-memory");
		mkdirSync(target, { recursive: true });
		writeFileSync(join(target, "package.json"), "{}");
		const modules = join(state.agentDir, "extensions", "node_modules");
		mkdirSync(modules, { recursive: true });
		symlinkSync(target, join(modules, "sigma-memory"), "junction");
		rmSync(target, { recursive: true, force: true });
		syncBundledAssetsIfStale();
		expect(postinstallCalls()).toHaveLength(1);
	});

	it("runs under CI and removes CI from the postinstall environment", () => {
		vi.stubEnv("CI", "true");
		syncBundledAssetsIfStale();
		const calls = postinstallCalls();
		expect(calls).toHaveLength(1);
		const options = calls[0]?.[2] as { env?: NodeJS.ProcessEnv };
		expect(options.env?.CI).toBeUndefined();
	});

	it("does nothing when PHI_SKIP_POSTINSTALL is set", () => {
		vi.stubEnv("PHI_SKIP_POSTINSTALL", "1");
		syncBundledAssetsIfStale();
		expect(postinstallCalls()).toHaveLength(0);
	});

	it("waits for a concurrent sync instead of running the postinstall again", async () => {
		const holder = spawn(process.execPath, ["-e", LOCK_HOLDER, require.resolve("proper-lockfile"), state.agentDir], {
			stdio: ["ignore", "pipe", "inherit"],
		});
		const exited = new Promise((resolveExit) => holder.once("exit", resolveExit));
		await new Promise<void>((resolveReady) => holder.stdout?.once("data", () => resolveReady()));
		const started = Date.now();
		syncBundledAssetsIfStale();
		const waited = Date.now() - started;
		expect(postinstallCalls()).toHaveLength(0);
		expect(waited).toBeGreaterThanOrEqual(500);
		await exited;
	}, 20000);
});
