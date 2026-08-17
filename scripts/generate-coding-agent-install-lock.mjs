#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const codingAgentDir = join(repoRoot, "packages/coding-agent");
const outputDir = join(codingAgentDir, "install-lock");
const rootLockfilePath = join(repoRoot, "package-lock.json");
const outputPackageJsonPath = join(outputDir, "package.json");
const outputLockfilePath = join(outputDir, "package-lock.json");
/**
 * Which packages are ours, rather than something to copy from the root lockfile.
 *
 * This used to be a name-prefix list ("phi-code-", "@phi-code-admin/"). The fork
 * added workspaces that do not match it — sigma-memory, sigma-agents,
 * sigma-skills — so they were classified as external, and an external dependency
 * must have a real registry entry in the root lockfile. A workspace only has a
 * LINK entry there, so generation died with "Cannot resolve sigma-agents ... No
 * matching lockfile entry found" and the shipped artifact stayed at whatever the
 * last successful run produced.
 *
 * Deriving the set from the workspaces themselves cannot drift: every published
 * package under packages/ is internal, whatever it is called. Private workspaces
 * are excluded on purpose — they have no registry tarball, so if one ever became
 * a dependency the generator should fail loudly rather than emit a URL that 404s.
 */
let internalPackageNames = new Set();
/** name -> version declared by the workspace, for the validation pass. */
let internalWorkspaceVersions = new Map();
const isInternalPackage = (name) => internalPackageNames.has(name);
const installPackageName = "@phi-code-admin/phi-code-install";
const allowedInstallScriptPackages = new Map([
	["@google/genai@1.52.0", "preinstall is a no-op in the published package"],
	["protobufjs@7.6.5", "postinstall only warns about protobufjs version scheme mismatches"],
]);

const args = new Set(process.argv.slice(2));
const checkOnly = args.has("--check");

for (const arg of args) {
	if (arg !== "--check") {
		console.error(`Unknown argument: ${arg}`);
		process.exit(1);
	}
}

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function packageDependencies(entry) {
	return {
		...(entry.dependencies ?? {}),
		...(entry.optionalDependencies ?? {}),
	};
}

/** Dependencies to walk, each flagged with whether its absence is tolerable. */
function dependencyItems(entry, from) {
	const optionalNames = new Set(Object.keys(entry.optionalDependencies ?? {}));
	return Object.keys(packageDependencies(entry)).map((name) => ({
		name,
		from,
		optional: optionalNames.has(name) && !(name in (entry.dependencies ?? {})),
	}));
}

function sortedObject(object) {
	return Object.fromEntries(Object.entries(object).sort(([a], [b]) => a.localeCompare(b)));
}

function sortedPackageEntry(entry) {
	const fieldOrder = [
		"name",
		"version",
		"resolved",
		"integrity",
		"license",
		"dependencies",
		"optionalDependencies",
		"peerDependencies",
		"peerDependenciesMeta",
		"bin",
		"engines",
		"os",
		"cpu",
		"libc",
		"optional",
		"hasInstallScript",
		"deprecated",
		"funding",
	];
	const sorted = {};

	for (const field of fieldOrder) {
		if (entry[field] !== undefined) {
			sorted[field] = entry[field];
		}
	}
	for (const [field, value] of Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))) {
		if (sorted[field] === undefined) {
			sorted[field] = value;
		}
	}
	return sorted;
}

function copyLockEntry(entry) {
	const copied = { ...entry };
	delete copied.dev;
	delete copied.devOptional;
	delete copied.extraneous;
	delete copied.link;
	return sortedPackageEntry(copied);
}

function copyPackageJsonEntry(packageJson, options) {
	const entry = options.includeName
		? { name: packageJson.name, version: packageJson.version }
		: { version: packageJson.version };

	for (const field of [
		"license",
		"dependencies",
		"optionalDependencies",
		"peerDependencies",
		"peerDependenciesMeta",
		"bin",
		"engines",
		"os",
		"cpu",
		"libc",
	]) {
		if (packageJson[field] !== undefined) {
			entry[field] = packageJson[field];
		}
	}

	return sortedPackageEntry(entry);
}

