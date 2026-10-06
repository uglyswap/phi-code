import { readFileSync } from "node:fs";
import { join } from "node:path";
import { findPackageDirectories } from "./package-workspaces.mjs";

export function getPublicWorkspacePackages() {
	return findPackageDirectories()
		.map((directory) => ({
			directory,
			...JSON.parse(readFileSync(join(directory, "package.json"), "utf8")),
		}))
		.filter((pkg) => pkg.private !== true)
		.map(({ directory, name, version }) => ({ directory, name, version }));
}

/**
 * Orders packages so every internal dependency is published before its dependents.
 * The CLI ships an npm-shrinkwrap.json that pins the new internal versions: if a
 * publish stopped half-way (2FA prompt, network) with the CLI already out, a
 * fresh `npm install -g` would fail on not-yet-published dependencies.
 * Ties keep the input order; a dependency cycle throws.
 */
export function orderByInternalDependencies(packages, readManifest = (pkg) => JSON.parse(readFileSync(join(pkg.directory, "package.json"), "utf8"))) {
	const byName = new Map(packages.map((pkg) => [pkg.name, pkg]));
	const ordered = [];
	const state = new Map();
	const visit = (pkg, chain) => {
		if (state.get(pkg.name) === "done") return;
		if (state.get(pkg.name) === "visiting") {
			throw new Error(`Internal dependency cycle: ${[...chain, pkg.name].join(" -> ")}`);
		}
		state.set(pkg.name, "visiting");
		const manifest = readManifest(pkg);
		const deps = { ...manifest.dependencies, ...manifest.optionalDependencies, ...manifest.peerDependencies };
		for (const depName of Object.keys(deps)) {
			const dep = byName.get(depName);
			if (dep) visit(dep, [...chain, pkg.name]);
		}
		state.set(pkg.name, "done");
		ordered.push(pkg);
	};
	for (const pkg of packages) visit(pkg, []);
	return ordered;
}
