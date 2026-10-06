import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { defaultUseEmbeddingWorker } from "../src/embedding-worker.ts";
import { VectorStore } from "../src/vector-store.ts";

// Offline stand-in for @huggingface/transformers, loaded BY THE WORKER from disk.
// Vectors encode the text so search order is deterministic.
const FAKE_TRANSFORMERS = `
const env = { cacheDir: "" };
module.exports = {
	env,
	pipeline: async (task, model, options) => {
		if (task !== "feature-extraction") throw new Error("unexpected task " + task);
		if (!env.cacheDir || env.cacheDir !== options.cache_dir) throw new Error("cacheDir not set before pipeline()");
		return async (text) => {
			const v = new Float32Array(4);
			v[0] = text.includes("deploy") ? 1 : 0;
			v[1] = text.includes("cat") ? 1 : 0;
			v[2] = 0.1;
			const n = Math.hypot(...v);
			return { data: v.map((x) => x / n) };
		};
	},
};
`;

describe("fix-embedding-worker: embeddings in a worker thread (macOS process.exit abort)", () => {
	let dir: string;
	let fakeEntry: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fix-embedding-worker-"));
		fakeEntry = join(dir, "fake-transformers.cjs");
		writeFileSync(fakeEntry, FAKE_TRANSFORMERS);
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("addDocument + search work through the worker pipeline", async () => {
		const store = new VectorStore(join(dir, "vectors.db"), {
			modelCacheDir: join(dir, "models"),
			useWorker: true,
			transformersEntry: fakeEntry,
		});
		await store.init();
		await store.addDocument("deploy.md", "The deploy pipeline uses blue green releases.");
		await store.addDocument("cat.md", "The cat sleeps on the sofa.");
		const results = await store.search("how do we deploy", 2);
		assert.equal(results[0].file, "deploy.md");
		store.close();
	});

	test("a worker that cannot load the model rejects explicitly instead of hanging", async () => {
		const broken = join(dir, "broken.cjs");
		writeFileSync(
			broken,
			"module.exports = { pipeline: async () => { throw new Error('model download blocked'); } };",
		);
		const store = new VectorStore(join(dir, "vectors.db"), { useWorker: true, transformersEntry: broken });
		await store.init();
		await assert.rejects(store.addDocument("a.md", "hello"), /model download blocked/);
		store.close();
	});

	test("an idle worker does not keep the process alive", () => {
		const script = join(dir, "child.ts");
		writeFileSync(
			script,
			`import { VectorStore } from ${JSON.stringify(join(__dirname, "..", "src", "vector-store.ts"))};
const store = new VectorStore(${JSON.stringify(join(dir, "child.db"))}, { modelCacheDir: ${JSON.stringify(join(dir, "models"))}, useWorker: true, transformersEntry: ${JSON.stringify(fakeEntry)} });
store.init().then(() => store.addDocument("a.md", "deploy")).then(() => console.log("embedded"));
`,
		);
		const res = spawnSync(process.execPath, [...process.execArgv, script], { encoding: "utf8", timeout: 30_000 });
		assert.equal(res.error, undefined, `child did not exit by itself: ${res.error?.message}`);
		assert.equal(res.status, 0, res.stderr);
		assert.match(res.stdout, /embedded/);
	});

	test("default: worker on macOS under Node only, PHI_EMBEDDING_WORKER overrides", () => {
		assert.equal(defaultUseEmbeddingWorker({}, "darwin", false), true);
		assert.equal(defaultUseEmbeddingWorker({}, "darwin", true), false);
		assert.equal(defaultUseEmbeddingWorker({}, "linux", false), false);
		assert.equal(defaultUseEmbeddingWorker({}, "win32", false), false);
		assert.equal(defaultUseEmbeddingWorker({ PHI_EMBEDDING_WORKER: "1" }, "linux", false), true);
		assert.equal(defaultUseEmbeddingWorker({ PHI_EMBEDDING_WORKER: "0" }, "darwin", false), false);
	});

	test("an injected in-process loader keeps the in-process pipeline", () => {
		const store = new VectorStore(join(dir, "vectors.db"), { loadTransformers: async () => ({}) });
		assert.equal((store as unknown as { useWorker: boolean }).useWorker, false);
	});
});
