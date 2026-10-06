/**
 * PHI-VENDOR regression tests: cookies (storage-state.json) and traces must be
 * owner-only. POSIX permission bits only: skipped on Windows, where chmod only
 * toggles the read-only flag and %TEMP% / the profile are per-user anyway.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { persistStorageState } from '../../lib/persistence.js';
import { ensureTracesDir } from '../../lib/tracing.js';

const posixIt = process.platform === 'win32' ? it.skip : it;

function mode(p) {
  return fs.statSync(p).mode & 0o777;
}

describe('private file permissions', () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'camofox-perm-test-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  posixIt('persistStorageState writes storage-state.json 0600 in a 0700 dir', async () => {
    const context = {
      storageState: async ({ path: target }) => {
        fs.writeFileSync(target, JSON.stringify({ cookies: [], origins: [] }), { mode: 0o644 });
      },
    };
    const result = await persistStorageState({ profileDir: tmpDir, userId: 'u', context, logger: null });
    expect(result.persisted).toBe(true);
    expect(mode(result.userDir)).toBe(0o700);
    expect(mode(result.storageStatePath)).toBe(0o600);
    expect(mode(result.metaPath)).toBe(0o600);
  });

  posixIt('persistStorageState tightens a pre-existing world-readable user dir', async () => {
    const context = { storageState: async ({ path: target }) => fs.writeFileSync(target, '{"cookies":[]}') };
    const first = await persistStorageState({ profileDir: tmpDir, userId: 'u', context, logger: null });
    fs.chmodSync(first.userDir, 0o755);
    await persistStorageState({ profileDir: tmpDir, userId: 'u', context, logger: null });
    expect(mode(first.userDir)).toBe(0o700);
  });

  posixIt('ensureTracesDir creates an owner-only directory', () => {
    const dir = ensureTracesDir(tmpDir, 'u');
    expect(mode(dir)).toBe(0o700);
  });
});
