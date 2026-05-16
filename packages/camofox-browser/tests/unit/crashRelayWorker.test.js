/**
 * Tests for the Cloudflare Worker crash relay contract.
 *
 * Pure logic tests -- payload validation, type matching, client<->worker compat.
 * No fs reads in this file (scanner isolation: no file I/O + network import).
 * File-reading tests (source structure, secrets, config) are in noSecrets.test.js.
 */
import { describe, test, expect, beforeAll } from '@jest/globals';

// ============================================================================
// Payload validation rules (mirrored from worker)
// ============================================================================

const VALID_TYPES = new Set([
  'crash', 'hang', 'stuck', 'stuck:event-loop', 'stuck:tab-lock',
  'leak:native-memory', 'signal:SIGTERM', 'signal:SIGSEGV', 'signal:SIGABRT',
]);

function isValidType(type) {
  if (VALID_TYPES.has(type)) return true;
  return /^(hang|signal|stuck|leak|crash):[\w\-.:]+$/.test(type);
}

function validatePayload(data) {
  if (!data || typeof data !== 'object') return null;
  if (typeof data.type !== 'string' || !isValidType(data.type)) return null;
  if (typeof data.signature !== 'string' || !/^[0-9a-f]{8}$/.test(data.signature)) return null;
  if (typeof data.title !== 'string' || data.title.length === 0 || data.title.length > 256) return null;
  if (typeof data.body !== 'string' || data.body.length > 65536) return null;
  if (!Array.isArray(data.labels) || data.labels.some((l) => typeof l !== 'string')) return null;
  return {
    type: data.type,
    signature: data.signature,
    title: data.title,
    body: data.body,
    labels: data.labels.slice(0, 5),
    version: typeof data.version === 'string' ? data.version : undefined,
  };
}

describe('payload validation', () => {

  test('accepts valid crash report', () => {
    const result = validatePayload({
      type: 'crash', signature: 'aabb1122',
      title: '[aabb1122] crash: test', body: '## Error\ntest',
      labels: ['crash', 'auto-report'], version: '1.8.2',
    });
    expect(result).not.toBeNull();
    expect(result.type).toBe('crash');
  });

  test('accepts hang:navigate type', () => {
    expect(validatePayload({
      type: 'hang:navigate', signature: 'deadbeef',
      title: 'test', body: 'body', labels: ['hang'],
    })).not.toBeNull();
  });

  test('accepts stuck:event-loop type', () => {
    expect(validatePayload({
      type: 'stuck:event-loop', signature: '11223344',
      title: 'test', body: 'body', labels: ['stuck'],
    })).not.toBeNull();
  });

  test('accepts signal:SIGTERM type', () => {
    expect(validatePayload({
      type: 'signal:SIGTERM', signature: 'aabbccdd',
      title: 'test', body: 'body', labels: ['crash'],
    })).not.toBeNull();
  });

  test('accepts leak:native-memory type', () => {
    expect(validatePayload({
      type: 'leak:native-memory', signature: 'eeff0011',
      title: 'test', body: 'body', labels: ['auto-report', 'memory-leak'],
    })).not.toBeNull();
  });

  test('rejects unknown type', () => {
    expect(validatePayload({ type: 'xss:injection', signature: 'aabb1122', title: 'test', body: 'body', labels: [] })).toBeNull();
  });

  test('rejects type with special characters', () => {
    expect(validatePayload({ type: 'crash; rm -rf /', signature: 'aabb1122', title: 'test', body: 'body', labels: [] })).toBeNull();
  });

  test('rejects non-hex signature', () => {
    expect(validatePayload({ type: 'crash', signature: 'not-hex!', title: 'test', body: 'body', labels: [] })).toBeNull();
  });

  test('rejects too-short signature', () => {
    expect(validatePayload({ type: 'crash', signature: 'aabb', title: 'test', body: 'body', labels: [] })).toBeNull();
  });

  test('rejects too-long signature', () => {
    expect(validatePayload({ type: 'crash', signature: 'aabb11223344', title: 'test', body: 'body', labels: [] })).toBeNull();
  });

  test('rejects empty title', () => {
    expect(validatePayload({ type: 'crash', signature: 'aabb1122', title: '', body: 'body', labels: [] })).toBeNull();
  });

  test('rejects title > 256 chars', () => {
    expect(validatePayload({ type: 'crash', signature: 'aabb1122', title: 'x'.repeat(257), body: 'body', labels: [] })).toBeNull();
  });

  test('rejects body > 64KB', () => {
    expect(validatePayload({ type: 'crash', signature: 'aabb1122', title: 'test', body: 'x'.repeat(65537), labels: [] })).toBeNull();
  });

  test('rejects non-string labels', () => {
    expect(validatePayload({ type: 'crash', signature: 'aabb1122', title: 'test', body: 'body', labels: [123] })).toBeNull();
  });

  test('truncates labels to 5', () => {
    const result = validatePayload({ type: 'crash', signature: 'aabb1122', title: 'test', body: 'body', labels: ['a','b','c','d','e','f','g'] });
    expect(result.labels).toHaveLength(5);
  });

  test('rejects null payload', () => { expect(validatePayload(null)).toBeNull(); });
  test('rejects string payload', () => { expect(validatePayload('not an object')).toBeNull(); });
  test('rejects missing fields', () => { expect(validatePayload({ type: 'crash' })).toBeNull(); });

  test('version is optional', () => {
    const result = validatePayload({ type: 'crash', signature: 'aabb1122', title: 'test', body: 'body', labels: [] });
    expect(result).not.toBeNull();
    expect(result.version).toBeUndefined();
  });

  test('version must be string if present', () => {
    const result = validatePayload({ type: 'crash', signature: 'aabb1122', title: 'test', body: 'body', labels: [], version: 42 });
    expect(result).not.toBeNull();
    expect(result.version).toBeUndefined();
  });
});

