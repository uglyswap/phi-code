#!/usr/bin/env node
/**
 * Runtime smoke test for the bundled phi extensions.
 *
 * Typechecking them is not enough: they are shipped as SOURCE and loaded by jiti
 * at runtime, against the BUILT core. Failures that only appear there include
 * module-initialisation cycles (a `const` read before its module finished
 * evaluating typechecks fine and throws at import), a missing dist entry, and a
 * virtual-module alias that no longer resolves.
 *
 * Run after `npm run build`. Exits non-zero with the failing extension listed.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createJiti } from "jiti";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const codingAgent = join(repoRoot, "packages/coding-agent");
const extensionsDir = join(codingAgent, "extensions/phi");

const distEntry = join(codingAgent, "dist/index.js");
if (!existsSync(distEntry)) {
	console.error(`Build the coding agent first: ${distEntry} is missing.`);
	process.exit(1);
}

// Mirrors the alias table the extension loader installs for a built Node runtime.
const alias = {
	"phi-code": distEntry,
	"@phi-code-admin/phi-code": distEntry,
	"@phi-code-admin/phi-code/hooks": join(codingAgent, "dist/core/hooks/index.js"),
	"phi-code-ai": join(repoRoot, "packages/ai/dist/compat.js"),
	"phi-code-ai/compat": join(repoRoot, "packages/ai/dist/compat.js"),
	"phi-code-ai/oauth": join(repoRoot, "packages/ai/dist/oauth.js"),
	"phi-code-ai/providers/all": join(repoRoot, "packages/ai/dist/providers/all.js"),
	"phi-code-agent": join(repoRoot, "packages/agent/dist/index.js"),
	"phi-code-tui": join(repoRoot, "packages/tui/dist/index.js"),
};

function collectEntrypoints() {
	const entries = [];
	for (const name of readdirSync(extensionsDir)) {
		const full = join(extensionsDir, name);
		if (name.endsWith(".ts")) {
			entries.push(full);
			continue;
		}
		const index = join(full, "index.ts");
		if (statSync(full).isDirectory() && existsSync(index)) entries.push(index);
	}
	return entries;
}

const jiti = createJiti(pathToFileURL(join(repoRoot, "smoke.mjs")).href, { moduleCache: false, alias });
const entries = collectEntrypoints();
const failures = [];

for (const entry of entries) {
	try {
		const mod = await jiti.import(entry, {});
		const factory = mod?.default ?? mod;
		if (typeof factory !== "function" && typeof factory !== "object") {
			failures.push([entry, `unexpected default export: ${typeof factory}`]);
		}
	} catch (error) {
		failures.push([entry, String(error?.message ?? error).split("\n")[0]]);
	}
}

if (failures.length > 0) {
	console.error(`Extensions failed to load (${failures.length}/${entries.length}):`);
	for (const [entry, message] of failures) {
		console.error(`  ${entry.replace(`${extensionsDir}/`, "").replace(`${extensionsDir}\\`, "")}: ${message}`);
	}
	process.exit(1);
}

console.log(`Extensions loaded: ${entries.length}/${entries.length}`);
