import { lockSync } from "proper-lockfile";

/**
 * Run fn while holding an exclusive inter-process lock on `path`, so two phi
 * instances writing the same memory file cannot interleave or overwrite each
 * other. proper-lockfile has no sync retry support, so contention is handled
 * with a short bounded spin; locked sections are short (an append, or one
 * in-memory DB export + rename) and contention is rare. A lock left by a
 * crashed process goes stale after 5s and is taken over.
 *
 * Shared by the ontology graph (graph.jsonl) and the vector store (vectors.db).
 */
export function withFileLockSync<T>(path: string, fn: () => T, timeoutMs = 2_000): T {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		let release: (() => void) | undefined;
		try {
			// realpath:false: the locked file may not exist before the first write.
			release = lockSync(path, { realpath: false, stale: 5_000 });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ELOCKED" && Date.now() < deadline) {
				const until = Date.now() + 15;
				while (Date.now() < until) {
					// bounded spin-wait between lock attempts (sync context, no timers)
				}
				continue;
			}
			throw error;
		}
		try {
			return fn();
		} finally {
			release();
		}
	}
}