function packageNameFromLockPath(lockPath) {
	const marker = "node_modules/";
	const index = lockPath.lastIndexOf(marker);
	if (index === -1) {
		return undefined;
	}

	const parts = lockPath.slice(index + marker.length).split("/");
	if (parts[0]?.startsWith("@")) {
		return `${parts[0]}/${parts[1]}`;
	}
	return parts[0];
}

function registryTarballUrl(packageName, version) {
	const tarballName = packageName.startsWith("@") ? packageName.split("/")[1] : packageName;
	return `https://registry.npmjs.org/${packageName}/-/${tarballName}-${version}.tgz`;
}

function isExactVersionSpec(spec) {
	return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(spec);
}

function getInternalWorkspaces(lockPackages) {
	const workspaces = new Map();

	for (const [lockPath, entry] of Object.entries(lockPackages)) {
		if (!lockPath.startsWith("packages/") || lockPath.includes("/node_modules/") || !entry.version) {
			continue;
		}

		// The name comes from the manifest, not the lockfile entry: npm OMITS "name"
		// whenever the package name equals its directory name. Every phi-code-* and
		// @phi-code-admin/* package lives in a differently-named folder and so carries
		// one, but packages/sigma-agents, packages/sigma-memory and packages/sigma-skills
		// do not — they were dropped here before any classification could happen, which
		// is what actually broke generation.
		const manifestPath = join(repoRoot, lockPath, "package.json");
		if (!existsSync(manifestPath)) {
			continue;
		}
		const packageJson = readJson(manifestPath);
		if (!packageJson.name || packageJson.private) {
			continue; // unnamed, or private: no registry tarball to point at
		}

		workspaces.set(packageJson.name, { lockPath, packageJson });
	}

	internalPackageNames = new Set(workspaces.keys());
	internalWorkspaceVersions = new Map(
		[...workspaces].map(([name, workspace]) => [name, workspace.packageJson.version]),
	);
	return workspaces;
}

function resolveExternalDependency(lockPackages, packageName, fromLockPath) {
	const candidateDirs = [];
	let current = fromLockPath;

	while (current) {
		candidateDirs.push(current);
		const parent = posix.dirname(current);
		if (parent === "." || parent === current) {
			break;
		}
		current = parent;
	}
	candidateDirs.push("");

	const tried = new Set();
	for (const directory of candidateDirs) {
		const candidate = directory ? `${directory}/node_modules/${packageName}` : `node_modules/${packageName}`;
		if (tried.has(candidate)) {
			continue;
		}
		tried.add(candidate);

		const entry = lockPackages[candidate];
		if (entry && !entry.link) {
			return candidate;
		}
	}

	const suffix = `node_modules/${packageName}`;
	const matches = Object.entries(lockPackages)
		.filter(([lockPath, entry]) => !entry.link && (lockPath === suffix || lockPath.endsWith(`/${suffix}`)))
		.map(([lockPath]) => lockPath);

	if (matches.length === 1) {
		return matches[0];
	}

	throw new Error(
		`Cannot resolve ${packageName} from ${fromLockPath || "root"}. ` +
			(matches.length > 1 ? `Matches: ${matches.join(", ")}` : "No matching lockfile entry found."),
	);
}

/**
 * Where a root-lockfile path lands in the generated installer tree.
 *
 * A workspace lives at `packages/<dir>` in the root lockfile but at
 * `node_modules/<name>` in the installer, and anything npm nested beneath it
 * moves with it: `packages/coding-agent/node_modules/undici` becomes
 * `node_modules/@phi-code-admin/phi-code/node_modules/undici`. Without this
 * rewrite a nested dependency was emitted under a `packages/…` path that does
 * not exist in the installer tree, so npm would not find it there.
 */
function toInstallerPath(lockPath, workspaceOutputPaths) {
	for (const [workspaceLockPath, outputPath] of workspaceOutputPaths) {
		if (lockPath === workspaceLockPath) return outputPath;
		if (lockPath.startsWith(`${workspaceLockPath}/`)) {
			return `${outputPath}${lockPath.slice(workspaceLockPath.length)}`;
		}
	}
	return lockPath;
}

