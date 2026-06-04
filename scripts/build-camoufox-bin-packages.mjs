#!/usr/bin/env node
/**
 * scripts/build-camoufox-bin-packages.mjs
 *
 * Splits the seven Camoufox v135.0.1-beta.24 zip archives downloaded into
 * `.binaries-cache/` into seven npm-publishable packages under
 * `packages/camoufox-bin-<platform>-<arch>/`. Each package:
 *
 *   - is named `@phi-code-admin/camoufox-bin-<platform>-<arch>`
 *   - has `os: [...]` + `cpu: [...]` filters so npm only resolves it on the
 *     matching host (esbuild pattern)
 *   - contains the extracted Camoufox tree under `camoufox-bin/`
 *   - keeps the upstream MPL-2.0 LICENSE next to the binary
 *   - is `private: false` and `publishConfig.access: public`
 *
 * The extracted `camoufox-bin/` directory is gitignored (~300 MB per
 * platform) — only the package.json + README.md + LICENSE live in git.
 * The binary is added at publish time by this script.
 *
 * Idempotent: re-running the script overwrites the extracted tree. README.md /
 * VENDORED_FROM.md are preserved if present (manual fixes survive), but
 * package.json is regenerated every run (the publish-critical metadata is
 * merged over any existing file) so the committed metadata cannot silently
 * diverge from buildPackageJson() — e.g. a stale `private: true` blocking publish.
 *
 * Usage:
 *   node scripts/build-camoufox-bin-packages.mjs           # all platforms
 *   node scripts/build-camoufox-bin-packages.mjs win32-x64 # one platform
 *
 * Requires:
 *   - `.binaries-cache/camoufox-135.0.1-beta.24-<os>.<arch>.zip` files
 *     (downloaded via `gh release download v135.0.1-beta.24 -R daijro/camoufox`)
 *   - Node >= 20 (uses unzipper from npm or local `unzip`/PowerShell fallback)
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CACHE_DIR = path.join(ROOT, ".binaries-cache");
const PACKAGES_DIR = path.join(ROOT, "packages");

// Mapping: how to translate the daijro `<os>.<arch>` zip suffix to the
// node `<platform>-<arch>` tuple used in our package names.
const PLATFORMS = [
	{ pkg: "camoufox-bin-darwin-arm64", zipSuffix: "mac.arm64", os: "darwin", cpu: "arm64", appDir: "Camoufox.app", launch: "Camoufox.app/Contents/MacOS/camoufox" },
	{ pkg: "camoufox-bin-darwin-x64",   zipSuffix: "mac.x86_64", os: "darwin", cpu: "x64",   appDir: "Camoufox.app", launch: "Camoufox.app/Contents/MacOS/camoufox" },
	{ pkg: "camoufox-bin-linux-arm64",  zipSuffix: "lin.arm64",  os: "linux",  cpu: "arm64", appDir: ".",            launch: "camoufox-bin" },
	{ pkg: "camoufox-bin-linux-ia32",   zipSuffix: "lin.i686",   os: "linux",  cpu: "ia32",  appDir: ".",            launch: "camoufox-bin" },
	{ pkg: "camoufox-bin-linux-x64",    zipSuffix: "lin.x86_64", os: "linux",  cpu: "x64",   appDir: ".",            launch: "camoufox-bin" },
	{ pkg: "camoufox-bin-win32-ia32",   zipSuffix: "win.i686",   os: "win32",  cpu: "ia32",  appDir: ".",            launch: "camoufox.exe" },
	{ pkg: "camoufox-bin-win32-x64",    zipSuffix: "win.x86_64", os: "win32",  cpu: "x64",   appDir: ".",            launch: "camoufox.exe" },
];

const ZIP_BASE = "camoufox-135.0.1-beta.24";
const PACKAGE_VERSION = "1.0.0";
const UPSTREAM_VERSION = "135.0.1";
const UPSTREAM_RELEASE = "beta.24";

function unzip(zipPath, destDir) {
	fs.mkdirSync(destDir, { recursive: true });
	// On Windows Node runtimes we use PowerShell's Expand-Archive (built-in,
	// no extra dep). Elsewhere we use `unzip`. Both preserve permissions
	// well enough for the Firefox layout.
	if (process.platform === "win32") {
		const psPath = zipPath.replace(/\//g, "\\");
		const psDest = destDir.replace(/\//g, "\\");
		execSync(
			`powershell -NoProfile -Command "Expand-Archive -Path '${psPath}' -DestinationPath '${psDest}' -Force"`,
			{ stdio: "inherit" },
		);
	} else {
		execSync(`unzip -oq "${zipPath}" -d "${destDir}"`, { stdio: "inherit" });
	}
}

function writeFileIfMissing(filePath, content) {
	if (fs.existsSync(filePath)) return false;
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content, "utf-8");
	return true;
}

// Cross-platform directory size in bytes (pure Node, no `du` dependency).
// `du` is unavailable on Windows, where this script supports extraction via
// PowerShell Expand-Archive — using `du` there would crash the run.
function dirSizeBytes(dir) {
	let total = 0;
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const entryPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			total += dirSizeBytes(entryPath);
		} else if (entry.isFile()) {
			total += fs.statSync(entryPath).size;
		}
	}
	return total;
}

function buildPackageJson({ pkg, os: osName, cpu, launch }) {
	return {
		name: `@phi-code-admin/${pkg}`,
		version: PACKAGE_VERSION,
		description: `Camoufox v${UPSTREAM_VERSION}-${UPSTREAM_RELEASE} binary for ${osName}/${cpu}. Bundled with @phi-code-admin/camoufox-js. MPL-2.0.`,
		license: "MPL-2.0",
		repository: {
			type: "git",
			url: "git+https://github.com/uglyswap/phi-code.git",
			directory: `packages/${pkg}`,
		},
		homepage: `https://github.com/uglyswap/phi-code/tree/main/packages/${pkg}`,
		bugs: { url: "https://github.com/uglyswap/phi-code/issues" },
		os: [osName],
		cpu: [cpu],
		files: ["camoufox-bin/", "LICENSE", "README.md", "VENDORED_FROM.md"],
		publishConfig: { access: "public" },
		camoufoxBin: {
			upstreamVersion: UPSTREAM_VERSION,
			upstreamRelease: UPSTREAM_RELEASE,
			launchFile: launch,
		},
	};
}

// Regenerate the package.json metadata on every run instead of writing it only
// when missing. writeFileIfMissing left committed metadata silently diverging
// from buildPackageJson() — e.g. a stale `private: true` (which makes
// `npm publish` refuse the package) or missing os/cpu/publishConfig filters.
// We merge the generated block over any existing file so manual extra fields
// survive, but always force the publish-critical fields (and drop `private`,
// which is never part of the generated metadata and blocks publishing).
function writePackageJson(filePath, target) {
	let existing = {};
	if (fs.existsSync(filePath)) {
		try {
			existing = JSON.parse(fs.readFileSync(filePath, "utf-8"));
		} catch (e) {
			console.warn(`  WARNING: could not parse existing ${filePath}, regenerating from scratch: ${e.message}`);
			existing = {};
		}
	}
	const generated = buildPackageJson(target);
	const merged = { ...existing, ...generated };
	// `private` blocks `npm publish`; the generated metadata is publishable.
	delete merged.private;
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(merged, null, 2) + "\n", "utf-8");
}

function buildReadme({ pkg, os: osName, cpu }) {
	return `# @phi-code-admin/${pkg}

**Vendored Camoufox v${UPSTREAM_VERSION}-${UPSTREAM_RELEASE} binary for \`${osName}/${cpu}\`.**

This package only exists as an \`optionalDependencies\` entry of
[\`@phi-code-admin/camoufox-js\`](../camoufox-js). It ships the extracted
Camoufox/Firefox tree under \`camoufox-bin/\`. Do not install it directly
unless you know what you're doing — the camoufox-js launcher resolves it
automatically via \`createRequire\` on the host that matches its
\`"os"\` and \`"cpu"\` filters.

## License

MPL-2.0 (Camoufox), inherited from
<https://github.com/daijro/camoufox/blob/main/LICENSE>.
A verbatim copy is included as \`LICENSE\` in this directory.

## Provenance

See \`VENDORED_FROM.md\`.
`;
}

function buildVendoredFrom({ pkg, zipSuffix }) {
	return `# Vendored binary: Camoufox ${UPSTREAM_VERSION}-${UPSTREAM_RELEASE}

| Field | Value |
|---|---|
| Upstream repo | https://github.com/daijro/camoufox |
| Upstream release | v${UPSTREAM_VERSION}-${UPSTREAM_RELEASE} |
| Upstream asset | \`${ZIP_BASE}-${zipSuffix}.zip\` |
| Vendored date | ${new Date().toISOString().slice(0, 10)} |
| License | MPL-2.0 |
| Local version | ${PACKAGE_VERSION} |
| Layout | Extracted tree under \`camoufox-bin/\`, no recompilation |

The Camoufox binary is unmodified. We only repackaged the upstream asset
as an npm tarball so it can be resolved offline through
\`optionalDependencies\` without a postinstall network roundtrip.

To re-sync from upstream, run:

\`\`\`bash
gh release download v${UPSTREAM_VERSION}-${UPSTREAM_RELEASE} -R daijro/camoufox \\
    --pattern '${ZIP_BASE}-${zipSuffix}.zip' \\
    --output .binaries-cache/${ZIP_BASE}-${zipSuffix}.zip
node scripts/build-camoufox-bin-packages.mjs ${pkg.replace(/^camoufox-bin-/, "")}
\`\`\`
`;
}

function main() {
	const arg = process.argv[2];
	const targets = arg
		? PLATFORMS.filter((p) => p.pkg.endsWith(arg))
		: PLATFORMS;

	if (targets.length === 0) {
		console.error(`No platform matched "${arg}".`);
		console.error(`Available: ${PLATFORMS.map((p) => p.pkg).join(", ")}`);
		process.exit(1);
	}

	for (const target of targets) {
		const zipPath = path.join(CACHE_DIR, `${ZIP_BASE}-${target.zipSuffix}.zip`);
		if (!fs.existsSync(zipPath)) {
			console.error(`[skip] missing ${zipPath}`);
			continue;
		}

		const pkgDir = path.join(PACKAGES_DIR, target.pkg);
		const binDir = path.join(pkgDir, "camoufox-bin");

		console.log(`\n>>> ${target.pkg}`);
		fs.mkdirSync(pkgDir, { recursive: true });
		if (fs.existsSync(binDir)) {
			fs.rmSync(binDir, { recursive: true, force: true });
		}
		unzip(zipPath, binDir);

		// On macOS the zip contains a top-level Camoufox.app/. The launcher
		// in camoufox-js resolves the launch file relative to camoufox-bin/,
		// so the existing layout is fine.
		const launchAbsolute = path.join(binDir, target.launch);
		if (!fs.existsSync(launchAbsolute)) {
			console.warn(
				`  WARNING: expected launch file ${target.launch} not found inside extracted tree. ` +
					`Layout may differ — inspect ${binDir}/ manually.`,
			);
		} else {
			console.log(`  launch  = ${target.launch}`);
		}

		// camoufox-js's `Version.fromPath()` expects a `version.json` next to
		// the launch binary. Upstream zips don't ship one (it is written by
		// `CamoufoxFetcher.setVersion()` after install), so we synthesise it
		// here from the known upstream version.
		const versionJson = JSON.stringify(
			{ version: UPSTREAM_VERSION, release: UPSTREAM_RELEASE },
			null,
			2,
		);
		fs.writeFileSync(path.join(binDir, "version.json"), versionJson + "\n", "utf-8");
		if (target.os === "darwin") {
			// macOS layout: also drop version.json inside Resources/ so the
			// path resolution from `getPath()` works for both `camoufoxPath()`
			// (returns the package root) and the inner Resources/ traversal.
			const resourcesDir = path.join(binDir, "Camoufox.app", "Contents", "Resources");
			if (fs.existsSync(resourcesDir)) {
				fs.writeFileSync(path.join(resourcesDir, "version.json"), versionJson + "\n", "utf-8");
			}
		}

		const written = [];
		writePackageJson(path.join(pkgDir, "package.json"), target);
		written.push("package.json");
		if (writeFileIfMissing(path.join(pkgDir, "README.md"), buildReadme(target))) written.push("README.md");
		if (writeFileIfMissing(path.join(pkgDir, "VENDORED_FROM.md"), buildVendoredFrom(target))) written.push("VENDORED_FROM.md");

		// LICENSE: copy from camoufox-js if present (same upstream MPL-2.0)
		const sharedLicense = path.join(PACKAGES_DIR, "camoufox-js", "LICENSE.md");
		const targetLicense = path.join(pkgDir, "LICENSE");
		if (fs.existsSync(sharedLicense) && !fs.existsSync(targetLicense)) {
			fs.copyFileSync(sharedLicense, targetLicense);
			written.push("LICENSE");
		}

		const sizeMb = Math.round(dirSizeBytes(binDir) / (1024 * 1024));
		console.log(`  size    = ${sizeMb} MB`);
		if (written.length) console.log(`  wrote   = ${written.join(", ")}`);
	}

	console.log("\nDone. Verify with:");
	console.log("  ls packages/camoufox-bin-*/camoufox-bin/version.json");
}

main();
