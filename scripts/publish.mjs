#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnNpmSync } from "./npm-command.mjs";
import {
	diffPackEntries,
	formatDiff,
	hashLocalPackFiles,
	hashTarballEntries,
	isEmptyDiff,
	parsePackJson,
} from "./publish-content.mjs";
import { getPublicWorkspacePackages, orderByInternalDependencies } from "./release-packages.mjs";

// Dependencies first: see orderByInternalDependencies.
const packages = orderByInternalDependencies(getPublicWorkspacePackages());

const dryRun = process.argv.includes("--dry-run");
const unknownArgs = process.argv.slice(2).filter((arg) => arg !== "--dry-run");

if (unknownArgs.length > 0) {
	console.error(`Usage: node scripts/publish.mjs [--dry-run]`);
	process.exit(1);
}

function run(args, options = {}) {
	console.log(`$ npm ${args.join(" ")}`);
	const result = spawnNpmSync(args, {
		cwd: options.cwd,
		encoding: "utf8",
		stdio: options.capture ? ["inherit", "pipe", "pipe"] : "inherit",
	});

	if (result.status !== 0) {
		const output = [result.stdout, result.stderr, result.error?.message].filter(Boolean).join("\n");
		throw new Error(output ? `Command failed: npm ${args.join(" ")}\n${output}` : `Command failed: npm ${args.join(" ")}`);
	}

	return result;
}

function assertBuildOutputExists(directory) {
	if (!existsSync(join(directory, "dist"))) {
		throw new Error(`${directory}/dist does not exist. Run npm run build before publishing.`);
	}
}

function packLocal(directory) {
	const result = run(["pack", "--dry-run", "--ignore-scripts", "--json"], { capture: true, cwd: directory });
	return parsePackJson(result.stdout);
}

function validatePack(directory) {
	const packed = packLocal(directory);
	console.log(`  ${packed.filename}: ${packed.files.length} files, ${packed.size} bytes packed, ${packed.unpackedSize} bytes unpacked`);
}

/** Registry state of name@version: "published", "unpublished", or "unknown" (registry unreachable). */
function getRegistryState(name, version) {
	const result = spawnNpmSync(["view", `${name}@${version}`, "dist", "--json"], {
		encoding: "utf8",
		stdio: ["inherit", "pipe", "pipe"],
	});

	if (result.status === 0 && result.stdout.trim()) {
		return { state: "published", dist: JSON.parse(result.stdout) };
	}

	const output = [result.stdout, result.stderr, result.error?.message].filter(Boolean).join("\n");
	if (result.status !== 0 && (output.includes("E404") || output.includes("404 Not Found"))) {
		return { state: "unpublished" };
	}
	// npm view prints nothing (exit 0) when the version does not exist.
	if (result.status === 0) {
		return { state: "unpublished" };
	}

	return { state: "unknown", reason: output || `npm view ${name}@${version} failed` };
}

/**
 * Compare the local package with the tarball already published under the same
 * version: "identical", "different" (with a per-file diff) or "unverifiable".
 */
async function compareWithPublished(pkg, dist) {
	const local = packLocal(pkg.directory);
	if (dist.shasum && local.shasum === dist.shasum) {
		return { status: "identical" };
	}
	// Different shasums can still mean identical files (a different npm/zlib
	// version produces different gzip bytes), so compare file by file.
	if (!dist.tarball) {
		return { status: "unverifiable", reason: "the registry returned no tarball URL" };
	}
	let tarball;
	try {
		const response = await fetch(dist.tarball);
		if (!response.ok) {
			return { status: "unverifiable", reason: `GET ${dist.tarball} returned HTTP ${response.status}` };
		}
		tarball = Buffer.from(await response.arrayBuffer());
	} catch (error) {
		return { status: "unverifiable", reason: `GET ${dist.tarball} failed: ${error instanceof Error ? error.message : String(error)}` };
	}
	if (dist.shasum && createHash("sha1").update(tarball).digest("hex") !== dist.shasum) {
		return { status: "unverifiable", reason: "the downloaded tarball does not match the registry shasum" };
	}
	const diff = diffPackEntries(hashLocalPackFiles(pkg.directory, local.files), hashTarballEntries(tarball));
	return isEmptyDiff(diff) ? { status: "identical" } : { status: "different", diff };
}

const versions = [...new Set(packages.map((pkg) => pkg.version))];
if (versions.length !== 1) {
	// Packages ship on independent version lines by design (see
	// scripts/sync-versions.js). Publishing proceeds per-package; versions already
	// published with identical content are skipped below.
	console.log(`Independent version lines detected: ${versions.join(", ")}`);
}

console.log(`Publishing phi packages${dryRun ? " (dry run)" : ""}\n`);

const packageStates = packages.map((pkg) => ({ ...pkg, published: false }));
const contentMismatches = [];
const verificationFailures = [];

for (const pkg of packageStates) {
	const registry = getRegistryState(pkg.name, pkg.version);

	if (registry.state === "unknown") {
		const message = `${pkg.name}@${pkg.version}: cannot query the npm registry.\n${registry.reason}`;
		if (!dryRun) throw new Error(message);
		console.warn(`WARNING (dry run): ${message}\n  Validating the local package only.`);
		assertBuildOutputExists(pkg.directory);
		validatePack(pkg.directory);
		console.log();
		continue;
	}

	if (registry.state === "published") {
		pkg.published = true;
		const comparison = await compareWithPublished(pkg, registry.dist);
		if (comparison.status === "identical") {
			console.log(`${pkg.name}@${pkg.version} is already published with identical content; skipping.\n`);
		} else if (comparison.status === "different") {
			contentMismatches.push(`  ${pkg.name}@${pkg.version}\n${formatDiff(comparison.diff)}`);
			console.log(`${pkg.name}@${pkg.version} is already published with DIFFERENT content.\n`);
		} else {
			verificationFailures.push(`  ${pkg.name}@${pkg.version}: ${comparison.reason}`);
			console.log(`${pkg.name}@${pkg.version} is already published; content could not be verified (${comparison.reason}).\n`);
		}
		continue;
	}

	console.log(`${pkg.name}@${pkg.version} is not published; validating package contents before publish.`);
	assertBuildOutputExists(pkg.directory);
	validatePack(pkg.directory);
	console.log();
}

if (contentMismatches.length > 0) {
	// A published version is immutable: changed content needs a version bump,
	// otherwise users keep the old tarball while the repo claims the new code.
	console.error(
		`The local content of these already-published versions differs from npm. Bump their versions before publishing:\n${contentMismatches.join("\n")}`,
	);
	process.exit(1);
}

if (verificationFailures.length > 0) {
	const message = `Could not verify that these already-published versions match the local content:\n${verificationFailures.join("\n")}`;
	if (!dryRun) {
		console.error(message);
		process.exit(1);
	}
	console.warn(`WARNING (dry run): ${message}`);
}

if (dryRun) {
	process.exit(0);
}

console.log("All packages validated; starting publication.\n");

for (const pkg of packageStates) {
	if (pkg.published) {
		console.log(`Skipping ${pkg.name}@${pkg.version}: already published\n`);
		continue;
	}

	run(["publish", "--access", "public", "--provenance", "--ignore-scripts"], { cwd: pkg.directory });
	console.log();
}
