import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "fs";
import { dirname } from "path";
import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";
import { withFileLockSync } from "./file-lock.ts";
import type { VectorSearchResult } from "./types.ts";

/**
 * Helper for loading ESM-only modules from a CJS context.
 * Uses native import() via Function constructor to bypass
 * TypeScript's CJS transformation of dynamic imports.
 */
const esmImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<any>;

/**
 * Load the `pipeline` factory of @huggingface/transformers. A missing or
 * broken install fails with an explicit message (instead of a bare
 * ERR_MODULE_NOT_FOUND) so callers can report that only vector search is
 * unavailable; notes and ontology search keep working without it.
 */
async function loadTransformersPipeline(
	loadModule: () => Promise<unknown>,
	modelCacheDir: string | undefined,
): Promise<(...args: any[]) => Promise<any>> {
	let mod: { pipeline?: unknown; env?: { cacheDir?: string } };
	try {
		mod = (await loadModule()) as typeof mod;
	} catch (error) {
		throw new Error(
			`Vector search unavailable: cannot load @huggingface/transformers (${error instanceof Error ? error.message : String(error)}). Reinstall phi-code to restore it; full-text note search still works.`,
		);
	}
	if (typeof mod.pipeline !== "function") {
		throw new Error("Vector search unavailable: @huggingface/transformers does not export pipeline().");
	}
	// The library's default cache is <its own package dir>/.cache: wiped by
	// every update and unwritable (EACCES) for a global sudo npm install. Point
	// it at a stable per-user directory before any model is loaded.
	if (modelCacheDir && mod.env && typeof mod.env === "object") {
		mod.env.cacheDir = modelCacheDir;
	}
	return mod.pipeline as (...args: any[]) => Promise<any>;
}

export interface VectorStoreOptions {
	/** Directory where the embedding model is cached (created on first model load). */
	modelCacheDir?: string;
	/**
	 * Loader for the @huggingface/transformers module. Defaults to a native
	 * dynamic import; tests inject a fake module to stay offline.
	 * @internal
	 */
	loadTransformers?: () => Promise<unknown>;
}

// The vector store initializes and loads its embedding model in the background
// while the TUI is up. Writing to stdout/stderr directly corrupts the input
// line, so these diagnostics are opt-in (set PHI_MEMORY_VERBOSE=1 or PHI_DEBUG=1).
const VERBOSE = process.env.PHI_MEMORY_VERBOSE === "1" || process.env.PHI_DEBUG === "1";
function vlog(message: string): void {
	if (VERBOSE) console.error(message);
}

/**
 * Self-contained vector store using sql.js (SQLite via WebAssembly) and
 * @huggingface/transformers for local embeddings.
 *
 * Zero configuration — works out of the box on any platform.
 * No native compilation required.
 *
 * Persistence: the DB lives in memory (sql.js) and is written to disk as a
 * whole image. Several phi processes may share the same vectors.db, so every
 * write is a read-modify-write under an inter-process lock (same mechanism as
 * the ontology graph): if another process changed the file since we last read
 * it, the image is reloaded and our pending mutations are replayed on top of
 * it before writing, so neither side's documents are lost. Writes can be
 * grouped with batch() to export the image once instead of once per document.
 */
export class VectorStore {
	private db: Database | null = null;
	private SQL: SqlJsStatic | null = null;
	private pipeline: any = null;
	private dbPath: string;
	private initialized = false;
	private initPromise: Promise<void> | null = null;
	private modelPromise: Promise<void> | null = null;
	/** mtime+size of vectors.db when we last read or wrote it; null when absent. */
	private diskSignature: string | null = null;
	/** Mutations applied in memory but not yet written to disk (replayed after a reload). */
	private pending: Array<(db: Database) => void> = [];
	private batchDepth = 0;

	private readonly modelCacheDir: string | undefined;
	private readonly loadTransformers: () => Promise<unknown>;

	constructor(dbPath: string, options: VectorStoreOptions = {}) {
		this.dbPath = dbPath;
		this.modelCacheDir = options.modelCacheDir;
		this.loadTransformers = options.loadTransformers ?? (() => esmImport("@huggingface/transformers"));
	}

	/**
	 * Initialize the vector store: sets up the SQLite database.
	 * The embedding model is loaded lazily on first embed operation.
	 * Safe to call multiple times — only initializes once.
	 */
	async init(): Promise<void> {
		if (this.initialized) return;
		if (this.initPromise) return this.initPromise;

		this.initPromise = this._init();
		await this.initPromise;
	}

