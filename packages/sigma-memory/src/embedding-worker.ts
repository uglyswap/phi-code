import { Worker } from "worker_threads";

/**
 * Runs the transformers.js feature-extraction pipeline in a worker thread.
 *
 * Why: onnxruntime-node 1.21.0 (pinned exactly by @huggingface/transformers
 * 3.8.x) aborts the whole process on macOS when the process calls
 * process.exit() while an ONNX session lives on the main thread:
 * "libc++abi: terminating due to uncaught exception of type
 * std::__1::system_error: mutex lock failed: Invalid argument" (exit 134).
 * phi quits through process.exit(), so every macOS session that used memory
 * ended with that abort. Fixed upstream in onnxruntime-node >= 1.24, which
 * transformers 3.x cannot use. A worker's environment is torn down (ONNX
 * objects released) before the process exits, which avoids the abort with
 * the current dependency (verified on macos-latest, install smoke workflow).
 */

/** Same call shape as the in-process pipeline: (text, options) => { data }. */
export type EmbeddingPipeline = ((
	text: string,
	options: Record<string, unknown>,
) => Promise<{ data: Float32Array }>) & {
	dispose: () => Promise<void>;
};

// Plain CommonJS worker source (eval): no extra file to ship or to locate in
// the dist/, jiti or bundled layouts.
const WORKER_SOURCE = `
const { parentPort, workerData } = require("worker_threads");
const { pathToFileURL } = require("url");
(async () => {
	const loaded = await import(pathToFileURL(workerData.transformersEntry).href);
	const mod = typeof loaded.pipeline === "function" ? loaded : loaded.default;
	if (!mod || typeof mod.pipeline !== "function") throw new Error("@huggingface/transformers does not export pipeline()");
	if (workerData.modelCacheDir && mod.env && typeof mod.env === "object") mod.env.cacheDir = workerData.modelCacheDir;
	const pipe = await mod.pipeline(workerData.task, workerData.model, workerData.options);
	parentPort.on("message", async (msg) => {
		try {
			const out = await pipe(msg.text, msg.options);
			parentPort.postMessage({ id: msg.id, data: Float32Array.from(out.data) });
		} catch (error) {
			parentPort.postMessage({ id: msg.id, error: String((error && error.message) || error) });
		}
	});
	parentPort.postMessage({ ready: true });
})().catch((error) => parentPort.postMessage({ fatal: String((error && error.stack) || error) }));
`;

export interface WorkerPipelineOptions {
	/** Absolute path of the @huggingface/transformers entry to load in the worker. */
	transformersEntry: string;
	modelCacheDir?: string;
	task: string;
	model: string;
	options: Record<string, unknown>;
}

/** Starts the worker, loads the model there, resolves once it is ready. */
export function createWorkerPipeline(config: WorkerPipelineOptions): Promise<EmbeddingPipeline> {
	const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: config });
	const pending = new Map<number, { resolve: (v: { data: Float32Array }) => void; reject: (e: Error) => void }>();
	let nextId = 0;
	let failure: Error | undefined;
	// The worker keeps the process alive only while it has work (model load or
	// pending requests): an idle worker must never delay the process exit.
	const updateRef = () => (pending.size > 0 ? worker.ref() : worker.unref());
	const failAll = (error: Error) => {
		failure = error;
		for (const p of pending.values()) p.reject(error);
		pending.clear();
	};

	return new Promise((resolveReady, rejectReady) => {
		worker.on(
			"message",
			(msg: { ready?: true; fatal?: string; id?: number; data?: Float32Array; error?: string }) => {
				if (msg.ready) {
					const run = ((text: string, options: Record<string, unknown>) => {
						if (failure) return Promise.reject(failure);
						const id = nextId++;
						return new Promise<{ data: Float32Array }>((resolve, reject) => {
							pending.set(id, { resolve, reject });
							updateRef();
							worker.postMessage({ id, text, options });
						});
					}) as EmbeddingPipeline;
					run.dispose = async () => {
						failAll(new Error("embedding worker disposed"));
						await worker.terminate();
					};
					updateRef();
					resolveReady(run);
					return;
				}
				if (msg.fatal !== undefined) {
					const error = new Error(`embedding worker failed to load the model: ${msg.fatal}`);
					failAll(error);
					rejectReady(error);
					void worker.terminate();
					return;
				}
				if (msg.id === undefined) return;
				const p = pending.get(msg.id);
				if (!p) return;
				pending.delete(msg.id);
				updateRef();
				if (msg.error !== undefined) p.reject(new Error(msg.error));
				else p.resolve({ data: msg.data as Float32Array });
			},
		);
		worker.on("error", (error) => {
			failAll(error);
			rejectReady(error);
		});
		worker.on("exit", (code) => {
			const error = new Error(`embedding worker exited (code ${code})`);
			failAll(error);
			rejectReady(error);
		});
	});
}

/**
 * Whether embeddings run in a worker by default: macOS under Node only (the
 * abort is specific to onnxruntime-node's static teardown on macOS; the Bun
 * binary keeps the in-process pipeline). PHI_EMBEDDING_WORKER=1|0 overrides.
 */
export function defaultUseEmbeddingWorker(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
	isBun: boolean = typeof (process.versions as Record<string, string | undefined>).bun === "string",
): boolean {
	if (env.PHI_EMBEDDING_WORKER === "1") return true;
	if (env.PHI_EMBEDDING_WORKER === "0") return false;
	return platform === "darwin" && !isBun;
}
