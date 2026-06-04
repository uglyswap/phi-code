#!/usr/bin/env node
/**
 * @phi-code-admin/camoufox-js postinstall
 *
 * Downloads the Camoufox v135.0.1-beta.24 binary matching the host
 * platform/arch from the uglyswap/phi-code GitHub Release
 * `binaries-v1.0.0`. The archive is extracted into a versioned cache:
 *
 *   Linux  ~/.cache/phi-code/camoufox/v1.0.0/<platform>-<arch>/
 *   macOS  ~/Library/Caches/phi-code/camoufox/v1.0.0/<platform>-<arch>/
 *   Win    %LOCALAPPDATA%\phi-code\camoufox\v1.0.0\<platform>-<arch>\
 *
 * Design (per phi-code vendoring spec, Phase 3):
 *   - **Never fails the install.** Exit code is ALWAYS 0; a download
 *     failure prints a warning + a one-line `npx @phi-code-admin/camoufox-js
 *     fetch` retry command, but `npm install` succeeds. This way phi-code
 *     stays installable behind corporate firewalls; the browser feature
 *     simply errors on first use until the user retries the fetch.
 *   - **Skip if cached.** If the matching extracted tree exists AND its
 *     `version.json` reports the expected release, the script is a no-op.
 *   - **Checksum verified.** Each archive is verified against the
 *     SHA256SUMS file from the same GitHub Release before extraction.
 *   - **No third-party URL.** The release is hosted on
 *     github.com/uglyswap/phi-code; the upstream daijro/camoufox URL is
 *     never contacted at runtime.
 *   - **Env override.** `CAMOUFOX_EXECUTABLE_PATH=/path/to/camoufox.exe`
 *     short-circuits the download (useful in air-gapped CI / Docker).
 *
 * Disable with `CAMOUFOX_SKIP_DOWNLOAD=1` or `npm install --ignore-scripts`.
 */

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform as osPlatform, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import AdmZip from "adm-zip";

const RELEASE_TAG = "binaries-v1.0.0";
const UPSTREAM_VERSION = "135.0.1";
const UPSTREAM_RELEASE = "beta.24";
const RELEASE_URL_BASE = `https://github.com/uglyswap/phi-code/releases/download/${RELEASE_TAG}`;

const ZIP_BY_PLATFORM = {
	"darwin-arm64": "camoufox-135.0.1-beta.24-mac.arm64.zip",
	"darwin-x64": "camoufox-135.0.1-beta.24-mac.x86_64.zip",
	"linux-arm64": "camoufox-135.0.1-beta.24-lin.arm64.zip",
	"linux-ia32": "camoufox-135.0.1-beta.24-lin.i686.zip",
	"linux-x64": "camoufox-135.0.1-beta.24-lin.x86_64.zip",
	"win32-ia32": "camoufox-135.0.1-beta.24-win.i686.zip",
	"win32-x64": "camoufox-135.0.1-beta.24-win.x86_64.zip",
};

function log(line) {
	process.stderr.write(`[camoufox-js postinstall] ${line}\n`);
}

function isDisabled() {
	const flag = process.env.CAMOUFOX_SKIP_DOWNLOAD;
	if (flag === "1" || flag === "true" || flag === "yes") return true;
	// npm sets npm_config_offline=true when --offline is in effect; respect it.
	if (process.env.npm_config_offline === "true") return true;
	return false;
}

function cacheRoot() {
	const home = homedir();
	const plat = osPlatform();
	if (plat === "darwin") return join(home, "Library", "Caches", "phi-code", "camoufox", "v1.0.0");
	if (plat === "win32") {
		const local = process.env.LOCALAPPDATA || join(home, "AppData", "Local");
		return join(local, "phi-code", "camoufox", "v1.0.0");
	}
	const xdg = process.env.XDG_CACHE_HOME || join(home, ".cache");
	return join(xdg, "phi-code", "camoufox", "v1.0.0");
}

function platformKey() {
	return `${process.platform}-${process.arch}`;
}

function expectedDir() {
	return join(cacheRoot(), platformKey());
}

function isAlreadyInstalled() {
	const dir = expectedDir();
	const versionFile = join(dir, "camoufox-bin", "version.json");
	if (!existsSync(versionFile)) return false;
	try {
		const parsed = JSON.parse(readFileSync(versionFile, "utf-8"));
		return parsed?.version === UPSTREAM_VERSION && parsed?.release === UPSTREAM_RELEASE;
	} catch {
		return false;
	}
}

async function downloadToFile(url, destPath) {
	const res = await fetch(url, { redirect: "follow" });
	if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
	if (!res.body) throw new Error(`empty body for ${url}`);
	mkdirSync(dirname(destPath), { recursive: true });
	const sink = createWriteStream(destPath);
	await pipeline(res.body, sink);
}