function addInternalWorkspace(installLockPackages, addedPaths, queue, name, workspace) {
	const packageJson = workspace.packageJson;
	const outputPath = `node_modules/${name}`;
	const entry = copyPackageJsonEntry(packageJson, { includeName: false });
	entry.resolved = registryTarballUrl(name, packageJson.version);

	installLockPackages[outputPath] = sortedPackageEntry(entry);
	addedPaths.add(outputPath);

	// Resolve from where the workspace really sits in the root lockfile, not from its
	// installer path: npm nests a conflicting version under `packages/<dir>/node_modules/`,
	// which is invisible from `node_modules/<name>` and left the lookup ambiguous between
	// unrelated copies elsewhere in the tree.
	queue.push(...dependencyItems(packageJson, workspace.lockPath));
}

function addExternalPackage(lockPackages, installLockPackages, addedPaths, queue, name, from, workspaceOutputPaths) {
	const lockPath = resolveExternalDependency(lockPackages, name, from);
	const outputPath = toInstallerPath(lockPath, workspaceOutputPaths);
	if (addedPaths.has(outputPath)) {
		return;
	}

	const entry = lockPackages[lockPath];
	installLockPackages[outputPath] = copyLockEntry(entry);
	addedPaths.add(outputPath);

	queue.push(...dependencyItems(entry, lockPath));
}

function createInstallerPackageJson(codingAgentPackage) {
	const packageJson = {
		name: installPackageName,
		version: codingAgentPackage.version,
		private: true,
		description: "Lockfile root used by the Pi installer and updater.",
		dependencies: {
			[codingAgentPackage.name]: codingAgentPackage.version,
		},
	};
	if (codingAgentPackage.overrides) {
		packageJson.overrides = codingAgentPackage.overrides;
	}
	if (codingAgentPackage.engines) {
		packageJson.engines = codingAgentPackage.engines;
	}
	return packageJson;
}

function createRootLockEntry(installerPackageJson) {
	const entry = {
		name: installerPackageJson.name,
		version: installerPackageJson.version,
		dependencies: installerPackageJson.dependencies,
	};
	if (installerPackageJson.engines) {
		entry.engines = installerPackageJson.engines;
	}
	return sortedPackageEntry(entry);
}

