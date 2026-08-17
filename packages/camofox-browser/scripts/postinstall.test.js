import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(__dirname, '..');
const postinstallPath = join(__dirname, 'postinstall.js');

/**
 * These cases lock the vendoring decision, not the upstream fetcher.
 *
 * Upstream's postinstall downloaded the Camoufox binary from a third-party
 * GitHub release at install time. phi-code vendors it instead: the binary is
 * fetched by @phi-code-admin/camoufox-js's own postinstall, from the
 * uglyswap/phi-code release, so THIS script must stay a no-op — no network, no
 * third-party host, and never a non-zero exit that breaks the install of a
 * package that merely depends on this one.
 *
 * (The previous version of this file tested `externalExecutableFromEnv`, a
 * function removed with the fetcher. It imported a symbol that no longer
 * existed, so the whole suite failed to load and nothing here was checked.)
 */
describe('postinstall is a deliberate no-op', () => {
  test('exits 0', () => {
    const result = spawnSync(process.execPath, [postinstallPath], {
      cwd: packageRoot,
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  test('exits 0 even when the legacy executable variables are set', () => {
    const result = spawnSync(process.execPath, [postinstallPath], {
      cwd: packageRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        CAMOUFOX_EXECUTABLE: '/nonexistent/primary',
        CAMOUFOX_EXECUTABLE_PATH: '/nonexistent/compat',
        CAMOFOX_EXECUTABLE_PATH: '/nonexistent/legacy',
      },
    });

    expect(result.status).toBe(0);
  });

  test('performs no network access and names no third-party host', () => {
    const source = readFileSync(postinstallPath, 'utf-8');
    const code = source
      .split('\n')
      .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
      .join('\n');

    for (const forbidden of ['fetch(', 'https://', 'http://', 'require(', 'import ']) {
      expect(code).not.toContain(forbidden);
    }
  });
});
