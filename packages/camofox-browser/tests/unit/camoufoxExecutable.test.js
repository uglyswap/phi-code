import { afterEach, describe, expect, test } from '@jest/globals';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { platform, tmpdir } from 'os';
import { prepareExternalCamoufoxExecutable } from '../../lib/camoufox-executable.js';

const tempDirs = [];

/** Mirror of camoufoxLaunchFileName() in lib/camoufox-executable.js. */
function expectedLaunchFileName() {
  if (platform() === 'win32') return 'camoufox.exe';
  if (platform() === 'darwin') return join('Camoufox.app', 'Contents', 'MacOS', 'camoufox');
  return 'camoufox-bin';
}

function makeTempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'camofox-executable-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  rmSync(join(tmpdir(), 'camofox-browser-external-camoufox'), { recursive: true, force: true });
});

describe('prepareExternalCamoufoxExecutable', () => {
  test('creates camoufox-js compatibility links for an external bundle', () => {
    const bundleDir = makeTempDir();
    const cacheDir = makeTempDir();
    const executable = join(bundleDir, 'camoufox-bin');

    writeFileSync(executable, '#!/bin/sh\nexit 0\n');
    chmodSync(executable, 0o755);
    writeFileSync(join(bundleDir, 'properties.json'), '[]\n');
    writeFileSync(join(bundleDir, 'version.json'), '{"version":"135.0.1","release":"beta.24"}\n');
    mkdirSync(join(bundleDir, 'fontconfig', 'lin'), { recursive: true });

    const prepared = prepareExternalCamoufoxExecutable(executable, { cacheDir });

    expect(prepared.resourceDir).toBe(bundleDir);
    expect(prepared.executablePath).toContain('camofox-browser-external-camoufox');
    expect(existsSync(prepared.executablePath)).toBe(true);
    expect(existsSync(join(cacheDir, 'version.json'))).toBe(true);
    expect(existsSync(join(cacheDir, 'fontconfig'))).toBe(true);
    expect(existsSync(join(cacheDir, 'properties.json'))).toBe(true);
    // The cache entry is named after the platform camoufox-js will look for:
    // camoufox.exe on Windows, Camoufox.app/Contents/MacOS/camoufox on macOS,
    // camoufox-bin elsewhere. Asserting the Linux name made this fail on Windows
    // even though the right file had been created next to it.
    expect(existsSync(join(cacheDir, expectedLaunchFileName()))).toBe(true);
  });

  test('fails clearly when bundle resources are missing', () => {
    const bundleDir = makeTempDir();
    const executable = join(bundleDir, 'camoufox-bin');
    writeFileSync(executable, '#!/bin/sh\nexit 0\n');
    chmodSync(executable, 0o755);

    expect(() => prepareExternalCamoufoxExecutable(executable, { cacheDir: makeTempDir() }))
      .toThrow(/properties\.json/);
  });
});
