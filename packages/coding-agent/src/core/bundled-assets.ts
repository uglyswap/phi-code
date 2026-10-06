/**
 * Keeps the bundled phi extensions, agents and skills copied into the agent dir
 * in sync with the installed package version.
 *
 * They are installed by `scripts/postinstall.cjs`, which does NOT run for
 * `phi update` (it installs with `--ignore-scripts`) nor for the documented
 * `npm install -g --ignore-scripts` install. Without this check an update left
 * the previous version's extensions in place, so their fixes never shipped.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, getPackageDir, isBunBinary, VERSION } from "../config.ts";

/** Written by scripts/postinstall.cjs once the copy succeeded. */
export const BUNDLED_ASSETS_STAMP = ".bundled-assets-version";

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
	// The standalone binary embeds its assets and has no node to run the script with.
	if (isBunBinary) return;
	if (readBundledAssetsStamp() === VERSION) return;
	const script = join(getPackageDir(), "scripts", "postinstall.cjs");
	if (!existsSync(script)) return;
	try {
		spawnSync(process.execPath, [script], { stdio: "ignore", env: process.env, timeout: 60_000 });
	} catch {
		// Ignore: the previous copies keep working; the next start retries.
	}
}