	private async _init(): Promise<void> {
		// Ensure directory exists
		const dir = dirname(this.dbPath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}

		// Initialize sql.js (loads WASM automatically)
		this.SQL = await initSqlJs();

		withFileLockSync(this.dbPath, () => {
			const healthy = this.loadFromDisk();
			// Write only when there is no usable image yet (first run, or a
			// corrupt file replaced by a fresh DB). Re-writing an intact image
			// on every start would race with other processes for nothing.
			if (!healthy) this.persist();
		});
		this.initialized = true;
	}

	private static ensureSchema(db: Database): void {
		db.run(`
      CREATE TABLE IF NOT EXISTS documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        content TEXT NOT NULL,
        embedding BLOB NOT NULL,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(file, chunk_index)
      )
    `);
		// Index for fast file lookups
		db.run("CREATE INDEX IF NOT EXISTS idx_documents_file ON documents(file)");
	}

	/** Cheap change detector for the on-disk image (null when the file is absent). */
	private readDiskSignature(): string | null {
		try {
			const stats = statSync(this.dbPath);
			return `${stats.mtimeMs}:${stats.size}`;
		} catch {
			return null;
		}
	}

	/**
	 * (Re)load the in-memory DB from the on-disk image. Returns false when no
	 * usable image exists (absent, or corrupt: e.g. a previous crash left a
	 * truncated file); a fresh DB is used then, so the store self-heals rather
	 * than staying permanently dead behind a swallowed catch upstream.
	 */
	private loadFromDisk(): boolean {
		if (!this.SQL) throw new Error("VectorStore not initialized. Call init() first.");
		const signature = this.readDiskSignature();
		let db: Database;
		let healthy = false;
		if (signature !== null) {
			try {
				db = new this.SQL.Database(readFileSync(this.dbPath));
				VectorStore.ensureSchema(db);
				healthy = true;
			} catch (error) {
				vlog(
					`[VectorStore] Failed to load existing DB at ${this.dbPath} (${error instanceof Error ? error.message : String(error)}); starting from a fresh database.`,
				);
				db = new this.SQL.Database();
				VectorStore.ensureSchema(db);
			}
		} else {
			db = new this.SQL.Database();
			VectorStore.ensureSchema(db);
		}
		this.db?.close();
		this.db = db;
		this.diskSignature = signature;
		return healthy;
	}

	/**
	 * Pick up writes made by another process since we last read or wrote the
	 * file. Only done when nothing is pending: pending mutations are replayed
	 * on the fresh image by commit() instead.
	 */
	private refreshFromDisk(): void {
		if (!this.db || this.pending.length > 0) return;
		if (this.readDiskSignature() === this.diskSignature) return;
		withFileLockSync(this.dbPath, () => {
			this.loadFromDisk();
		});
	}

	/** Apply a mutation now (in memory) and write it to disk unless a batch is open. */
	private mutate(apply: (db: Database) => void): void {
		if (!this.db) throw new Error("VectorStore not initialized. Call init() first.");
		apply(this.db);
		this.pending.push(apply);
		if (this.batchDepth === 0) this.commit();
	}

	/**
	 * Write pending mutations: under the file lock, reload the on-disk image if
	 * another process changed it, replay our mutations on top, then write.
	 */
	private commit(): void {
		if (!this.db || this.pending.length === 0) return;
		withFileLockSync(this.dbPath, () => {
			if (this.readDiskSignature() !== this.diskSignature) {
				this.loadFromDisk();
				for (const apply of this.pending) apply(this.db as Database);
			}
			this.persist();
		});
		this.pending = [];
	}

	/**
	 * Group the writes made inside fn into a single disk write (one export of
	 * the whole DB image instead of one per document). Nested calls are merged.
	 */
	async batch<T>(fn: () => Promise<T>): Promise<T> {
		this.batchDepth++;
		try {
			return await fn();
		} finally {
			this.batchDepth--;
			if (this.batchDepth === 0) this.commit();
		}
	}

