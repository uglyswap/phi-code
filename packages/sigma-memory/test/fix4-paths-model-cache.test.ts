import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { SigmaMemory } from "../src/index.ts";
import { VectorStore } from "../src/vector-store.ts";

interface FakeTransformers {
	env: { cacheDir: string };
	pipeline: (task: string, model: string, options: Record<string, unknown>) => Promise<unknown>;
	calls: Array<{ cacheDirAtCall: string; dirExisted: boolean; options: Record<string, unknown> }>;
}

/** Offline stand-in for @huggingface/transformers that records the cache state at pipeline() time. */
function fakeTransformers(): FakeTransformers {
	const fake: FakeTransformers = {
		env: { cacheDir: "./node_modules/@huggingface/transformers/.cache" },
		calls: [],
		pipeline: async (_task, _model, options) => {
			fake.calls.push({
				cacheDirAtCall: fake.env.cacheDir,
				dirExisted: existsSync(fake.env.cacheDir),
				options,
			});
			return async () => ({ data: new Float32Array([0.1, 0.2, 0.3]) });
		},
	};
	return fake;
}

function loadModel(store: VectorStore): Promise<void> {
	return (store as unknown as { loadEmbeddingModel: () => Promise<void> }).loadEmbeddingModel();
}

describe("fix4-paths: embedding model cache directory", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fix4-paths-model-cache-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("env.cacheDir is set (and the directory created) before the pipeline is loaded", async () => {
		const cacheDir = join(dir, "cache", "models");
		const fake = fakeTransformers();
		const store = new VectorStore(join(dir, "vectors.db"), {
			modelCacheDir: cacheDir,
			loadTransformers: async () => fake,
		});

		await loadModel(store);

		assert.equal(fake.calls.length, 1);
		assert.equal(fake.calls[0].cacheDirAtCall, cacheDir);
		assert.equal(fake.calls[0].dirExisted, true);
		assert.equal(fake.calls[0].options.cache_dir, cacheDir);
	});

	test("SigmaMemory defaults the model cache to <memoryDir>/models", () => {
		const memoryDir = join(dir, "memory");
		const memory = new SigmaMemory({ memoryDir, ontologyPath: join(memoryDir, "ontology", "graph.jsonl") });
		const vectors = memory.vectors as unknown as { modelCacheDir: string | undefined };
		assert.equal(vectors.modelCacheDir, join(memoryDir, "models"));
	});

	test("SigmaMemory forwards an explicit modelCacheDir", () => {
		const memoryDir = join(dir, "memory");
		const modelCacheDir = join(dir, "agent", "cache", "models");
		const memory = new SigmaMemory({
			memoryDir,
			ontologyPath: join(memoryDir, "ontology", "graph.jsonl"),
			modelCacheDir,
		});
		const vectors = memory.vectors as unknown as { modelCacheDir: string | undefined };
		assert.equal(vectors.modelCacheDir, modelCacheDir);
	});
});
