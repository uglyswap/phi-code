import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

/**
 * The postinstall scaffolds ~/.phi and must NEVER fail an install: npm rolls the
 * whole package back when a lifecycle script exits non-zero, so a defect here
 * makes phi uninstallable rather than merely unconfigured.
 *
 * The case that bit: an earlier install leaves a link in
 * ~/.phi/agent/extensions/node_modules/ and its target is later deleted. The old
 * code gated removal on existsSync, which follows the link and therefore reported
 * "absent"; symlinkSync then hit EEXIST and the copy fallback ran against the
 * dangling link, crashing the process (0xC0000409 on Windows) before any catch
 * could run.
 */
const postinstall = join(import.meta.dirname, "..", "packages", "coding-agent", "scripts", "postinstall.cjs");

/** Create a link at `linkPath` whose target does not exist. */
function makeDanglingLink(linkPath, targetPath) {
	mkdirSync(targetPath, { recursive: true });
	if (process.platform === "win32") {
		execFileSync("cmd", ["/c", "mklink", "/J", linkPath, targetPath], { stdio: "ignore" });
	} else {
		symlinkSync(targetPath, linkPath, "dir");
	}
	rmSync(targetPath, { recursive: true, force: true });
}

/** Run the postinstall with HOME pointed at a scratch directory. */
function runPostinstall(home) {
	return spawnSync(process.execPath, [postinstall], {
		cwd: join(import.meta.dirname, "..", "packages", "coding-agent"),
		encoding: "utf-8",
		timeout: 120_000,
		env: {
			...process.env,
			HOME: home,
			USERPROFILE: home,
			// The script opts out under CI, which is exactly what must not happen here.
			CI: "",
			PHI_SKIP_POSTINSTALL: "",
		},
	});
}

function withScratchHome(body) {
	const home = mkdtempSync(join(tmpdir(), "phi-postinstall-"));
	try {
		return body(home);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

test("succeeds on a home directory that has never seen phi", () => {
	withScratchHome((home) => {
		const result = runPostinstall(home);
		assert.equal(result.status, 0, `postinstall exited ${result.status}: ${result.stderr}`);
		assert.ok(existsSync(join(home, ".phi", "agent", "extensions")), "extensions were not installed");
	});
});

test("survives a link left by an earlier install whose target is gone", () => {
	withScratchHome((home) => {
		const nodeModules = join(home, ".phi", "agent", "extensions", "node_modules");
		mkdirSync(nodeModules, { recursive: true });
		for (const pkg of ["sigma-memory", "sigma-agents", "sigma-skills", "zod"]) {
			makeDanglingLink(join(nodeModules, pkg), join(home, "gone", pkg));
		}

		const result = runPostinstall(home);

		assert.equal(result.status, 0, `postinstall exited ${result.status}: ${result.stdout}${result.stderr}`);
	});
});

test("replaces a real directory sitting where a link belongs", () => {
	withScratchHome((home) => {
		const nodeModules = join(home, ".phi", "agent", "extensions", "node_modules");
		const squatter = join(nodeModules, "sigma-memory");
		mkdirSync(squatter, { recursive: true });
		writeFileSync(join(squatter, "stale.txt"), "left over\n");

		const result = runPostinstall(home);

		assert.equal(result.status, 0, `postinstall exited ${result.status}: ${result.stderr}`);
		assert.ok(!existsSync(join(squatter, "stale.txt")), "the stale directory was kept instead of replaced");
	});
});
