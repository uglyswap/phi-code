/**
 * Keeps the bundled phi extensions, agents and skills copied into the agent dir
 * in sync with the installed package version.
 *
 * They are installed by `scripts/postinstall.cjs`, which does NOT run for
 * `phi update` (it installs with `--ignore-scripts`) nor for the documented
 * `npm install -g --ignore-scripts` install. Without this check an update left
 * the previous version's extensions in place, so their fixes never shipped.
 *
 * The standalone Bun binary never runs postinstall either, and has no node to
 * run it with: process.execPath is the phi executable itself. Its archive stages
 * extensions/phi, agents, skills and the extensions' npm dependencies next to the
 * executable (scripts/build-binaries.sh), and the binary copies them in-process.
 */

import { spawnSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmdirSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir, getPackageDir, isBunBinary, VERSION } from "../config.ts";

/** Written by scripts/postinstall.cjs once the copy succeeded. */
export const BUNDLED_ASSETS_STAMP = ".bundled-assets-version";

/**
 * Non phi-internal npm packages the bundled extensions import (typebox and
 * phi-code* resolve through the loader's virtual modules). Keep in sync with
 * `extensionDeps` in scripts/postinstall.cjs and EXTENSION_DEPS in
 * scripts/build-binaries.sh.
 */
export const BUNDLED_EXTENSION_DEPS = [
	"sigma-memory",
	"sigma-agents",
	"sigma-skills",
	"zod",
	"@modelcontextprotocol/sdk",
	"@ast-grep/napi",
	"cross-spawn",
	"ignore",
] as const;

export function readBundledAssetsStamp(agentDir: string = getAgentDir()): string | undefined {
	try {
		return readFileSync(join(agentDir, BUNDLED_ASSETS_STAMP), "utf8").trim() || undefined;
	} catch {
		return undefined;
	}
}

/**
 * Re-run the postinstall copy when the stamp does not match this version.
 * Best effort: never throws, never blocks startup on failure.
 */
export function syncBundledAssetsIfStale(): void {
	if (process.env.PHI_SKIP_POSTINSTALL || process.env.CI) return;
	if (readBundledAssetsStamp() === VERSION) return;
	if (isBunBinary) {
		syncBundledAssetsFromBinaryDir(getPackageDir(), getAgentDir());
		return;
	}
	const script = join(getPackageDir(), "scripts", "postinstall.cjs");
	if (!existsSync(script)) return;
	try {
		spawnSync(process.execPath, [script], { stdio: "ignore", env: process.env, timeout: 60_000 });
	} catch {
		// Ignore: the previous copies keep working; the next start retries.
	}
}

/**
 * In-process equivalent of postinstall steps 1, 2 and 5 for the Bun binary:
 * copy extensions/phi, agents and skills from the archive into the agent dir,
 * link the extensions' npm dependencies shipped in <archive>/node_modules, then
 * write the version stamp. The stamp is only written when every copy succeeded,
 * so a partial failure is retried on the next start.
 */
export function syncBundledAssetsFromBinaryDir(packageDir: string, agentDir: string): void {
	const copies = [
		{ src: join(packageDir, "extensions", "phi"), dest: join(agentDir, "extensions") },
		{ src: join(packageDir, "agents"), dest: join(agentDir, "agents") },
		{ src: join(packageDir, "skills"), dest: join(agentDir, "skills") },
	];
	let ok = true;
	for (const { src, dest } of copies) {
		if (!existsSync(src)) continue;
		try {
			mkdirSync(dest, { recursive: true });
			for (const entry of readdirSync(src)) {
				cpSync(join(src, entry), join(dest, entry), { recursive: true, force: true });
			}
		} catch {
			ok = false;
		}
	}

	const sourceModules = join(packageDir, "node_modules");
	const extensionsModules = join(agentDir, "extensions", "node_modules");
	for (const pkg of BUNDLED_EXTENSION_DEPS) {
		const src = join(sourceModules, pkg);
		if (!existsSync(src)) continue;
		if (!linkPackage(src, join(extensionsModules, pkg))) ok = false;
	}

	if (!ok) return;
	try {
		writeFileSync(join(agentDir, BUNDLED_ASSETS_STAMP), VERSION, "utf8");
	} catch {
		// Next start retries.
	}
}

/**
 * Junction (no admin rights needed on Windows) to the package shipped next to
 * the executable, so its own dependencies resolve from the archive's node_modules.
 * Falls back to a copy, like postinstall.cjs.
 */
function linkPackage(src: string, dest: string): boolean {
	try {
		mkdirSync(dirname(dest), { recursive: true });
		removeExisting(dest);
		try {
			symlinkSync(src, dest, "junction");
		} catch {
			cpSync(src, dest, { recursive: true, force: true });
		}
		return true;
	} catch {
		return false;
	}
}

/** Same semantics as removeExisting() in postinstall.cjs (handles dangling junctions). */
function removeExisting(dest: string): void {
	let isLink: boolean;
	try {
		isLink = lstatSync(dest).isSymbolicLink();
	} catch {
		return;
	}
	if (isLink) {
		try {
			unlinkSync(dest);
			return;
		} catch {
			// try rmdir below
		}
		try {
			rmdirSync(dest);
			return;
		} catch {
			// fall through
		}
	}
	rmSync(dest, { recursive: true, force: true });
}
