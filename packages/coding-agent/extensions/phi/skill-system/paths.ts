/**
 * Path resolution for the skill-system extension.
 *
 * Every write path resolves through `getAgentDir()` at call time so
 * PHI_CODING_AGENT_DIR overrides (tests, sandboxes) are honored. The `.state`,
 * `.archive` and `.locks` directories are dot-prefixed so both the core skill
 * loader and sigma-skills ignore them.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "phi-code";

export function skillsRoot(): string {
	return join(getAgentDir(), "skills");
}

export function stateDir(): string {
	return join(skillsRoot(), ".state");
}

export function blobsDir(): string {
	return join(stateDir(), "blobs");
}

export function pendingDir(): string {
	return join(stateDir(), "pending");
}

export function scansDir(): string {
	return join(stateDir(), "scans");
}

export function backupsDir(): string {
	return join(stateDir(), "backups");
}

export function logsDir(): string {
	return stateDir();
}

export function locksDir(): string {
	return join(skillsRoot(), ".locks");
}

export function archiveDir(): string {
	return join(skillsRoot(), ".archive");
}

/** Project-local skills root: <cwd>/.phi/skills (never written by default). */
export function projectSkillsDir(cwd: string): string {
	return join(cwd, CONFIG_DIR_NAME, "skills");
}

/** Stable, filesystem-safe digest for a lock key (skill name or ledger). */
export function lockKeyFor(key: string): string {
	return createHash("sha256").update(key).digest("hex").slice(0, 32);
}

/** True when `target` is `root` itself or lies inside `root`. */
export function isWithin(root: string, target: string): boolean {
	const rel = relative(resolve(root), resolve(target));
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Resolve a child path under `root`; undefined when it escapes the root. */
export function resolveWithin(root: string, child: string): string | undefined {
	const target = resolve(root, child);
	return isWithin(root, target) ? target : undefined;
}

function isDir(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function isFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

/**
 * Locate an existing skill directory by name: direct child of the skills root
 * first, then one category level down. Returns the (possibly empty) direct
 * directory when it exists, so `create` can adopt a leftover empty folder.
 */
export function locateSkillDir(name: string): string | undefined {
	const direct = join(skillsRoot(), name);
	if (isFile(join(direct, "SKILL.md"))) return direct;
	const root = skillsRoot();
	if (existsSync(root)) {
		let entries: import("node:fs").Dirent[];
		try {
			entries = readdirSync(root, { withFileTypes: true });
		} catch {
			entries = [];
		}
		for (const entry of entries) {
			if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
			const candidate = join(root, entry.name, name);
			if (isFile(join(candidate, "SKILL.md"))) return candidate;
		}
	}
	return isDir(direct) ? direct : undefined;
}
