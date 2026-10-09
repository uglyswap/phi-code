/**
 * The postinstall skips the download when the Camoufox cache looks installed. It used to
 * trust version.json alone: a launcher removed afterwards (antivirus quarantine, partial
 * cleanup) left every browser launch failing with "Camoufox is not installed" while the
 * postinstall kept answering "already cached".
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

const SUPPORTED = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-ia32", "linux-x64", "win32-ia32", "win32-x64"];
const POSTINSTALL = join(import.meta.dirname, "..", "scripts", "postinstall.mjs");

let root: string;

/** Same layout as cacheRoot()/expectedDir() in scripts/postinstall.mjs, under the env set by runPostinstall(). */
function binDir(): string {
	const base =
		process.platform === "win32"
			? join(root, "local")
			: process.platform === "darwin"
				? join(root, "home", "Library", "Caches")
				: join(root, "xdg");
	return join(base, "phi-code", "camoufox", "v1.0.0", `${process.platform}-${process.arch}`, "camoufox-bin");
}

/** Same names as LAUNCH_FILE and getPath() in src/pkgman.ts. */
function launcher(): string {
	if (process.platform === "win32") return join(binDir(), "camoufox.exe");
	if (process.platform === "darwin") return join(binDir(), "Camoufox.app", "Contents", "MacOS", "camoufox");
	return join(binDir(), "camoufox-bin");
}

/** Runs the real postinstall with a fake cache root and no network; returns its stderr. */
function runPostinstall(): string {
	const noNetwork = join(root, "no-network.mjs");
	writeFileSync(noNetwork, 'globalThis.fetch = async () => { throw new Error("network disabled by the test"); };\n');
	const result = spawnSync(process.execPath, ["--import", pathToFileURL(noNetwork).href, POSTINSTALL], {
		encoding: "utf8",
		env: {
			...process.env,
			HOME: join(root, "home"),
			USERPROFILE: join(root, "home"),
			XDG_CACHE_HOME: join(root, "xdg"),
			LOCALAPPDATA: join(root, "local"),
			CAMOUFOX_SKIP_DOWNLOAD: "",
			CAMOUFOX_EXECUTABLE_PATH: "",
			CAMOFOX_EXECUTABLE_PATH: "",
			npm_config_offline: "",
		},
	});
	return result.stderr;
}

describe.skipIf(!SUPPORTED.includes(`${process.platform}-${process.arch}`))("postinstall cache check", () => {
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "camoufox-postinstall-"));
		mkdirSync(binDir(), { recursive: true });
		writeFileSync(join(binDir(), "version.json"), JSON.stringify({ version: "135.0.1", release: "beta.24" }));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	test("downloads again when version.json is there but the launcher is missing", () => {
		const stderr = runPostinstall();
		expect(stderr).not.toContain("already cached");
		expect(stderr).toContain("fetching SHA256SUMS");
	});

	test("skips the download when version.json and the launcher are both there", () => {
		mkdirSync(dirname(launcher()), { recursive: true });
		writeFileSync(launcher(), "");
		const stderr = runPostinstall();
		expect(stderr).toContain("already cached");
	});
});