function validateGeneratedFiles(installerPackageJson, installLock, internalNames) {
	const errors = [];
	const rootEntry = installLock.packages[""];
	const includedPackageNames = new Set();
	const seenAllowedInstallScriptPackages = new Set();

	if (installLock.lockfileVersion !== 3) {
		errors.push("package-lock.json must use lockfileVersion 3");
	}
	if (installLock.name !== installerPackageJson.name) {
		errors.push(`lockfile name ${installLock.name} does not match package.json name ${installerPackageJson.name}`);
	}
	if (installLock.version !== installerPackageJson.version) {
		errors.push(
			`lockfile version ${installLock.version} does not match package.json version ${installerPackageJson.version}`,
		);
	}
	if (JSON.stringify(rootEntry?.dependencies ?? {}) !== JSON.stringify(installerPackageJson.dependencies)) {
		errors.push("lockfile root dependencies do not match package.json dependencies");
	}

	for (const [lockPath, entry] of Object.entries(installLock.packages)) {
		const packageName = packageNameFromLockPath(lockPath);
		if (packageName) {
			includedPackageNames.add(packageName);
		}
		if (entry.link) {
			errors.push(`${lockPath} is a link entry`);
		}
		if (typeof entry.resolved === "string" && /^(file:|link:|workspace:|\.\.?\/|\/)/.test(entry.resolved)) {
			errors.push(`${lockPath} has a local resolved value: ${entry.resolved}`);
		}
		if (entry.dev || entry.devOptional || entry.extraneous) {
			errors.push(`${lockPath || "root"} contains dev/extraneous metadata`);
		}
		// An internal package must carry the version its workspace declares.
		//
		// This used to require the INSTALLER's version instead, which assumes every
		// internal package is released in lockstep. The fork versions them
		// independently (coding-agent 0.98.x, the pi-derived packages 0.84.x, sigma
		// and the camoufox/pods/mom satellites on their own tracks), so the check
		// could only ever fail here. Comparing against the workspace still catches
		// the failure that matters: an entry that does not describe what would
		// actually be published.
		if (packageName && isInternalPackage(packageName)) {
			const expected = internalWorkspaceVersions.get(packageName);
			if (expected && entry.version !== expected) {
				errors.push(`${lockPath} internal package version ${entry.version} does not match workspace version ${expected}`);
			}
		}
		if (entry.hasInstallScript) {
			if (!packageName || !entry.version) {
				errors.push(`${lockPath || "root"} has install scripts but no package name/version`);
			} else {
				const packageId = `${packageName}@${entry.version}`;
				if (allowedInstallScriptPackages.has(packageId)) {
					seenAllowedInstallScriptPackages.add(packageId);
				} else {
					errors.push(
						`${lockPath} has install scripts (${packageId}). Review it and add it to allowedInstallScriptPackages if intentional.`,
					);
				}
			}
		}
	}

	for (const packageId of allowedInstallScriptPackages.keys()) {
		if (!seenAllowedInstallScriptPackages.has(packageId)) {
			errors.push(`allowed install-script package ${packageId} is no longer present; remove it from the allowlist`);
		}
	}

	for (const name of internalNames) {
		if (!includedPackageNames.has(name)) {
			errors.push(`internal dependency ${name} is missing`);
		}
	}

	for (const [lockPath, entry] of Object.entries(installLock.packages)) {
		const optionalNames = new Set(Object.keys(entry.optionalDependencies ?? {}));
		for (const [dependencyName, dependencySpec] of Object.entries(packageDependencies(entry))) {
			let dependencyLockPath;
			try {
				dependencyLockPath = resolveExternalDependency(installLock.packages, dependencyName, lockPath);
			} catch {
				// Optional means optional here too: npm records only the platform variants
				// it installed, so an artifact generated on one OS legitimately lacks the
				// others. Requiring them turned every generation into a failure.
				if (optionalNames.has(dependencyName) && !(dependencyName in (entry.dependencies ?? {}))) {
					continue;
				}
				errors.push(`${lockPath || "root"} dependency ${dependencyName} is missing`);
				continue;
			}

			const dependencyEntry = installLock.packages[dependencyLockPath];
			if (isExactVersionSpec(dependencySpec) && dependencyEntry.version !== dependencySpec) {
				errors.push(
					`${lockPath || "root"} dependency ${dependencyName}@${dependencySpec} resolves to ${dependencyEntry.version}`,
				);
			}
		}
	}

	const platformPackageCount = Object.values(installLock.packages).filter((entry) => entry.os || entry.cpu || entry.libc)
		.length;
	if (platformPackageCount === 0) {
		errors.push("no platform-specific optional dependency entries found");
	}

	if (errors.length > 0) {
		throw new Error(`Generated installer lock failed validation:\n${errors.map((error) => `  - ${error}`).join("\n")}`);
	}
}

