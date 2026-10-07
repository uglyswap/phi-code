/**
 * Per-skill file locks (plan §3.4, H3).
 *
 * One lock file per key under `<skillsRoot>/.locks/<digest>.lock`, holding
 * `pid timestamp`. Acquisition is reentrant within the process (a batch may
 * re-enter the same skill), batches acquire in SORTED order (deadlock-free),
 * and stale files (mtime older than 60 s) are reclaimed.
 */

import { mkdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lockKeyFor, locksDir } from "./paths.ts";

const STALE_MS = 60_000;
const RETRY_MS = 40;
const TIMEOUT_MS = 10_000;

interface HeldLock {
	count: number;
	path: string;
}

const held = new Map<string, HeldLock>();

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireOne(key: string): Promise<string> {
	const digest = lockKeyFor(key);
	const existing = held.get(digest);
	if (existing) {
		existing.count++;
		return digest;
	}
	mkdirSync(locksDir(), { recursive: true });
	const lockPath = join(locksDir(), `${digest}.lock`);
	const deadline = Date.now() + TIMEOUT_MS;
	for (;;) {
		try {
			writeFileSync(lockPath, `${process.pid} ${Date.now()}`, { flag: "wx" });
			held.set(digest, { count: 1, path: lockPath });
			return digest;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "EEXIST") throw error;
			try {
				const stat = statSync(lockPath);
				if (Date.now() - stat.mtimeMs > STALE_MS) {
					unlinkSync(lockPath);
					continue;
				}
			} catch {
				// Lock vanished between the failed open and the stat — retry immediately.
				continue;
			}
			if (Date.now() > deadline) throw new Error(`timeout acquiring lock for "${key}"`);
			await sleep(RETRY_MS);
		}
	}
}

function releaseDigest(digest: string): void {
	const entry = held.get(digest);
	if (!entry) return;
	entry.count--;
	if (entry.count > 0) return;
	held.delete(digest);
	try {
		unlinkSync(entry.path);
	} catch {
		// Already gone (stale reclaim or manual cleanup) — releasing is best-effort.
	}
}

/**
 * Acquire locks for all keys (sorted, deduplicated). Returns a release
 * function; calling it more than once is a no-op. On failure, partial
 * acquisitions are rolled back before the error propagates.
 */
export async function acquireLocks(keys: readonly string[]): Promise<() => void> {
	const sorted = [...new Set(keys)].sort();
	const acquired: string[] = [];
	try {
		for (const key of sorted) acquired.push(await acquireOne(key));
	} catch (error) {
		for (const digest of acquired.reverse()) releaseDigest(digest);
		throw error;
	}
	let released = false;
	return () => {
		if (released) return;
		released = true;
		for (const digest of acquired.reverse()) releaseDigest(digest);
	};
}

/** Run `fn` while holding the locks for `keys`. */
export async function withLocks<T>(keys: readonly string[], fn: () => Promise<T>): Promise<T> {
	const release = await acquireLocks(keys);
	try {
		return await fn();
	} finally {
		release();
	}
}
