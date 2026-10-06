import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { VectorStore } from "../src/vector-store.ts";

/** Store with a deterministic fake embedding model; counts embed calls. */
function createStore(dbPath: string): { store: VectorStore; embedCalls: () => number; persistCalls: () => number } {
	const store = new VectorStore(dbPath);
	let embeds = 0;
	let persists = 0;
	const internals = store as unknown as {
		ensurePipeline: () => Promise<void>;
		pipeline: (text: string) => Promise<{ data: Float32Array }>;
		persist: () => void;
	};
	internals.ensurePipeline = async () => {
		internals.pipeline = async (text: string) => {
			embeds++;
			const n = text.length;
			return { data: new Float32Array([n / 100, (n % 10) / 10, Math.sin(n) / 2 + 0.5, Math.cos(n) / 2 + 0.5]) };
		};
	};
	const originalPersist = internals.persist.bind(store);
	internals.persist = () => {
		persists++;
		originalPersist();
	};
	return { store, embedCalls: () => embeds, persistCalls: () => persists };
}

describe("fix-ext: VectorStore incremental indexing, batching and inter-process safety", () => {
	let dir: string;
	let dbPath: string;
	const opened: VectorStore[] = [];

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fix-ext-vectors-"));
		dbPath = join(dir, "vectors.db");
	});

	afterEach(() => {
		for (const store of opened.splice(0)) store.close();
		rmSync(dir, { recursive: true, force: true });
	});

	function open(): ReturnType<typeof createStore> {
		const created = createStore(dbPath);
		opened.push(created.store);
		return created;
	}

	test("re-adding an unchanged document does not re-embed nor rewrite the DB", async () => {
		const { store, embedCalls, persistCalls } = open();
		await store.init();
		assert.equal(await store.addDocument("a.md", "First paragraph.\n\nSecond paragraph."), true);
		const embedsAfterFirst = embedCalls();
		const persistsAfterFirst = persistCalls();
		assert.ok(embedsAfterFirst > 0);

		assert.equal(await store.addDocument("a.md", "First paragraph.\n\nSecond paragraph."), false);
		assert.equal(embedCalls(), embedsAfterFirst);
		assert.equal(persistCalls(), persistsAfterFirst);

		assert.equal(await store.addDocument("a.md", "First paragraph.\n\nChanged paragraph."), true);
		assert.ok(embedCalls() > embedsAfterFirst);
	});

	test("unchanged documents are skipped after a restart (startup re-index)", async () => {
		const first = open();
		await first.store.init();
		await first.store.addDocument("a.md", "Some note content.");
		first.store.close();

		const second = open();
		await second.store.init();
		assert.equal(await second.store.addDocument("a.md", "Some note content."), false);
		assert.equal(second.embedCalls(), 0);
	});

	test("batch() groups many documents into a single disk write", async () => {
		const { store, persistCalls } = open();
		await store.init();
		const before = persistCalls();
		await store.batch(async () => {
			for (let i = 0; i < 5; i++) await store.addDocument(`n${i}.md`, `Note number ${i}.`);
		});
		assert.equal(persistCalls() - before, 1);
		assert.equal(store.getStats().documentCount, 5);
	});

	test("two instances on the same file do not overwrite each other's documents", async () => {
		const a = open();
		const b = open();
		await a.store.init();
		await b.store.init();

		await a.store.addDocument("from-a.md", "Written by process A.");
		await b.store.addDocument("from-b.md", "Written by process B.");
		await a.store.addDocument("from-a-2.md", "Written later by process A.");

		const fresh = open();
		await fresh.store.init();
		assert.equal(fresh.store.getStats().documentCount, 3);
		// A sees B's document too (reloaded from disk).
		assert.equal(a.store.getStats().documentCount, 3);
	});

	test("close() does not clobber documents written by another instance", async () => {
		const a = open();
		const b = open();
		await a.store.init();
		await b.store.init();
		await b.store.addDocument("from-b.md", "Written by process B.");
		a.store.close();

		const fresh = open();
		await fresh.store.init();
		assert.equal(fresh.store.getStats().documentCount, 1);
	});
});