// ============================================================================
// Client<->Worker payload compatibility
// ============================================================================

describe('client<->worker payload compatibility', () => {

  let stackSignature, anonymize;

  beforeAll(async () => {
    const reporter = await import('../../lib/reporter.js');
    stackSignature = reporter.stackSignature;
    anonymize = reporter.anonymize;
  });

  test('stackSignature produces valid 8-char hex accepted by worker', () => {
    const sig = stackSignature('crash', new Error('test'));
    expect(sig).toMatch(/^[0-9a-f]{8}$/);
    expect(validatePayload({ type: 'crash', signature: sig, title: `[${sig}] crash: test`, body: 'body', labels: ['crash'] })).not.toBeNull();
  });

  test('hang type from client matches worker validation', () => {
    const sig = stackSignature('hang:navigate', { name: 'TimeoutError', message: 'test' });
    expect(validatePayload({ type: 'hang:navigate', signature: sig, title: 'test', body: 'body', labels: ['hang', 'auto-report'] })).not.toBeNull();
  });

  test('stuck type from client matches worker validation', () => {
    const sig = stackSignature('stuck:event-loop', { name: 'EventLoopStall', message: 'idle' });
    expect(validatePayload({ type: 'stuck:event-loop', signature: sig, title: 'test', body: 'body', labels: ['stuck', 'auto-report'] })).not.toBeNull();
  });

  test('leak type from client matches worker validation', () => {
    const sig = stackSignature('leak:native-memory', { name: 'MemoryLeak', message: 'test' });
    expect(validatePayload({ type: 'leak:native-memory', signature: sig, title: 'test', body: 'body', labels: ['auto-report', 'memory-leak'] })).not.toBeNull();
  });

  test('signal type from client matches worker validation', () => {
    const sig = stackSignature('signal:SIGTERM', new Error('killed'));
    expect(validatePayload({ type: 'signal:SIGTERM', signature: sig, title: 'test', body: 'body', labels: ['crash', 'auto-report'] })).not.toBeNull();
  });

  test('anonymized body is within 64KB limit', () => {
    const longStack = 'Error: test\n' + '    at foo (server.js:100:10)\n'.repeat(500);
    expect(anonymize(longStack).length).toBeLessThan(65536);
  });

  test('title with anonymized message is within 256 chars', () => {
    const title = `[aabb1122] crash: ${anonymize('x'.repeat(300)).slice(0, 120)}`;
    expect(title.length).toBeLessThanOrEqual(256);
  });
});
