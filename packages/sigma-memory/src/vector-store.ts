import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import initSqlJs, { type Database } from 'sql.js';
import type { VectorSearchResult } from './types.js';

/**
 * Helper for loading ESM-only modules from a CJS context.
 * Uses native import() via Function constructor to bypass
 * TypeScript's CJS transformation of dynamic imports.
 */
const esmImport = new Function(
  'specifier',
  'return import(specifier)'
) as (specifier: string) => Promise<any>;

/**
 * Self-contained vector store using sql.js (SQLite via WebAssembly) and
 * @huggingface/transformers for local embeddings.
 *
 * Zero configuration — works out of the box on any platform.
 * No native compilation required.
 */
export class VectorStore {
  private db: Database | null = null;
  private pipeline: any = null;
  private dbPath: string;
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private modelPromise: Promise<void> | null = null;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
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
    const SQL = await initSqlJs();

    // Load existing DB or create a new one
    if (existsSync(this.dbPath)) {
      const fileBuffer = readFileSync(this.dbPath);
      this.db = new SQL.Database(fileBuffer);
    } else {
      this.db = new SQL.Database();
    }

    // Create schema
    this.db.run(`
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
    this.db.run('CREATE INDEX IF NOT EXISTS idx_documents_file ON documents(file)');

    this.persist();
    this.initialized = true;
  }

  /**
   * Load the embedding model. Called lazily on first embed operation.
   * Downloads the model on first use (~23MB for all-MiniLM-L6-v2).
   */
  private async loadEmbeddingModel(): Promise<void> {
    if (this.pipeline) return;
    if (this.modelPromise) return this.modelPromise;

    this.modelPromise = (async () => {
      console.log('[VectorStore] Loading embedding model (Xenova/all-MiniLM-L6-v2)...');
      console.log('[VectorStore] First run may download the model (~23MB).');

      // Dynamic ESM import for @huggingface/transformers (ESM-only package)
      const { pipeline: createPipeline } = await esmImport('@huggingface/transformers');

      this.pipeline = await createPipeline(
        'feature-extraction',
        'Xenova/all-MiniLM-L6-v2'
      );

      console.log('[VectorStore] Embedding model loaded.');
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
   * Persist the in-memory SQLite database to disk.
   */
  private persist(): void {
    if (!this.db) return;
    const data = this.db.export();
    const buffer = Buffer.from(data);
    writeFileSync(this.dbPath, buffer);
  }

  /**
   * Embed text into a Float32Array vector (384 dimensions).
   */
  private async embed(text: string): Promise<Float32Array> {
    await this.ensurePipeline();

    const output = await this.pipeline(text, { pooling: 'mean', normalize: true });
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
    const paragraphs = text.split(/\n\s*\n/).filter(p => p.trim().length > 0);

    const rawChunks: string[] = [];

    for (const paragraph of paragraphs) {
      const trimmed = paragraph.trim();

      if (trimmed.length <= MAX_CHUNK_SIZE) {
        rawChunks.push(trimmed);
      } else {
        // Split long paragraphs by sentences
        const sentences = trimmed.split(/(?<=[.!?])\s+/);
        let current = '';

        for (const sentence of sentences) {
          if (current.length + sentence.length + 1 > MAX_CHUNK_SIZE && current.length > 0) {
            rawChunks.push(current.trim());
            current = sentence;
          } else {
            current = current ? current + ' ' + sentence : sentence;
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
      chunks.push(overlap + ' ' + rawChunks[i]);
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

  /**
   * Add a document to the vector store.
   * Chunks the content, embeds each chunk, and stores in the DB.
   * Replaces any existing chunks for this file.
   */
  async addDocument(file: string, content: string): Promise<void> {
    if (!this.db) throw new Error('VectorStore not initialized. Call init() first.');

    const chunks = this.chunkText(content);
    if (chunks.length === 0) return;

    // Remove existing chunks for this file
    this.db.run('DELETE FROM documents WHERE file = ?', [file]);

    // Embed and insert each chunk
    for (let i = 0; i < chunks.length; i++) {
      const embedding = await this.embed(chunks[i]);
      const embeddingBlob = this.serializeEmbedding(embedding);
      const now = new Date().toISOString();

      this.db.run(
        'INSERT INTO documents (file, chunk_index, content, embedding, updated_at) VALUES (?, ?, ?, ?, ?)',
        [file, i, chunks[i], embeddingBlob as any, now]
      );
    }

    this.persist();
  }

  /**
   * Search the vector store for content similar to the query.
   * Returns top-k results sorted by cosine similarity (descending).
   *
   * For performance with large DBs (>10K chunks), embeddings are loaded
   * as Float32Array and compared using optimized JS computation.
   */
  async search(query: string, limit: number = 10): Promise<VectorSearchResult[]> {
    if (!this.db) throw new Error('VectorStore not initialized. Call init() first.');

    // Embed the query
    const queryEmbedding = await this.embed(query);

    // Load all documents with embeddings
    const results = this.db.exec(
      'SELECT file, chunk_index, content, embedding FROM documents'
    );

    if (results.length === 0 || results[0].values.length === 0) {
      return [];
    }

    // Compute cosine similarity for each document
    const scored: VectorSearchResult[] = [];

    for (const row of results[0].values) {
      const [file, chunkIndex, content, embeddingBlob] = row as [string, number, string, Uint8Array];

      const docEmbedding = this.deserializeEmbedding(
        embeddingBlob instanceof Uint8Array ? embeddingBlob : new Uint8Array(embeddingBlob as any)
      );

      const score = this.cosineSimilarity(queryEmbedding, docEmbedding);

      scored.push({
        file: file as string,
        chunkIndex: chunkIndex as number,
        content: content as string,
        score
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
    if (!this.db) throw new Error('VectorStore not initialized. Call init() first.');

    this.db.run('DELETE FROM documents WHERE file = ?', [file]);
    this.persist();
  }

  /**
   * Full reindex from a file map (filename → content).
   * Clears all existing data and re-indexes everything.
   */
  async reindex(files: Map<string, string>): Promise<void> {
    if (!this.db) throw new Error('VectorStore not initialized. Call init() first.');

    // Clear all existing documents
    this.db.run('DELETE FROM documents');

    // Re-add all files
    for (const [file, content] of files) {
      await this.addDocument(file, content);
    }

    this.persist();
  }

  /**
   * Get statistics about the vector store.
   */
  getStats(): { documentCount: number; chunkCount: number; lastUpdate: string } {
    if (!this.db) {
      return { documentCount: 0, chunkCount: 0, lastUpdate: '' };
    }

    const countResult = this.db.exec(
      'SELECT COUNT(DISTINCT file) as docs, COUNT(*) as chunks FROM documents'
    );
    const updateResult = this.db.exec(
      'SELECT MAX(updated_at) as last_update FROM documents'
    );

    const docs = countResult.length > 0 && countResult[0].values.length > 0
      ? (countResult[0].values[0][0] as number)
      : 0;

    const chunks = countResult.length > 0 && countResult[0].values.length > 0
      ? (countResult[0].values[0][1] as number)
      : 0;

    const lastUpdate = updateResult.length > 0 && updateResult[0].values.length > 0
      ? ((updateResult[0].values[0][0] as string) || '')
      : '';

    return { documentCount: docs, chunkCount: chunks, lastUpdate };
  }

  /**
   * Close the database connection and persist to disk.
   */
  close(): void {
    if (this.db) {
      this.persist();
      this.db.close();
      this.db = null;
    }
    this.initialized = false;
    this.initPromise = null;
    this.modelPromise = null;
  }
}
