/**
 * Several phi processes share ~/.phi/memory. Two guarantees:
 * - a note is created exclusively ("wx"): a file that appears between the existence
 *   check and the write (another process) is never overwritten;
 * - VectorStore.init() can be retried after a failure (vectors.db locked by another
 *   process for longer than the lock wait) instead of failing for the whole process.
 */
import { strict as assert } from "node:assert";
import fs, { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { lockSync } from "proper-lockfile";
import { NotesManager } from "../src/notes.ts";
import type { MemoryConfig } from "../src/types.ts";
import { VectorStore } from "../src/vector-store.ts";

describe("sigma-memory concurrency", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "sigma-concurrency-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	test("a note created after the existence check is never overwritten", () => {
		const config: MemoryConfig = {
			memoryDir: tempDir,
			projectMemoryDir: join(tempDir, "project"),
			ontologyPath: join(tempDir, "ontology", "graph.jsonl"),
		};
		const notes = new NotesManager(config);
		const firstPath = join(tempDir, "notes", "same.md");
		writeFileSync(firstPath, "first");

		// Another process creates same.md right after this one checked that it did not exist.
		const realExistsSync = fs.existsSync;
		fs.existsSync = ((path: fs.PathLike) =>
			String(path).endsWith(`${sep}same.md`) ? false : realExistsSync(path)) as typeof fs.existsSync;
		syncBuiltinESMExports();
		let written: string;
		try {
			written = notes.write("second", "same.md");
		} finally {
			fs.existsSync = realExistsSync;
			syncBuiltinESMExports();
		}

		assert.equal(written, "same-2.md");
		assert.equal(readFileSync(firstPath, "utf8"), "first");
		assert.equal(readFileSync(join(tempDir, "notes", "same-2.md"), "utf8"), "second");
	});

	test("init() can be retried after a failed attempt", async () => {
		const dbPath = join(tempDir, "vectors.db");
		const store = new VectorStore(dbPath);

		// Another process holds the vectors.db lock longer than init() waits for it.
		const release = lockSync(dbPath, { realpath: false, stale: 5_000 });
		await assert.rejects(store.init(), (error: NodeJS.ErrnoException) => error.code === "ELOCKED");
		release();

		await store.init();
		assert.deepEqual(store.getStats(), { documentCount: 0, chunkCount: 0, lastUpdate: "" });
		store.close();
	});
});
