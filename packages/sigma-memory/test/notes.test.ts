import { test, describe, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { NotesManager } from '../src/notes.js';
import { existsSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import type { MemoryConfig } from '../src/types.js';

describe('NotesManager', () => {
  let notesManager: NotesManager;
  let tempDir: string;

  beforeEach(() => {
    // Create temporary test directory
    tempDir = join(process.cwd(), 'test-notes-' + Date.now());
    mkdirSync(tempDir, { recursive: true });
    
    const config: MemoryConfig = {
      memoryDir: tempDir,
      projectMemoryDir: join(tempDir, 'project'),
      ontologyPath: join(tempDir, 'ontology', 'graph.jsonl')
    };
    
    notesManager = new NotesManager(config);
  });

  afterEach(() => {
    // Clean up test directory
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('write should create a file with content', () => {
    const content = 'Test note content';
    const filename = 'test.md';
    
    notesManager.write(content, filename);
    
    const result = notesManager.read(filename);
    assert.equal(result, content);
  });

  test('write without filename should use today\'s date', () => {
    const content = 'Test note for today';
    const today = new Date().toISOString().split('T')[0] + '.md';
    
    notesManager.write(content);
    
    const result = notesManager.read(today);
    assert.equal(result, content);
  });

  test('read should throw error for non-existent file', () => {
    assert.throws(() => {
      notesManager.read('non-existent.md');
    }, /File not found/);
  });

  test('list should return files sorted by date descending', () => {
    notesManager.write('Content 1', 'file1.md');
    notesManager.write('Content 2', 'file2.md');
    
    const files = notesManager.list();
    
    assert.equal(files.length, 2);
    assert.equal(files[0].name, 'file2.md'); // Most recent first
    assert.equal(files[1].name, 'file1.md');
    assert(files[0].size > 0);
    assert(typeof files[0].date === 'string');
  });

  test('search should find content with case-insensitive matching', () => {
    notesManager.write('This is a test file with important data', 'test1.md');
    notesManager.write('Another file without the keyword', 'test2.md');
    
    const results = notesManager.search('IMPORTANT');
    
    assert.equal(results.length, 1);
    assert.equal(results[0].file, 'test1.md');
    assert(results[0].content.includes('important'));
    assert.equal(typeof results[0].line, 'number');
  });

  test('search should return empty array for no matches', () => {
    notesManager.write('Some content here', 'test.md');
    
    const results = notesManager.search('nonexistent');
    
    assert.equal(results.length, 0);
  });

  test('append should add to existing file', () => {
    const initial = 'Initial content';
    const additional = 'Additional content';
    const filename = 'append-test.md';
    
    notesManager.write(initial, filename);
    notesManager.append(additional, filename);
    
    const result = notesManager.read(filename);
    assert(result.includes(initial));
    assert(result.includes(additional));
  });

  test('append should create new file if it doesn\'t exist', () => {
    const content = 'New file content';
    const filename = 'new-append.md';
    
    notesManager.append(content, filename);
    
    const result = notesManager.read(filename);
    assert.equal(result, content);
  });

  test('getRecent should return notes from last N days', () => {
    notesManager.write('Recent note', 'recent.md');
    
    const recent = notesManager.getRecent(7);
    
    assert.equal(recent.length, 1);
    assert.equal(recent[0].file, 'recent.md');
    assert.equal(recent[0].content, 'Recent note');
    assert(typeof recent[0].date === 'string');
  });
});