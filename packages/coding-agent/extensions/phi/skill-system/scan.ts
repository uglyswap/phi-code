/**
 * Security scan for project-local skills (plan §C9).
 *
 * Project skills come from a cloned repo and are untrusted: they are scanned
 * at discovery, a blocking verdict quarantines the folder (moved out of the
 * index path, refused by name), and results are cached by content hash under
 * `.state/scans/<sha256>.json`.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findInjection } from "./linter.ts";
import { projectSkillsDir, scansDir, stateDir } from "./paths.ts";
import { dirExists, moveTree, readTextFile } from "./store.ts";

export interface ScanResult {
	name: string;
	path: string;
	verdict: "clean" | "blocked";
	findings: string[];
	cached: boolean;
	quarantined: boolean;
}

export interface ScanCacheEntry {
	hash: string;
	verdict: "clean" | "blocked";
	findings: string[];
	scanned_at: string;
}

export function scanCachePath(hash: string): string {
	return join(scansDir(), `${hash}.json`);
}

export function quarantineDir(): string {
	return join(stateDir(), "quarantine");
}

function contentHash(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Names currently quarantined (refused by the extension's own read paths). */
export function quarantinedNames(): string[] {
	const dir = quarantineDir();
	if (!dirExists(dir)) return [];
	try {
		return readdirSync(dir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name);
	} catch {
		return [];
	}
}

function listProjectSkills(cwd: string): Array<{ name: string; dir: string }> {
	const root = projectSkillsDir(cwd);
	if (!dirExists(root)) return [];
	const found: Array<{ name: string; dir: string }> = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
		const dir = join(root, entry.name);
		if (existsSync(join(dir, "SKILL.md"))) {
			found.push({ name: entry.name, dir });
			continue;
		}
		try {
			for (const child of readdirSync(dir, { withFileTypes: true })) {
				if (child.isDirectory() && existsSync(join(dir, child.name, "SKILL.md"))) {
					found.push({ name: child.name, dir: join(dir, child.name) });
				}
			}
		} catch {
			// Unreadable category — skip.
		}
	}
	return found;
}

/** Scan project skills; quarantine blocked ones when enabled. */
export function scanProjectSkills(cwd: string, quarantine = true): ScanResult[] {
	const results: ScanResult[] = [];
	for (const { name, dir } of listProjectSkills(cwd)) {
		let content: string;
		try {
			content = readTextFile(join(dir, "SKILL.md"));
		} catch {
			continue;
		}
		const hash = contentHash(content);
		let cached = false;
		let verdict: "clean" | "blocked";
		let findings: string[];
		const cachePath = scanCachePath(hash);
		try {
			const cache = JSON.parse(readTextFile(cachePath)) as ScanCacheEntry;
			verdict = cache.verdict;
			findings = cache.findings;
			cached = true;
		} catch {
			const injectionFindings = findInjection(content);
			verdict = injectionFindings.length > 0 ? "blocked" : "clean";
			findings = injectionFindings.map((finding) => `${finding.rule}: ${finding.message}`);
			try {
				const entry: ScanCacheEntry = { hash, verdict, findings, scanned_at: new Date().toISOString() };
				// Synchronous on purpose: the next scan must see the cache immediately.
				mkdirSync(scansDir(), { recursive: true });
				writeFileSync(cachePath, `${JSON.stringify(entry, null, 2)}\n`, "utf8");
			} catch {
				// Cache write is best-effort — the verdict stands either way.
			}
		}
		let quarantined = false;
		if (verdict === "blocked" && quarantine) {
			const target = join(quarantineDir(), name);
			try {
				if (dirExists(target)) {
					quarantined = false;
				} else {
					moveTree(dir, target);
					quarantined = true;
				}
			} catch {
				quarantined = false;
			}
		}
		results.push({ name, path: dir, verdict, findings, cached, quarantined });
	}
	return results;
}
