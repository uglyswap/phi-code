#!/usr/bin/env node
// Usage (from the repo root, after `npm run build:offline`):
//   node scripts/install-smoke/pack.mjs <outDir>
// Packs every public workspace package (the exact set scripts/publish.mjs
// publishes) with the npm version the release workflow publishes with, and
// writes <outDir>/packages.json listing the tarballs in publish order.
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnNpmSync } from "../npm-command.mjs";
import { getPublicWorkspacePackages, orderByInternalDependencies } from "../release-packages.mjs";

const RELEASE_NPM = "npm@11.16.0";

const outArg = process.argv[2];
if (!outArg) {
	console.error("Usage: node scripts/install-smoke/pack.mjs <outDir>");
	process.exit(2);
}
const outDir = resolve(outArg);
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const packages = orderByInternalDependencies(getPublicWorkspacePackages());
const packed = [];
for (const pkg of packages) {
	const before = new Set(readdirSync(outDir));
	const res = spawnNpmSync(
		["exec", "--yes", RELEASE_NPM, "--", "pack", "--ignore-scripts", "--pack-destination", outDir],
		{ cwd: resolve(pkg.directory), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
	);
	const created = readdirSync(outDir).filter((f) => !before.has(f) && f.endsWith(".tgz"));
	if (res.status !== 0 || created.length !== 1) {
		console.error(`npm pack failed for ${pkg.name} (${pkg.directory}), status=${res.status}`);
		console.error(res.stdout, res.stderr, res.error?.message ?? "");
		process.exit(1);
	}
	packed.push({ name: pkg.name, version: pkg.version, tarball: join(outDir, created[0]) });
	console.log(`packed ${pkg.name}@${pkg.version} -> ${created[0]}`);
}
writeFileSync(join(outDir, "packages.json"), `${JSON.stringify(packed, null, 2)}\n`);
console.log(`${packed.length} packages packed into ${outDir}`);
