#!/usr/bin/env node
/**
 * Release script for phi-code
 *
 * Usage:
 *   node scripts/release.mjs <major|minor|patch>
 *   node scripts/release.mjs <x.y.z>
 *
 * Steps:
 * 1. Check for uncommitted changes
 * 2. Verify every public workspace package is registered on npm
 * 3. Bump version via npm run version:xxx or set an explicit version
 * 4. Update CHANGELOG.md files: [Unreleased] -> [version] - date
 * 5. Regenerate release artifacts (model data, coding-agent install lock)
 * 6. Run checks, build and tests
 * 7. Preflight publish (dry-run) before any irreversible git state
 * 8. Commit and tag the release (tag = coding-agent version)
 * 9. Add new [Unreleased] section to changelogs
 * 10. Commit next-cycle changelog updates
 * 11. Push main and the tag
 *
 * Nothing is published from this machine: pushing the tag starts
 * .github/workflows/build-binaries.yml, whose publish-npm job publishes with npm
 * trusted publishing (OIDC + provenance, which only works inside GitHub Actions).
 */

import { execSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnNpmSync } from "./npm-command.mjs";
import { findPackageDirectories } from "./package-workspaces.mjs";
import { getPublicWorkspacePackages } from "./release-packages.mjs";

const RELEASE_TARGET = process.argv[2];
const BUMP_TYPES = new Set(["major", "minor", "patch"]);
const SEMVER_RE = /^\d+\.\d+\.\d+$/;

if (!RELEASE_TARGET || (!BUMP_TYPES.has(RELEASE_TARGET) && !SEMVER_RE.test(RELEASE_TARGET))) {
	console.error("Usage: node scripts/release.mjs <major|minor|patch|x.y.z>");
	process.exit(1);
}

function run(cmd, options = {}) {
	console.log(`$ ${cmd}`);
	try {
		return execSync(cmd, { encoding: "utf-8", stdio: options.silent ? "pipe" : "inherit", ...options });
	} catch (e) {
		if (!options.ignoreError) {
			console.error(`Command failed: ${cmd}`);
			process.exit(1);
		}
		return null;
	}
}

// Packages are versioned independently (see scripts/sync-versions.js). The git
// tag follows the CLI (packages/coding-agent): build-binaries.yml passes the tag
// to scripts/create-source-archive.sh, which refuses any version other than the
// coding-agent one, and the internal packages' 0.84.x line collides with the
// upstream pi tags.
const HEADLINE_PACKAGE_DIR = "packages/coding-agent";

function readPackageVersion(directory) {
	return JSON.parse(readFileSync(join(directory, "package.json"), "utf-8")).version;
}

function getVersion() {
	return readPackageVersion(HEADLINE_PACKAGE_DIR);
}

function assertPackagesAreRegisteredWithNpm() {
	const packageNames = getPublicWorkspacePackages().map((pkg) => pkg.name);
	const unregisteredPackages = [];

	console.log("Checking npm package registration...");
	for (const packageName of packageNames) {
		const result = spawnNpmSync(["view", packageName, "version", "--json"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});

		if (result.status === 0 && result.stdout.trim()) {
			console.log(`  ${packageName}`);
			continue;
		}

		const output = [result.stdout, result.stderr, result.error?.message].filter(Boolean).join("\n");
		if (output.includes("E404") || output.includes("404 Not Found")) {
			unregisteredPackages.push(packageName);
			continue;
		}

		throw new Error(output ? `Failed to query npm registration for ${packageName}\n${output}` : `Failed to query npm registration for ${packageName}`);
	}

	if (unregisteredPackages.length > 0) {
		throw new Error(`The following public workspace packages are not registered on npm:\n${unregisteredPackages.map((packageName) => `  ${packageName}`).join("\n")}\nRegister them before running a release.`);
	}

	console.log("  All public workspace packages are registered on npm\n");
}

