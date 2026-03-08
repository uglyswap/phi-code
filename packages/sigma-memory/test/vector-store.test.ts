import { test, describe, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { VectorStore } from '../src/vector-store.js';
import { existsSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';

// Mock the embedding function to avoid downloading models in tests
const mockEmbedding = new Float32Array([0.1, 0.2, 0.3, 0.4]);
const originalEsmImport = (global as any).Function;

describe('VectorStore', () => {
  let vectorStore: VectorStore;
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    // Create temporary test directory
    tempDir = join(process.cwd(), 'test-vectors-' + Date.now());
    mkdirSync(tempDir, { recursive: true });
    dbPath = join(tempDir, 'test-vectors.db');
    
    vectorStore = new VectorStore(dbPath);
    
    // Mock the embedding pipeline to avoid downloading models
    (vectorStore as any).ensurePipeline = async () => {
      (vectorStore as any).pipeline = {
        async call(text: string) {
          // Return a simple mock embedding based on text length
          const length = text.length;
          return {
            data: new Float32Array([
              length / 100,
              (length % 10) / 10,
              Math.sin(length) / 2 + 0.5,
              Math.cos(length) / 2 + 0.5
            ])
          };
        }
      };
    };
  });

  afterEach(() => {
    // Clean up test directory
    if (vectorStore) {
      vectorStore.close();
    }
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('init should create database and schema', async () => {
    await vectorStore.init();
    
    // Check that database file was created
    assert(existsSync(dbPath));
    
    // Check stats show empty database
    const stats = vectorStore.getStats();
    assert.equal(stats.documentCount, 0);
    assert.equal(stats.chunkCount, 0);
  });

  test('addDocument should store text chunks with embeddings', async () => {
    await vectorStore.init();
    
    const content = 'This is a test document with some content to be chunked.';
    await vectorStore.addDocument('test.md', content);
    
    const stats = vectorStore.getStats();
    assert.equal(stats.documentCount, 1);
    assert(stats.chunkCount > 0);
  });

  test('addDocument should replace existing document', async () => {
    await vectorStore.init();
    
    await vectorStore.addDocument('test.md', 'Original content');
    const firstStats = vectorStore.getStats();
    
    await vectorStore.addDocument('test.md', 'Updated content that is much longer and will create different chunks');
    const secondStats = vectorStore.getStats();
    
    // Document count should remain 1, but chunks might be different
    assert.equal(secondStats.documentCount, 1);
  });

  test('search should return relevant results', async () => {
    await vectorStore.init();
    
    await vectorStore.addDocument('doc1.md', 'This document is about artificial intelligence and machine learning.');
    await vectorStore.addDocument('doc2.md', 'This document discusses cooking recipes and kitchen techniques.');
    
    const results = await vectorStore.search('artificial intelligence', 5);
    
    assert(results.length > 0);
    assert(results[0].score >= 0 && results[0].score <= 1);
    assert.equal(typeof results[0].file, 'string');
    assert.equal(typeof results[0].content, 'string');
    assert.equal(typeof results[0].chunkIndex, 'number');
  });

  test('search should return empty results for empty database', async () => {
    await vectorStore.init();
    
    const results = await vectorStore.search('test query', 5);
    assert.equal(results.length, 0);
  });

  test('removeDocument should delete all chunks for a file', async () => {
    await vectorStore.init();
    
    await vectorStore.addDocument('doc1.md', 'Content for document 1');
    await vectorStore.addDocument('doc2.md', 'Content for document 2');
    
    let stats = vectorStore.getStats();
    assert.equal(stats.documentCount, 2);
    
    await vectorStore.removeDocument('doc1.md');
    
    stats = vectorStore.getStats();
    assert.equal(stats.documentCount, 1);
  });

  test('getStats should return accurate counts', async () => {
    await vectorStore.init();
    
    let stats = vectorStore.getStats();
    assert.equal(stats.documentCount, 0);
    assert.equal(stats.chunkCount, 0);
    assert.equal(stats.lastUpdate, '');
    
    await vectorStore.addDocument('test.md', 'Some test content here that will be processed into chunks.');
    
    stats = vectorStore.getStats();
    assert.equal(stats.documentCount, 1);
    assert(stats.chunkCount > 0);
    assert(stats.lastUpdate !== '');
  });

  test('close should persist data and clean up resources', async () => {
    await vectorStore.init();
    await vectorStore.addDocument('test.md', 'Test content');
    
    vectorStore.close();
    
    // Create new instance and verify data persisted
    const newVectorStore = new VectorStore(dbPath);
    
    // Mock the pipeline again for the new instance
    (newVectorStore as any).ensurePipeline = async () => {
      (newVectorStore as any).pipeline = {
        async call(text: string) {
          const length = text.length;
          return {
            data: new Float32Array([
              length / 100,
              (length % 10) / 10,
              Math.sin(length) / 2 + 0.5,
              Math.cos(length) / 2 + 0.5
            ])
          };
        }
      };
    };
    
    await newVectorStore.init();
    const stats = newVectorStore.getStats();
    
    assert.equal(stats.documentCount, 1);
    newVectorStore.close();
  });

  test('chunkText should split content appropriately', async () => {
    await vectorStore.init();
    
    // Test with content that should be split into multiple chunks
    const longContent = 'This is a very long document. '.repeat(50) + 
                       '\n\nThis is a second paragraph. '.repeat(30) +
                       '\n\nThis is a third paragraph that is also quite long. '.repeat(25);
    
    await vectorStore.addDocument('long.md', longContent);
    
    const stats = vectorStore.getStats();
    assert(stats.chunkCount > 1); // Should be split into multiple chunks
  });
});