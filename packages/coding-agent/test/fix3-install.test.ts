/**
 * Regression tests for a fresh `npm install -g @phi-code-admin/phi-code`.
 *
 * The bundled extensions are copied by scripts/postinstall.cjs into
 * <agentDir>/extensions, outside the package: every npm package they import
 * must be linked into <agentDir>/extensions/node_modules, or the import fails
 * once installed (it still works in the monorepo, where node_modules is hoisted).
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hasUserSettings } from "../extensions/phi/setup.ts";
import { BUNDLED_EXTENSION_DEPS } from "../src/core/bundled-assets.ts";

const packageDir = join(import.meta.dirname, "..");
const extensionsDir = join(packageDir, "extensions", "phi");
const packageJson = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as {
	files: string[];
	dependencies: Record<string, string>;
	scripts: Record<string, string>;
};

/** Resolved by the extension loader's aliases / virtual modules, not from node_modules. */
const LOADER_PROVIDED = new Set([
	"phi-code",
	"@phi-code-admin/phi-code",
	"phi-code-ai",
	"phi-code-agent",
	"phi-code-tui",
	"typebox",
	"@sinclair/typebox",
]);

/** Optional, non-literal imports guarded by try/catch (graceful fallback when absent). */
const OPTIONAL = new Set(["@mozilla/readability", "jsdom", "@juicesharp/rpiv-i18n"]);

function listSources(dir: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		if (statSync(full).isDirectory()) out.push(...listSources(full));
		else if (name.endsWith(".ts")) out.push(full);
	}
	return out;
}

function packageName(specifier: string): string {
	const parts = specifier.split("/");
	return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

function postinstallExtensionDeps(): string[] {
	const source = readFileSync(join(packageDir, "scripts", "postinstall.cjs"), "utf8");
	const block = /const extensionDeps = \[([\s\S]*?)\];/.exec(source);
	if (!block) throw new Error("extensionDeps not found in postinstall.cjs");
	return [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

describe("bundled extension dependencies after a global install", () => {
	it("postinstall.cjs and bundled-assets.ts link the same packages", () => {
		expect([...postinstallExtensionDeps()].sort()).toEqual([...BUNDLED_EXTENSION_DEPS].sort());
	});

	it("every npm package imported by a bundled extension is linked into extensions/node_modules", () => {
		const builtins = new Set(builtinModules);
		const linked = new Set<string>(BUNDLED_EXTENSION_DEPS);
		const missing: string[] = [];
		const importPattern = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"'./][^"']*)["']/g;
		for (const file of listSources(extensionsDir)) {
			const source = readFileSync(file, "utf8");
			for (const match of source.matchAll(importPattern)) {
				const specifier = match[1];
				// Skip prose that merely contains `from "..."` (strings, comments).
				if (!/^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(\/[\w.@/-]+)?$/i.test(specifier)) continue;
				if (specifier.startsWith("node:") || builtins.has(specifier.split("/")[0])) continue;
				const name = packageName(specifier);
				if (LOADER_PROVIDED.has(name) || OPTIONAL.has(name) || linked.has(name)) continue;
				missing.push(`${relative(extensionsDir, file)}: ${specifier}`);
			}
		}
		expect(missing).toEqual([]);
	});

	it("every linked package is a declared runtime dependency of the CLI", () => {
		for (const dep of BUNDLED_EXTENSION_DEPS) {
			expect(packageJson.dependencies, dep).toHaveProperty([dep]);
		}
	});

	it("the published files include what the postinstall copies and runs", () => {
		for (const entry of ["dist", "extensions", "agents", "skills", "scripts", "docs"]) {
			expect(packageJson.files).toContain(entry);
		}
		expect(packageJson.scripts.postinstall).toBe("node scripts/postinstall.cjs");
	});
});

describe("@phi-code-admin/browser package exports", () => {
	it("can be resolved by require.resolve (browser extension fallback through the CLI path)", () => {
		const browserPkg = JSON.parse(readFileSync(join(packageDir, "..", "browser", "package.json"), "utf8")) as {
			exports: Record<string, Record<string, string> | string>;
		};
		const root = browserPkg.exports["."] as Record<string, string>;
		expect(root.default).toBe("./dist/index.js");
	});
});

describe("setup first-run detection (hasUserSettings)", () => {
	let dir: string;
	let settingsPath: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fix3-install-"));
		settingsPath = join(dir, "settings.json");
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("is false when settings.json does not exist", () => {
		expect(hasUserSettings(settingsPath)).toBe(false);
	});

	it("ignores the keys phi writes by itself (postinstall quietStartup, changelog marker)", () => {
		writeFileSync(settingsPath, JSON.stringify({ quietStartup: true, lastChangelogVersion: "0.99.1" }));
		expect(hasUserSettings(settingsPath)).toBe(false);
	});

	it("is true as soon as the user chose something", () => {
		writeFileSync(settingsPath, JSON.stringify({ quietStartup: true, defaultProvider: "anthropic" }));
		expect(hasUserSettings(settingsPath)).toBe(true);
	});

	it("treats an unreadable file as configured (never nags)", () => {
		writeFileSync(settingsPath, "{ not json");
		expect(hasUserSettings(settingsPath)).toBe(true);
	});
});