function generateInstallLock() {
	const rootLock = readJson(rootLockfilePath);
	if (rootLock.lockfileVersion !== 3 || !rootLock.packages) {
		throw new Error("package-lock.json must be lockfileVersion 3 and contain a packages map");
	}

	const lockPackages = rootLock.packages;
	const codingAgentPackage = readJson(join(codingAgentDir, "package.json"));
	const installerPackageJson = createInstallerPackageJson(codingAgentPackage);
	const internalWorkspaces = getInternalWorkspaces(lockPackages);
	const installLockPackages = {
		"": createRootLockEntry(installerPackageJson),
	};
	const addedPaths = new Set([""]);
	const internalNames = new Set();
	// packages/<dir> -> node_modules/<name>, so anything npm nested under a workspace
	// is emitted where the installer will actually look for it. Longest first: a
	// nested workspace path must win over its parent.
	const workspaceOutputPaths = [...internalWorkspaces]
		.map(([name, workspace]) => [workspace.lockPath, `node_modules/${name}`])
		.sort(([a], [b]) => b.length - a.length);
	const queue = dependencyItems(installerPackageJson, "");
	/** Optional platform packages the root lockfile does not carry (see the warning below). */
	const skippedOptional = [];

	while (queue.length > 0) {
		const item = queue.shift();
		if (!item) {
			break;
		}

		const workspace = internalWorkspaces.get(item.name);
		if (workspace) {
			const outputPath = `node_modules/${item.name}`;
			internalNames.add(item.name);
			if (!addedPaths.has(outputPath)) {
				addInternalWorkspace(installLockPackages, addedPaths, queue, item.name, workspace);
			}
			continue;
		}

		try {
			addExternalPackage(
				lockPackages,
				installLockPackages,
				addedPaths,
				queue,
				item.name,
				item.from,
				workspaceOutputPaths,
			);
		} catch (error) {
			// An optional dependency is allowed to be absent — that is what optional
			// means. npm only records the platform variants it actually installed, so a
			// lockfile refreshed on Windows has no darwin/linux entries and generation
			// used to die on the first one. Skipping them keeps the tool usable; the
			// warning below makes the resulting gap impossible to ship unnoticed.
			if (!item.optional) throw error;
			skippedOptional.push(item.name);
		}
	}

	const installLock = {
		name: installerPackageJson.name,
		version: installerPackageJson.version,
		lockfileVersion: 3,
		requires: true,
		packages: sortedObject(installLockPackages),
	};

	validateGeneratedFiles(installerPackageJson, installLock, internalNames);
	return { installerPackageJson, installLock, skippedOptional };
}

/**
 * The artifact is only as cross-platform as the lockfile it was generated from:
 * npm records the platform variants it actually installed, so a lockfile refreshed
 * on Windows carries no darwin/linux entries and the installer built from it would
 * silently lack them. Say so, loudly, rather than shipping a one-OS lock.
 */
function reportPlatformCoverage(skippedOptional) {
	if (skippedOptional.length === 0) return;
	const unique = [...new Set(skippedOptional)].sort();
	console.warn(
		`Warning: ${unique.length} optional (platform-specific) package(s) are absent from the root lockfile and were skipped:`,
	);
	console.warn(`  ${unique.join(", ")}`);
	console.warn(
		"  The generated installer lock therefore only covers this machine's platform. Regenerate it where the",
	);
	console.warn("  root lockfile carries every variant (CI/Linux) before shipping it as a release asset.");
}

try {
	const { installerPackageJson, installLock, skippedOptional } = generateInstallLock();
	reportPlatformCoverage(skippedOptional);
	const packageJsonContent = `${JSON.stringify(installerPackageJson, null, "\t")}\n`;
	const lockfileContent = `${JSON.stringify(installLock, null, "\t")}\n`;

	if (checkOnly) {
		if (!existsSync(outputPackageJsonPath) || !existsSync(outputLockfilePath)) {
			console.error("packages/coding-agent/install-lock is missing generated files.");
			console.error("Run: npm run install-lock:coding-agent");
			process.exit(1);
		}
		const currentPackageJson = readFileSync(outputPackageJsonPath, "utf8");
		const currentLockfile = readFileSync(outputLockfilePath, "utf8");
		if (currentPackageJson !== packageJsonContent || currentLockfile !== lockfileContent) {
			console.error("packages/coding-agent/install-lock is out of date.");
			console.error("Run: npm run install-lock:coding-agent");
			process.exit(1);
		}
		console.log("packages/coding-agent/install-lock is up to date.");
	} else {
		mkdirSync(outputDir, { recursive: true });
		writeFileSync(outputPackageJsonPath, packageJsonContent);
		writeFileSync(outputLockfilePath, lockfileContent);
		const packageCount = Object.keys(installLock.packages).length - 1;
		const platformPackageCount = Object.values(installLock.packages).filter((entry) => entry.os || entry.cpu || entry.libc)
			.length;
		console.log(
			`Wrote packages/coding-agent/install-lock/package.json and package-lock.json (${packageCount} packages, ${platformPackageCount} platform-specific).`,
		);
	}
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