// The repository carries upstream pi's tags too: refuse before committing rather
// than failing on `git tag` after the release commit exists.
function assertTagIsFree(tag) {
	const local = spawnSync("git", ["rev-parse", "--quiet", "--verify", `refs/tags/${tag}`], { stdio: "ignore" });
	const remote = spawnSync("git", ["ls-remote", "--tags", "origin", `refs/tags/${tag}`], { encoding: "utf8" });
	if (remote.status !== 0) {
		console.error(`Error: could not query origin for tag ${tag}.\n${remote.stderr ?? ""}`);
		process.exit(1);
	}
	if (local.status === 0 || remote.stdout.trim()) {
		console.error(
			`Error: tag ${tag} already exists (${local.status === 0 ? "locally" : "on origin"}). Choose an explicit version that does not collide: node scripts/release.mjs <x.y.z>`,
		);
		process.exit(1);
	}
}

function compareVersions(a, b) {
	const aParts = a.split(".").map(Number);
	const bParts = b.split(".").map(Number);

	for (let i = 0; i < 3; i++) {
		const diff = (aParts[i] || 0) - (bParts[i] || 0);
		if (diff !== 0) {
			return diff;
		}
	}

	return 0;
}

function removeStaleWorkspaceLockEntries() {
	const workspaceVersions = new Map(
		getPublicWorkspacePackages().map((pkg) => [pkg.name, pkg.version]),
	);
	const lockPath = "package-lock.json";
	const lock = JSON.parse(readFileSync(lockPath, "utf8"));
	let removed = 0;

	for (const [path, pkg] of Object.entries(lock.packages)) {
		if (!path.startsWith("packages/") || pkg.link === true) {
			continue;
		}
		for (const [name, version] of workspaceVersions) {
			if (path.endsWith(`/node_modules/${name}`) && pkg.version !== version) {
				delete lock.packages[path];
				removed++;
				break;
			}
		}
	}

	if (removed > 0) {
		writeFileSync(lockPath, `${JSON.stringify(lock, null, "\t")}\n`);
		console.log(`Removed ${removed} stale workspace package lock ${removed === 1 ? "entry" : "entries"}.`);
	}
}

function stageChangedFiles() {
	const output = run("git ls-files -m -o -d --exclude-standard", { silent: true });
	const paths = [...new Set((output || "").split("\n").map((line) => line.trim()).filter(Boolean))];
	if (paths.length === 0) {
		return;
	}

	// Pass the paths as argv (no shell): the previous POSIX single-quoting was
	// handed to cmd.exe on Windows, which keeps the quotes and made git fail.
	console.log(`$ git add -- ${paths.join(" ")}`);
	const result = spawnSync("git", ["add", "--", ...paths], { stdio: "inherit" });
	if (result.status !== 0) {
		console.error("Command failed: git add");
		process.exit(1);
	}
}

function bumpOrSetVersion(target) {
	const currentVersion = getVersion();

	if (BUMP_TYPES.has(target)) {
		console.log(`Bumping version (${target})...`);
		run(`npm run version:${target}`);
	} else {
		if (compareVersions(target, currentVersion) <= 0) {
			console.error(`Error: explicit version ${target} must be greater than current version ${currentVersion}.`);
			process.exit(1);
		}

		// The explicit version is the CLI's (it is compared with, and tagged as, the
		// coding-agent version). Applying it to every workspace would put all the
		// independently versioned packages back on a single lockstep line.
		console.log(`Setting explicit ${HEADLINE_PACKAGE_DIR} version (${target})...`);
		run(`npm version ${target} --workspace=${HEADLINE_PACKAGE_DIR} --no-git-tag-version --no-workspaces-update && node scripts/sync-versions.js && npm install --package-lock-only --ignore-scripts`);
	}

	// npm version can temporarily install the previous workspace versions before
	// sync-versions updates inter-package ranges. Remove those stale lock entries,
	// refresh the lockfile, then hydrate from the final dependency graph.
	removeStaleWorkspaceLockEntries();
	run("npm install --package-lock-only --ignore-scripts");
	run("npm ci --ignore-scripts");
	return getVersion();
}