function sha256Of(filePath) {
	const buf = readFileSync(filePath);
	return createHash("sha256").update(buf).digest("hex");
}

async function fetchSumsMap() {
	const url = `${RELEASE_URL_BASE}/SHA256SUMS`;
	const res = await fetch(url);
	if (!res.ok) throw new Error(`HTTP ${res.status} for SHA256SUMS`);
	const text = await res.text();
	const map = new Map();
	for (const line of text.split(/\r?\n/)) {
		const match = line.match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
		if (match) map.set(match[2].trim(), match[1].toLowerCase());
	}
	return map;
}

function unzipTo(zipPath, destDir) {
	// Extract with adm-zip (no shell) to avoid command-injection via paths
	// that contain quotes/metacharacters (e.g. a Windows user "O'Brien" or an
	// attacker-influenced LOCALAPPDATA/TMP). adm-zip 0.5.16+ is path-traversal
	// hardened, and the archive itself is SHA256-verified before this call.
	mkdirSync(destDir, { recursive: true });
	const zip = new AdmZip(zipPath);
	zip.extractAllTo(destDir, /* overwrite */ true);
}

function writeSyntheticVersionJson(binDir) {
	const versionFile = join(binDir, "version.json");
	if (existsSync(versionFile)) return;
	writeFileSync(
		versionFile,
		`${JSON.stringify({ version: UPSTREAM_VERSION, release: UPSTREAM_RELEASE }, null, 2)}\n`,
		"utf-8",
	);
	if (process.platform === "darwin") {
		const resources = join(binDir, "Camoufox.app", "Contents", "Resources");
		if (existsSync(resources)) {
			const resVersion = join(resources, "version.json");
			if (!existsSync(resVersion)) {
				writeFileSync(
					resVersion,
					`${JSON.stringify({ version: UPSTREAM_VERSION, release: UPSTREAM_RELEASE }, null, 2)}\n`,
					"utf-8",
				);
			}
		}
	}
}

async function main() {
	// Honour explicit external binaries — used by air-gapped users.
	if (process.env.CAMOUFOX_EXECUTABLE_PATH || process.env.CAMOFOX_EXECUTABLE_PATH) {
		log("CAMOUFOX_EXECUTABLE_PATH set — skipping download.");
		return;
	}
	if (isDisabled()) {
		log("download disabled (CAMOUFOX_SKIP_DOWNLOAD or --offline). Skipping.");
		return;
	}

	const key = platformKey();
	const zipName = ZIP_BY_PLATFORM[key];
	if (!zipName) {
		log(`platform "${key}" is not supported (no bundled binary). Skipping. Build Camoufox from source if needed.`);
		return;
	}

	if (isAlreadyInstalled()) {
		log(`v${UPSTREAM_VERSION}-${UPSTREAM_RELEASE} already cached at ${expectedDir()}`);
		return;
	}

	const dest = expectedDir();
	const binDir = join(dest, "camoufox-bin");
	const tmpZip = join(tmpdir(), `phi-code-${zipName}-${process.pid}.zip`);

	try {
		log(`fetching SHA256SUMS from ${RELEASE_URL_BASE}/SHA256SUMS`);
		const sums = await fetchSumsMap();
		const expected = sums.get(zipName);
		if (!expected) {
			log(`SHA256SUMS does not list ${zipName} (release may still be uploading). Skipping.`);
			return;
		}

		log(`downloading ${zipName} (~hundreds of MB; first install only)`);
		await downloadToFile(`${RELEASE_URL_BASE}/${zipName}`, tmpZip);
		const actual = sha256Of(tmpZip);
		if (actual.toLowerCase() !== expected.toLowerCase()) {
			throw new Error(`SHA256 mismatch for ${zipName}: expected ${expected}, got ${actual}`);
		}

		log(`extracting into ${binDir}`);
		// Clean any partial extraction first.
		if (existsSync(binDir)) rmSync(binDir, { recursive: true, force: true });
		unzipTo(tmpZip, binDir);
		writeSyntheticVersionJson(binDir);

		if (process.platform !== "win32") {
			try {
				execSync(`chmod -R 755 "${binDir}"`);
			} catch {
				/* non-fatal */
			}
		}

		log(`OK: ${binDir}`);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		log(`download failed: ${message}`);
		log(`phi-code will install successfully, but the browser tools will error on first use.`);
		log(`retry with: npx @phi-code-admin/camoufox-js fetch`);
	} finally {
		if (existsSync(tmpZip)) {
			try {
				rmSync(tmpZip, { force: true });
			} catch {
				/* no-op */
			}
		}
	}
}

main().catch((err) => {
	process.stderr.write(`[camoufox-js postinstall] unexpected error: ${err}\n`);
	// Never fail the install.
	process.exit(0);
});
