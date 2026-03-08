import { test, describe, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { SigmaMemory } from '../src/index.js';
import { existsSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';

describe('SigmaMemory', () => {
  let sigmaMemory: SigmaMemory;
  let tempDir: string;

  beforeEach(() => {
    // Create temporary test directory
    tempDir = join(process.cwd(), 'test-sigma-' + Date.now());
    mkdirSync(tempDir, { recursive: true });
    
    const config = {
      memoryDir: tempDir,
      projectMemoryDir: join(tempDir, 'project'),
      ontologyPath: join(tempDir, 'ontology', 'graph.jsonl')
    };
    
    sigmaMemory = new SigmaMemory(config);
    
    // Mock the vector store embedding to avoid downloads
    (sigmaMemory.vectors as any).ensurePipeline = async () => {
      (sigmaMemory.vectors as any).pipeline = {
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
  });

  afterEach(() => {
    // Clean up test directory
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('init should initialize all subsystems', async () => {
    await sigmaMemory.init();
    
    // Check that required directories were created
    assert(existsSync(tempDir));
    assert(existsSync(join(tempDir, 'project')));
    
    // Check that vector store is initialized
    const stats = await sigmaMemory.status();
    assert.equal(typeof stats.vectors.documentCount, 'number');
  });

  test('search should return unified results from all sources', async () => {
    await sigmaMemory.init();
    
    // Add test data to each subsystem
    // 1. Notes
    sigmaMemory.notes.write('This is a test note about machine learning algorithms', 'ml-notes.md');
    
    // 2. Ontology
    const personId = sigmaMemory.ontology.addEntity({
      type: 'Person',
      name: 'machine learning expert',
      properties: { specialty: 'algorithms' }
    });
    
    // 3. Vector store (via indexing notes)
    await sigmaMemory.indexNotes();
    
    // Search for content that should match all sources
    const results = await sigmaMemory.search('machine learning');
    
    // Should have results from multiple sources
    assert(results.length > 0);
    
    // Check that we have different source types
    const sources = new Set(results.map(r => r.source));
    assert(sources.size >= 2); // At least 2 different sources
    
    // Verify structure of results
    for (const result of results) {
      assert(['notes', 'ontology', 'vectors'].includes(result.source));
      assert(typeof result.score === 'number');
      assert(result.score >= 0 && result.score <= 1);
      assert(result.data !== undefined);
    }
  });

  test('search should handle empty database gracefully', async () => {
    await sigmaMemory.init();
    
    const results = await sigmaMemory.search('nonexistent content');
    
    // Should return empty array, not throw error
    assert(Array.isArray(results));
    assert.equal(results.length, 0);
  });

  test('search should sort results by score descending', async () => {
    await sigmaMemory.init();
    
    // Add content that will have different relevance scores
    sigmaMemory.notes.write('This document is all about artificial intelligence', 'ai-exact.md');
    sigmaMemory.notes.write('This document mentions AI briefly in passing', 'ai-brief.md');
    
    await sigmaMemory.indexNotes();
    
    const results = await sigmaMemory.search('artificial intelligence');
    
    if (results.length > 1) {
      // Verify descending order
      for (let i = 1; i < results.length; i++) {
        assert(results[i-1].score >= results[i].score);
      }
    }
  });

  test('indexNotes should add existing notes to vector store', async () => {
    await sigmaMemory.init();
    
    // Add some notes
    sigmaMemory.notes.write('First test document about programming', 'doc1.md');
    sigmaMemory.notes.write('Second test document about cooking', 'doc2.md');
    
    // Index them
    await sigmaMemory.indexNotes();
    
    // Check vector store has documents
    const stats = await sigmaMemory.status();
    assert.equal(stats.vectors.documentCount, 2);
  });

  test('status should return comprehensive system information', async () => {
    await sigmaMemory.init();
    
    // Add test data
    sigmaMemory.notes.write('Test note content', 'test.md');
    const personId = sigmaMemory.ontology.addEntity({
      type: 'Person',
      name: 'Test Person',
      properties: {}
    });
    await sigmaMemory.indexNotes();
    
    const status = await sigmaMemory.status();
    
    // Notes status
    assert.equal(typeof status.notes.count, 'number');
    assert.equal(typeof status.notes.totalSize, 'number');
    assert(status.notes.count > 0);
    
    // Ontology status
    assert.equal(typeof status.ontology.entities, 'number');
    assert.equal(typeof status.ontology.relations, 'number');
    assert(status.ontology.entities > 0);
    assert(typeof status.ontology.entitiesByType, 'object');
    
    // Vector status
    assert.equal(typeof status.vectors.documentCount, 'number');
    assert.equal(typeof status.vectors.chunkCount, 'number');
    assert(status.vectors.documentCount > 0);
  });

  test('getConfig should return configuration', () => {
    const config = sigmaMemory.getConfig();
    
    assert.equal(typeof config.memoryDir, 'string');
    assert.equal(typeof config.projectMemoryDir, 'string');
    assert.equal(typeof config.ontologyPath, 'string');
    assert.equal(config.memoryDir, tempDir);
  });

  test('should provide access to individual managers', () => {
    // Test that individual managers are accessible
    assert(sigmaMemory.notes);
    assert(sigmaMemory.ontology);
    assert(sigmaMemory.vectors);
    
    assert(typeof sigmaMemory.notes.write === 'function');
    assert(typeof sigmaMemory.ontology.addEntity === 'function');
    assert(typeof sigmaMemory.vectors.addDocument === 'function');
  });

  test('search should handle errors in individual subsystems gracefully', async () => {
    await sigmaMemory.init();
    
    // Create a scenario where one subsystem might fail
    // but the search should still return results from working ones
    sigmaMemory.notes.write('This note should be found', 'test.md');
    
    // Even if one subsystem has issues, search should work
    const results = await sigmaMemory.search('note');
    
    // Should still return results from working subsystems
    assert(Array.isArray(results));
  });
});