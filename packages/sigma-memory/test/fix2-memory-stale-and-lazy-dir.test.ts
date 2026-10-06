import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { SigmaMemory } from "../src/index.ts";
import { VectorStore } from "../src/vector-store.ts";

/** Replace the embedding model with a deterministic fake (no download). */
function fakeEmbeddings(store: VectorStore): { persistCalls: () => number } {
	let persists = 0;
	const internals = store as unknown as {
		ensurePipeline: () => Promise<void>;
		pipeline: (text: string) => Promise<{ data: Float32Array }>;
		persist: () => void;
	};
	internals.ensurePipeline = async () => {
		internals.pipeline = async (text: string) => {
			const n = text.length;
			return { data: new Float32Array([n / 100, (n % 10) / 10, Math.sin(n) / 2 + 0.5, Math.cos(n) / 2 + 0.5]) };
		};
	};
	const originalPersist = internals.persist.bind(store);
	internals.persist = () => {
		persists++;
		originalPersist();
	};
	return { persistCalls: () => persists };
}

describe("fix2-memory: stale vector documents and lazy project memory dir", () => {
	let dir: string;
	const opened: VectorStore[] = [];

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fix2-memory-"));
	});

	afterEach(() => {
		for (const store of opened.splice(0)) store.close();
		rmSync(dir, { recursive: true, force: true });
	});

	function openStore(): { store: VectorStore; persistCalls: () => number } {
		const store = new VectorStore(join(dir, "vectors.db"));
		opened.push(store);
		return { store, ...fakeEmbeddings(store) };
	}

	test("removeMissing drops documents whose source is gone, and writes nothing when none is", async () => {
		const { store, persistCalls } = openStore();
		await store.init();
		await store.addDocument("kept.md", "Kept note content.");
		await store.addDocument("gone.md", "Deleted note content.");

		const before = persistCalls();
		assert.equal(await store.removeMissing(() => true), 0);
		assert.equal(persistCalls(), before, "no disk write when nothing is stale");

		assert.equal(await store.removeMissing((file) => file === "kept.md"), 1);
		const files = (await store.search("note", 10)).map((r) => r.file);
		assert.deepEqual([...new Set(files)], ["kept.md"]);

		// Persisted: a fresh store on the same file sees the pruned state.
		const { store: reopened } = openStore();
		await reopened.init();
		assert.equal(reopened.getStats().documentCount, 1);
	});

	test("pruning replayed on a reloaded image keeps documents another process added meanwhile", async () => {
		const { store: a } = openStore();
		const { store: b } = openStore();
		await a.init();
		await b.init();
		await a.addDocument("gone.md", "Deleted note content.");

		const onDisk = new Set(["fresh.md"]);
		await a.batch(async () => {
			await a.removeMissing((file) => onDisk.has(file));
			// Another process indexes a new note before our batch is written.
			await b.addDocument("fresh.md", "A note written by another phi process.");
		});

		const { store: check } = openStore();
		await check.init();
		const files = new Set((await check.search("note", 10)).map((r) => r.file));
		assert.deepEqual([...files], ["fresh.md"]);
	});

	test("indexNotes removes vectors of notes deleted from disk", async () => {
		const memory = new SigmaMemory({
			memoryDir: dir,
			projectMemoryDir: join(dir, "project", ".phi", "memory"),
			ontologyPath: join(dir, "ontology", "graph.jsonl"),
		});
		opened.push(memory.vectors);
		fakeEmbeddings(memory.vectors);

		memory.notes.write("Alpha note body.", "alpha.md");
		memory.notes.write("Beta note body.", "beta.md");
		await memory.init();
		assert.equal(memory.vectors.getStats().documentCount, 2);

		unlinkSync(join(dir, "notes", "beta.md"));
		await memory.indexNotes();

		assert.equal(memory.vectors.getStats().documentCount, 1);
		const vectorFiles = (await memory.search("note")).filter((r) => r.source === "vectors").map((r) => r.data.file);
		assert.ok(vectorFiles.length > 0);
		assert.ok(vectorFiles.every((file) => file === "alpha.md"));
	});

	test("init and search never create the project memory dir; ensureProjectMemoryDir does", async () => {
		const projectMemoryDir = join(dir, "repo", ".phi", "memory");
		const memory = new SigmaMemory({
			memoryDir: join(dir, "home-memory"),
			projectMemoryDir,
			ontologyPath: join(dir, "home-memory", "ontology", "graph.jsonl"),
		});
		opened.push(memory.vectors);
		fakeEmbeddings(memory.vectors);

		await memory.init();
		await memory.search("anything");
		await memory.status();
		assert.equal(existsSync(join(dir, "repo")), false, "no .phi/memory polluting the opened folder");

		assert.equal(memory.ensureProjectMemoryDir(), projectMemoryDir);
		assert.equal(existsSync(projectMemoryDir), true);
	});

	test("NotesManager.exists is false for missing and path-traversal names", async () => {
		const memory = new SigmaMemory({
			memoryDir: dir,
			projectMemoryDir: join(dir, "project"),
			ontologyPath: join(dir, "ontology", "graph.jsonl"),
		});
		memory.notes.write("x", "present.md");
		assert.equal(memory.notes.exists("present.md"), true);
		assert.equal(memory.notes.exists("absent.md"), false);
		assert.equal(memory.notes.exists("../outside.md"), false);
	});
});