	/**
	 * Load the embedding model. Called lazily on first embed operation.
	 * Downloads the model on first use (~23MB for all-MiniLM-L6-v2).
	 */
	private async loadEmbeddingModel(): Promise<void> {
		if (this.pipeline) return;
		if (this.modelPromise) return this.modelPromise;

		this.modelPromise = (async () => {
			// Choose the smallest quantised variant by default. The model
			// (Xenova/all-MiniLM-L6-v2) ships in three flavours on the HF
			// hub: fp32 (~90 MB), fp16 (~45 MB), q8 (~22 MB). On CPU — which
			// is where phi-code's memory subsystem runs — q8 is 2-3× faster
			// than fp32 with negligible quality loss for 384-dim sentence
			// embeddings. Override with PHI_EMBEDDING_DTYPE=fp32|fp16|q8.
			const requestedDtype = process.env.PHI_EMBEDDING_DTYPE;
			const dtype: "fp32" | "fp16" | "q8" =
				requestedDtype === "fp32" || requestedDtype === "fp16" || requestedDtype === "q8" ? requestedDtype : "q8";

			vlog(`[VectorStore] Loading embedding model (Xenova/all-MiniLM-L6-v2, dtype=${dtype})...`);
			vlog(
				`[VectorStore] First run may download the model (~${dtype === "q8" ? "22" : dtype === "fp16" ? "45" : "90"}MB).`,
			);

			// Dynamic ESM import for @huggingface/transformers. The bare specifier
			// resolves from this module's own (real) location, not from the cwd,
			// in Node, Bun and the compiled Bun binary (verified through jiti and
			// the ~/.phi/agent/extensions/node_modules link).
			if (this.modelCacheDir) mkdirSync(this.modelCacheDir, { recursive: true });
			const createPipeline = await loadTransformersPipeline(this.loadTransformers, this.modelCacheDir);

			this.pipeline = await createPipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
				dtype,
				...(this.modelCacheDir ? { cache_dir: this.modelCacheDir } : {}),
			});

			vlog("[VectorStore] Embedding model loaded.");
		})();

		await this.modelPromise;
	}

	/**
	 * Ensure the embedding model is loaded before use.
	 */
	private async ensurePipeline(): Promise<void> {
		if (!this.pipeline) {
			await this.loadEmbeddingModel();
		}
	}

	/**
	 * Persist the in-memory SQLite database to disk. Callers hold the file lock.
	 */
	private persist(): void {
		if (!this.db) return;
		const data = this.db.export();
		const buffer = Buffer.from(data);
		// Write to a sibling temp file then atomically rename into place.
		// rename is atomic on the same filesystem, so a crash/power loss
		// leaves either the previous or the new full image, never a
		// truncated/corrupted vectors.db.
		// Unique temp name per call: a PID-only suffix collides when two
		// persist() calls run concurrently in the same process, causing the
		// second renameSync to fail ENOENT or a torn image to be renamed.
		const tmpPath = `${this.dbPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		writeFileSync(tmpPath, buffer);
		renameSync(tmpPath, this.dbPath);
		// Our own write must not look like an external change.
		this.diskSignature = this.readDiskSignature();
	}

	/**
	 * Embed text into a Float32Array vector (384 dimensions).
	 */
	private async embed(text: string): Promise<Float32Array> {
		await this.ensurePipeline();

		const output = await this.pipeline(text, { pooling: "mean", normalize: true });
		return new Float32Array(output.data);
	}

	/**
	 * Chunk text into overlapping segments.
	 *
	 * Strategy:
	 * 1. Split by paragraphs (double newline)
	 * 2. If a paragraph exceeds 500 chars, split by sentences
	 * 3. Each chunk gets a 100-char overlap with the previous chunk
	 */
	private chunkText(text: string): string[] {
		const MAX_CHUNK_SIZE = 500;
		const OVERLAP = 100;

		// Split by paragraphs (double newline)
		const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim().length > 0);

		const rawChunks: string[] = [];

		for (const paragraph of paragraphs) {
			const trimmed = paragraph.trim();

			if (trimmed.length <= MAX_CHUNK_SIZE) {
				rawChunks.push(trimmed);
			} else {
				// Split long paragraphs by sentences
				const sentences = trimmed.split(/(?<=[.!?])\s+/);
				let current = "";

				for (const sentence of sentences) {
					if (current.length + sentence.length + 1 > MAX_CHUNK_SIZE && current.length > 0) {
						rawChunks.push(current.trim());
						current = sentence;
					} else {
						current = current ? `${current} ${sentence}` : sentence;
					}
				}

				if (current.trim().length > 0) {
					rawChunks.push(current.trim());
				}
			}
		}

		if (rawChunks.length === 0) return [];

		// Apply overlap: each chunk (except the first) gets the last 100 chars
		// of the previous chunk prepended
		const chunks: string[] = [rawChunks[0]];

		for (let i = 1; i < rawChunks.length; i++) {
			const prevChunk = rawChunks[i - 1];
			const overlap = prevChunk.slice(-OVERLAP);
			chunks.push(`${overlap} ${rawChunks[i]}`);
		}

		return chunks;
	}

	/**
	 * Serialize a Float32Array to a Buffer for BLOB storage.
	 */
	private serializeEmbedding(embedding: Float32Array): Uint8Array {
		return new Uint8Array(embedding.buffer, embedding.byteOffset, embedding.byteLength);
	}

	/**
	 * Deserialize a BLOB (Uint8Array) back to Float32Array.
	 */
	private deserializeEmbedding(blob: Uint8Array): Float32Array {
		// A truncated/corrupt blob whose length is not a multiple of 4 would
		// make the Float32Array constructor throw. Return an empty vector
		// instead so a single bad row scores 0 rather than crashing search.
		if (blob.byteLength % 4 !== 0) return new Float32Array(0);
		// Create a proper copy to ensure alignment
		const buffer = new ArrayBuffer(blob.byteLength);
		new Uint8Array(buffer).set(blob);
		return new Float32Array(buffer);
	}

	/**
	 * Compute cosine similarity between two vectors.
	 * Both vectors should be normalized (which they are from the model),
	 * so this is equivalent to the dot product.
	 */
	private cosineSimilarity(a: Float32Array, b: Float32Array): number {
		// Mismatched dimensions (different model/dtype, or a truncated blob)
		// would read undefined and produce NaN, corrupting the search sort.
		if (a.length !== b.length) return 0;

		let dotProduct = 0;
		let normA = 0;
		let normB = 0;

		for (let i = 0; i < a.length; i++) {
			dotProduct += a[i] * b[i];
			normA += a[i] * a[i];
			normB += b[i] * b[i];
		}

		const denominator = Math.sqrt(normA) * Math.sqrt(normB);
		if (denominator === 0) return 0;

		return dotProduct / denominator;
	}

	/** Stored chunk texts for a file, in chunk order. */
	private storedChunks(file: string): string[] {
		if (!this.db) return [];
		const stmt = this.db.prepare("SELECT content FROM documents WHERE file = ? ORDER BY chunk_index");
		try {
			stmt.bind([file]);
			const contents: string[] = [];
			while (stmt.step()) contents.push(String(stmt.get()[0]));
			return contents;
		} finally {
			stmt.free();
		}
	}

	/**
	 * Add a document to the vector store.
	 * Chunks the content, embeds each chunk, and stores in the DB.
	 * Replaces any existing chunks for this file. A document whose chunks are
	 * already stored unchanged is skipped (no re-embedding, no disk write), so
	 * re-indexing all notes at startup only embeds new or modified notes.
	 * Resolves to true when the document was (re)indexed.
	 */
	async addDocument(file: string, content: string): Promise<boolean> {
		if (!this.db) throw new Error("VectorStore not initialized. Call init() first.");

		const chunks = this.chunkText(content);
		if (chunks.length === 0) return false;

		this.refreshFromDisk();
		const stored = this.storedChunks(file);
		if (stored.length === chunks.length && stored.every((text, i) => text === chunks[i])) return false;

		// Embed outside the lock (slow), then apply the replace in one mutation.
		const blobs: Uint8Array[] = [];
		for (const chunk of chunks) {
			blobs.push(this.serializeEmbedding(await this.embed(chunk)));
		}
		const now = new Date().toISOString();

		this.mutate((db) => {
			// Remove existing chunks for this file
			db.run("DELETE FROM documents WHERE file = ?", [file]);
			for (let i = 0; i < chunks.length; i++) {
				db.run("INSERT INTO documents (file, chunk_index, content, embedding, updated_at) VALUES (?, ?, ?, ?, ?)", [
					file,
					i,
					chunks[i],
					blobs[i] as any,
					now,
				]);
			}
		});
		return true;
	}

	/**
	 * Search the vector store for content similar to the query.
	 * Returns top-k results sorted by cosine similarity (descending).
	 *
	 * For performance with large DBs (>10K chunks), embeddings are loaded
	 * as Float32Array and compared using optimized JS computation.
	 */
	async search(query: string, limit: number = 10): Promise<VectorSearchResult[]> {
		if (!this.db) throw new Error("VectorStore not initialized. Call init() first.");

		// Embed the query
		const queryEmbedding = await this.embed(query);
		this.refreshFromDisk();

		// Load all documents with embeddings
		const results = this.db.exec("SELECT file, chunk_index, content, embedding FROM documents");

		if (results.length === 0 || results[0].values.length === 0) {
			return [];
		}

		// Compute cosine similarity for each document
		const scored: VectorSearchResult[] = [];

		for (const row of results[0].values) {
			const [file, chunkIndex, content, embeddingBlob] = row as [string, number, string, Uint8Array];

			const docEmbedding = this.deserializeEmbedding(
				embeddingBlob instanceof Uint8Array ? embeddingBlob : new Uint8Array(embeddingBlob as any),
			);

			const score = this.cosineSimilarity(queryEmbedding, docEmbedding);

			scored.push({
				file: file as string,
				chunkIndex: chunkIndex as number,
				content: content as string,
				score,
			});
		}

		// Sort by score descending and return top-k
		scored.sort((a, b) => b.score - a.score);
		return scored.slice(0, limit);
	}

	/**
	 * Remove all chunks for a given file.
	 */
	async removeDocument(file: string): Promise<void> {
		if (!this.db) throw new Error("VectorStore not initialized. Call init() first.");

		this.mutate((db) => {
			db.run("DELETE FROM documents WHERE file = ?", [file]);
		});
	}

	/** Distinct file names that have chunks in the given DB. */
	private static indexedFiles(db: Database): string[] {
		const result = db.exec("SELECT DISTINCT file FROM documents");
		return result.length > 0 ? result[0].values.map((row) => String(row[0])) : [];
	}

	/**
	 * Remove every document whose source no longer exists (exists(file) is
	 * false), e.g. a note deleted from disk: otherwise search keeps returning
	 * hits pointing at files that are gone. The predicate is re-evaluated when
	 * the mutation is replayed under the file lock on a reloaded image, so a
	 * file re-created meanwhile by another process is not dropped. Nothing is
	 * written when nothing is stale. Resolves to the number of files removed.
	 */
	async removeMissing(exists: (file: string) => boolean): Promise<number> {
		if (!this.db) throw new Error("VectorStore not initialized. Call init() first.");

		this.refreshFromDisk();
		const stale = VectorStore.indexedFiles(this.db).filter((file) => !exists(file));
		if (stale.length === 0) return 0;

		this.mutate((db) => {
			for (const file of VectorStore.indexedFiles(db)) {
				if (!exists(file)) db.run("DELETE FROM documents WHERE file = ?", [file]);
			}
		});
		return stale.length;
	}

	/**
	 * Full reindex from a file map (filename → content).
	 * Clears all existing data and re-indexes everything.
	 */
	async reindex(files: Map<string, string>): Promise<void> {
		if (!this.db) throw new Error("VectorStore not initialized. Call init() first.");

		// One disk write for the whole reindex.
		await this.batch(async () => {
			// Clear all existing documents
			this.mutate((db) => {
				db.run("DELETE FROM documents");
			});

			// Re-add all files
			for (const [file, content] of files) {
				await this.addDocument(file, content);
			}
		});
	}

	/**
	 * Get statistics about the vector store.
	 */
	getStats(): { documentCount: number; chunkCount: number; lastUpdate: string } {
		if (!this.db) {
			return { documentCount: 0, chunkCount: 0, lastUpdate: "" };
		}
		this.refreshFromDisk();

		const countResult = this.db.exec("SELECT COUNT(DISTINCT file) as docs, COUNT(*) as chunks FROM documents");
		const updateResult = this.db.exec("SELECT MAX(updated_at) as last_update FROM documents");

		const docs =
			countResult.length > 0 && countResult[0].values.length > 0 ? (countResult[0].values[0][0] as number) : 0;

		const chunks =
			countResult.length > 0 && countResult[0].values.length > 0 ? (countResult[0].values[0][1] as number) : 0;

		const lastUpdate =
			updateResult.length > 0 && updateResult[0].values.length > 0
				? (updateResult[0].values[0][0] as string) || ""
				: "";

		return { documentCount: docs, chunkCount: chunks, lastUpdate };
	}

	/**
	 * Close the database connection, writing any pending (batched) changes.
	 * Nothing is written when nothing changed: blindly re-exporting the image
	 * would overwrite documents added meanwhile by another process.
	 */
	close(): void {
		if (this.db) {
			this.commit();
			this.db.close();
			this.db = null;
		}
		this.pending = [];
		this.batchDepth = 0;
		this.diskSignature = null;
		// Release the embedding pipeline so the ONNX session/tensors can be
		// freed. Keep close() synchronous: dispose best-effort, fire-and-forget.
		const p = this.pipeline;
		this.pipeline = null;
		if (p?.dispose) Promise.resolve(p.dispose()).catch(() => {});
		this.initialized = false;
		this.initPromise = null;
		this.modelPromise = null;
	}
}