function getChangelogs() {
	return findPackageDirectories()
		.map((directory) => join(directory, "CHANGELOG.md"))
		.filter((path) => existsSync(path));
}

function updateChangelogsForRelease() {
	const date = new Date().toISOString().split("T")[0];
	const changelogs = getChangelogs();

	for (const changelog of changelogs) {
		const content = readFileSync(changelog, "utf-8");

		if (!content.includes("## [Unreleased]")) {
			console.log(`  Skipping ${changelog}: no [Unreleased] section`);
			continue;
		}

		// Each package's changelog gets that package's own (independent) version.
		const packageVersion = readPackageVersion(dirname(changelog));
		const updated = content.replace(
			"## [Unreleased]",
			`## [${packageVersion}] - ${date}`
		);
		writeFileSync(changelog, updated);
		console.log(`  Updated ${changelog}`);
	}
}

function addUnreleasedSection() {
	const changelogs = getChangelogs();
	const unreleasedSection = "## [Unreleased]\n\n";

	for (const changelog of changelogs) {
		const content = readFileSync(changelog, "utf-8");

		// Insert after "# Changelog\n\n"
		const updated = content.replace(
			/^(# Changelog\n\n)/,
			`$1${unreleasedSection}`
		);
		writeFileSync(changelog, updated);
		console.log(`  Added [Unreleased] to ${changelog}`);
	}
}

// Main flow
console.log("\n=== Release Script ===\n");

// 1. Check for uncommitted changes
console.log("Checking for uncommitted changes...");
const status = run("git status --porcelain", { silent: true });
if (status && status.trim()) {
	console.error("Error: Uncommitted changes detected. Commit or stash first.");
	console.error(status);
	process.exit(1);
}
console.log("  Working directory clean\n");

// 2. Verify npm package registration before modifying the worktree.
assertPackagesAreRegisteredWithNpm();

// 3. Bump or set version
const version = bumpOrSetVersion(RELEASE_TARGET);
console.log(`  New version: ${version}\n`);
assertTagIsFree(`v${version}`);

// 4. Update changelogs
console.log("Updating CHANGELOG.md files...");
updateChangelogsForRelease();
console.log();

// 5. Regenerate release artifacts
console.log("Regenerating release artifacts...");
run("npm run generate:models");
run("npm run check:model-data");
// The version bump changes the internal versions recorded in the coding-agent
// install lock; build-binaries.yml rejects the tag if it is stale (--check).
run("npm run install-lock:coding-agent");
console.log();

// 6. Run checks and tests
console.log("Running checks...");
run("npm run check");
console.log();

console.log("Building packages for tests...");
run("npm run build:offline");
console.log();

console.log("Running tests...");
run("npm test");
console.log();

// 7. Preflight publish (dry-run) BEFORE any irreversible git state.
// Catches build/check/registry-scope/permission errors before the commit + tag
// are created, so an aborted publish never leaves a dangling tag + version bump.
console.log("Preflight: dry-run publish...");
run("npm run publish:dry");
console.log();

// 8. Commit and tag
console.log("Committing and tagging...");
stageChangedFiles();
run(`git commit -m "Release v${version}"`);
run(`git tag v${version}`);
console.log();

// 9. Add new [Unreleased] sections
console.log("Adding [Unreleased] sections for next cycle...");
addUnreleasedSection();
console.log();

// 10. Commit
console.log("Committing changelog updates...");
stageChangedFiles();
run(`git commit -m "Add [Unreleased] section for next cycle"`);
console.log();

// 11. Push (the tag push starts the CI publication)
console.log("Pushing to remote...");
run("git push origin main");
run(`git push origin v${version}`);
console.log();

console.log(`=== Prepared release v${version}; CI publication starts after the tag push ===`);
