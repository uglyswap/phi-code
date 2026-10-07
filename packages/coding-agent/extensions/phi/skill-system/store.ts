/**
 * Filesystem helpers for the skill-system extension (plan §C1.4).
 *
 * All writes go through `withFileMutationQueue` (serialized per resolved path)
 * + a tmp-then-rename atomic write. Reads strip a leading UTF-8 BOM and decode
 * invalid bytes as U+FFFD (utf-8-sig + errors="replace" semantics), so the
 * same skill reads identically regardless of how it was written.
 */

import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, posix, relative } from "node:path";
import { withFileMutationQueue } from "phi-code";
import { stripBom } from "./frontmatter.ts";

let tmpCounter = 0;

export function fileExists(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

export function dirExists(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

export function readTextFile(path: string): string {
	return stripBom(readFileSync(path).toString("utf8"));
}

export async function atomicWriteFile(
	filePath: string,
	content: string,
	options?: { exclusive?: boolean },
): Promise<void> {
	await withFileMutationQueue(filePath, async () => {
		// Exclusive create: re-checked INSIDE the queue so two concurrent
		// creators serialize and the second one fails with a clear error.
		if (options?.exclusive && existsSync(filePath)) {
			throw new Error(`file already exists: ${filePath}`);
		}
		mkdirSync(dirname(filePath), { recursive: true });
		const tmpPath = join(dirname(filePath), `.${basename(filePath)}.tmp-${process.pid}-${tmpCounter++}`);
		let preserveMode: number | undefined;
		try {
			preserveMode = statSync(filePath).mode;
		} catch {
			preserveMode = undefined;
		}
		try {
			writeFileSync(tmpPath, content, { encoding: "utf8", mode: 0o644 });
			if (preserveMode !== undefined) {
				try {
					chmodSync(tmpPath, preserveMode);
				} catch {
					// Mode preservation is best-effort (Windows ACLs are not POSIX modes).
				}
			}
			renameSync(tmpPath, filePath);
		} catch (error) {
			try {
				unlinkSync(tmpPath);
			} catch {
				// Tmp file already gone; the write error below is the real failure.
			}
			throw error;
		}
	});
}

export function copyTree(src: string, dest: string): void {
	mkdirSync(dirname(dest), { recursive: true });
	cpSync(src, dest, { recursive: true, force: true });
}

export function removeTree(target: string): void {
	rmSync(target, { recursive: true, force: true, maxRetries: 3 });
}

export function moveTree(src: string, dest: string): void {
	mkdirSync(dirname(dest), { recursive: true });
	try {
		renameSync(src, dest);
	} catch {
		cpSync(src, dest, { recursive: true, force: true });
		rmSync(src, { recursive: true, force: true, maxRetries: 3 });
	}
}

const WALK_SKIP = new Set(["node_modules", ".git", ".state", ".archive", ".locks"]);

/** Recursively list files under `root` as posix-relative paths (depth-limited). */
export function listFilesRelative(root: string, maxDepth = 6): string[] {
	const out: string[] = [];
	if (!dirExists(root)) return out;
	const walk = (dir: string, depth: number): void => {
		if (depth > maxDepth) return;
		let entries: import("node:fs").Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (WALK_SKIP.has(entry.name)) continue;
				walk(full, depth + 1);
				continue;
			}
			if (!entry.isFile()) continue;
			out.push(relative(root, full).split("\\").join(posix.sep));
		}
	};
	walk(root, 0);
	return out.sort();
}

/** Remove leftover atomic-write tmp files (crash leftovers) under `root`. */
export function cleanupStaleTmpFiles(root: string, maxAgeMs = 3_600_000): number {
	let removed = 0;
	if (!dirExists(root)) return 0;
	const walk = (dir: string, depth: number): void => {
		if (depth > 4) return;
		let entries: import("node:fs").Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name === "node_modules" || entry.name === ".git") continue;
				walk(full, depth + 1);
				continue;
			}
			if (!/\.tmp-\d+-\d+$/.test(entry.name)) continue;
			try {
				if (Date.now() - statSync(full).mtimeMs < maxAgeMs) continue;
				unlinkSync(full);
				removed++;
			} catch {
				// Racing another writer — leave it for the next pass.
			}
		}
	};
	walk(root, 0);
	return removed;
}

export { existsSync };
