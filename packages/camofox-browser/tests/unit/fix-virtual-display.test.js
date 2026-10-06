/**
 * PHI-VENDOR regression test: the Xvfb display must be AWAITED before launch.
 * server.js passed the pending Promise of VirtualDisplay#get() as DISPLAY, so
 * Camoufox failed on every Linux host with "cannot open display: [object Promise]".
 */
import { describe, expect, test } from '@jest/globals';
import { startVirtualDisplay } from '../../lib/virtual-display.js';

function recordingLog() {
  const entries = [];
  const log = (level, message, fields) => entries.push({ level, message, fields });
  return { log, entries };
}

describe('startVirtualDisplay', () => {
  test('resolves the display string reported asynchronously by Xvfb', async () => {
    const vd = { get: async () => ':99', kill: () => {} };
    const { log, entries } = recordingLog();
    const result = await startVirtualDisplay(() => vd, log, 1);
    expect(result.display).toBe(':99');
    expect(typeof result.display).toBe('string');
    expect(result.virtualDisplay).toBe(vd);
    expect(entries[0].fields.display).toBe(':99');
  });

  test('falls back to headless (no display) when Xvfb rejects, and kills it', async () => {
    let killed = false;
    const vd = {
      get: async () => {
        throw new Error('Please install Xvfb to use headless mode.');
      },
      kill: () => {
        killed = true;
      },
    };
    const { log, entries } = recordingLog();
    const result = await startVirtualDisplay(() => vd, log, 2);
    expect(result).toEqual({ virtualDisplay: null, display: undefined });
    expect(killed).toBe(true);
    expect(entries[0].level).toBe('warn');
  });

  test('falls back to headless when the display cannot even be created', async () => {
    const { log } = recordingLog();
    const result = await startVirtualDisplay(
      () => {
        throw new Error('VirtualDisplay is only supported on Linux');
      },
      log,
      1,
    );
    expect(result).toEqual({ virtualDisplay: null, display: undefined });
  });
});
