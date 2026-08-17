/**
 * Tests for the crash relay client (sendToRelay) and reporter<->relay integration.
 *
 * Uses Jest with mock fetch to verify:
 * - sendToRelay payload format and error handling
 * - createReporter sends correct payloads to the relay
 * - Relay URL override via config
 * - No secrets in outbound requests
 */
import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { jest } from '@jest/globals';
import {
  anonymize, stackSignature, createReporter, sendToRelay,
} from '../../lib/reporter.js';

// ============================================================================
// Mock fetch for relay tests
// ============================================================================

let fetchCalls = [];
let fetchResponse = { ok: true, status: 200, json: async () => ({ status: 'created' }) };

const originalFetch = globalThis.fetch;

/**
 * Relay used by every case that needs the send path to actually fire.
 *
 * Vendoring turned crash telemetry off by default: `sendToRelay` returns early
 * unless a relay URL was configured (see the PHI-VENDOR note in lib/reporter.js),
 * so nothing leaves the user's machine unless they opt in. These cases used to
 * assert against the upstream host that was hard-coded as the default; they now
 * arm a relay of their own, which tests the same send path without depending on
 * telemetry being on. The silence-by-default guarantee is covered in its own
 * describe block at the bottom of this file.
 */
const TEST_RELAY_URL = 'https://relay.test.invalid/report';

/** Arm the module-level relay URL that bare `sendToRelay` calls read. */
function armRelay(extra = {}) {
  return createReporter({ crashReportEnabled: true, crashReportUrl: TEST_RELAY_URL, ...extra });
}

beforeEach(() => {
  fetchCalls = [];
  fetchResponse = { ok: true, status: 200, json: async () => ({ status: 'created' }) };
  globalThis.fetch = async (url, opts) => {
    fetchCalls.push({ url, opts });
    return fetchResponse;
  };
  armRelay();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ============================================================================
// sendToRelay tests
// ============================================================================

describe('sendToRelay', () => {

  test('sends POST with JSON Content-Type', async () => {
    await sendToRelay({ type: 'crash', signature: 'aabb1122', title: 'test', body: 'body', labels: ['crash'] });
    expect(fetchCalls).toHaveLength(1);
    const { url, opts } = fetchCalls[0];
    expect(url).toBe(TEST_RELAY_URL);
    expect(opts.method).toBe('POST');
    expect(opts.headers['Content-Type']).toBe('application/json');
  });

  test('sends correct payload shape', async () => {
    const payload = {
      type: 'hang:navigate',
      signature: 'deadbeef',
      title: '[deadbeef] hang: test',
      body: '## Error\ntest',
      labels: ['hang', 'auto-report'],
      version: '1.8.2',
    };
    await sendToRelay(payload);
    expect(fetchCalls).toHaveLength(1);
    const sent = JSON.parse(fetchCalls[0].opts.body);
    expect(sent.type).toBe('hang:navigate');
    expect(sent.signature).toBe('deadbeef');
    expect(sent.title).toBe('[deadbeef] hang: test');
    expect(sent.labels).toEqual(['hang', 'auto-report']);
    expect(sent.version).toBe('1.8.2');
  });

  test('returns true on 200', async () => {
    fetchResponse = { ok: true, status: 200 };
    const result = await sendToRelay({ type: 'crash', signature: '11223344', title: 't', body: 'b', labels: [] });
    expect(result).toBe(true);
  });

  test('returns true on 429 (rate limited is not an error)', async () => {
    fetchResponse = { ok: false, status: 429 };
    const result = await sendToRelay({ type: 'crash', signature: '11223344', title: 't', body: 'b', labels: [] });
    expect(result).toBe(true);
  });

  test('returns false on 500', async () => {
    fetchResponse = { ok: false, status: 500 };
    const result = await sendToRelay({ type: 'crash', signature: '11223344', title: 't', body: 'b', labels: [] });
    expect(result).toBe(false);
  });

  test('returns false on fetch error (never throws)', async () => {
    globalThis.fetch = async () => { throw new Error('network error'); };
    const result = await sendToRelay({ type: 'crash', signature: '11223344', title: 't', body: 'b', labels: [] });
    expect(result).toBe(false);
  });

  test('includes abort signal for timeout', async () => {
    await sendToRelay({ type: 'crash', signature: '11223344', title: 't', body: 'b', labels: [] });
    expect(fetchCalls[0].opts.signal).toBeDefined();
    expect(fetchCalls[0].opts.signal).toBeInstanceOf(AbortSignal);
  });
});

// ============================================================================
// sendToRelay payload contains NO secrets
// ============================================================================

describe('sendToRelay security', () => {

  test('payload never contains GitHub App credentials', async () => {
    const payload = {
      type: 'crash',
      signature: 'aabbccdd',
      title: 'test crash',
      body: 'stack trace here',
      labels: ['crash', 'auto-report'],
      version: '1.8.2',
    };
    await sendToRelay(payload);
    const raw = fetchCalls[0].opts.body;
    // Must not contain any of the old embedded key patterns
    expect(raw).not.toContain('keyA');
    expect(raw).not.toContain('keyB');
    expect(raw).not.toContain('appId');
    expect(raw).not.toContain('installationId');
    expect(raw).not.toContain('PRIVATE KEY');
    expect(raw).not.toContain('LS0tLS1CRUdJTi'); // base64 "-----BEGIN"
  });
});

// ============================================================================
// createReporter -> relay integration
// ============================================================================

describe('createReporter relay integration', () => {

  test('reportCrash sends to relay with correct type and labels', async () => {
    const reporter = armRelay({ version: '1.8.2' });
    await reporter.reportCrash(new Error('test error'));
    // Wait for the async in-flight promise
    await reporter.stop();
    expect(fetchCalls.length).toBeGreaterThanOrEqual(1);
    const sent = JSON.parse(fetchCalls[0].opts.body);
    expect(sent.type).toMatch(/^(Error|crash)/);
    expect(sent.labels).toContain('crash');
    expect(sent.labels).toContain('auto-report');
    expect(sent.signature).toMatch(/^[0-9a-f]{8}$/);
    expect(sent.title).toContain(`[${sent.signature}]`);
    expect(sent.version).toBe('1.8.2');
  });

  test('reportCrash with signal sends signal:TYPE', async () => {
    const reporter = armRelay({ version: '1.8.2' });
    await reporter.reportCrash(new Error('killed'), { signal: 'SIGTERM' });
    await reporter.stop();
    expect(fetchCalls.length).toBeGreaterThanOrEqual(1);
    const sent = JSON.parse(fetchCalls[0].opts.body);
    expect(sent.type).toBe('signal:SIGTERM');
  });

  test('reportHang sends hang:operation type', async () => {
    const reporter = armRelay({ version: '1.8.2' });
    await reporter.reportHang('navigate', 30000);
    await reporter.stop();
    expect(fetchCalls.length).toBeGreaterThanOrEqual(1);
    const sent = JSON.parse(fetchCalls[0].opts.body);
    expect(sent.type).toBe('hang:navigate');
    expect(sent.labels).toContain('hang');
  });

  test('reportStuckLoop sends stuck:tab-lock type', async () => {
    const reporter = armRelay({ version: '1.8.2' });
    await reporter.reportStuckLoop(60000);
    await reporter.stop();
    expect(fetchCalls.length).toBeGreaterThanOrEqual(1);
    const sent = JSON.parse(fetchCalls[0].opts.body);
    expect(sent.type).toBe('stuck:tab-lock');
    expect(sent.labels).toContain('stuck');
  });

  test('body contains anonymized content', async () => {
    const reporter = armRelay();
    const err = new Error('Failed connecting to https://secret.internal.corp/api');
    await reporter.reportCrash(err);
    await reporter.stop();
    const sent = JSON.parse(fetchCalls[0].opts.body);
    expect(sent.body).not.toContain('secret.internal.corp');
    expect(sent.body).toContain('<https-url>');
  });

  test('disabled reporter does not send to relay', async () => {
    const reporter = armRelay({ crashReportEnabled: false });
    await reporter.reportCrash(new Error('test'));
    await reporter.stop();
    expect(fetchCalls).toHaveLength(0);
  });

  test('rate limiter prevents excess reports', async () => {
    const reporter = armRelay({ crashReportRateLimit: 2 });
    // Exhaust the crash-specific rate limiter (5/hr default)
    const rl = reporter._rateLimiter.crash;
    for (let i = 0; i < 5; i++) rl.tryAcquire();
    // This should be rate-limited
    await reporter.reportCrash(new Error('over limit'));
    await reporter.stop();
    expect(fetchCalls).toHaveLength(0);
  });
});

// ============================================================================
// Relay URL override
// ============================================================================

describe('relay URL override', () => {

  test('custom URL via config.crashReportUrl', async () => {
    createReporter({ crashReportEnabled: true, crashReportUrl: 'https://my-relay.example.com/report' });
    await sendToRelay({ type: 'crash', signature: '11223344', title: 't', body: 'b', labels: [] });
    expect(fetchCalls[0].url).toBe('https://my-relay.example.com/report');
  });

  test('the module-level URL follows the most recent createReporter call', async () => {
    createReporter({ crashReportEnabled: true, crashReportUrl: 'https://first.example.com/report' });
    createReporter({ crashReportEnabled: true, crashReportUrl: 'https://second.example.com/report' });
    await sendToRelay({ type: 'crash', signature: '11223344', title: 't', body: 'b', labels: [] });
    expect(fetchCalls[0].url).toBe('https://second.example.com/report');
  });
});

// ============================================================================
// Telemetry is off until the user opts in
// ============================================================================

/**
 * The vendored build ships with no relay. Upstream hard-coded its own worker as
 * the default, so a crash phoned home from a fresh install; here the default is
 * the empty string and `sendToRelay` returns false without touching the network.
 * These cases exist so that default cannot be re-armed by accident.
 */
describe('crash telemetry is opt-in', () => {

  test('unconfigured relay sends nothing and reports failure', async () => {
    createReporter({ crashReportEnabled: true });
    const result = await sendToRelay({ type: 'crash', signature: '11223344', title: 't', body: 'b', labels: [] });
    expect(result).toBe(false);
    expect(fetchCalls).toHaveLength(0);
  });

  test('empty crashReportUrl stays unconfigured rather than falling back', async () => {
    createReporter({ crashReportEnabled: true, crashReportUrl: '' });
    await sendToRelay({ type: 'crash', signature: '11223344', title: 't', body: 'b', labels: [] });
    expect(fetchCalls).toHaveLength(0);
  });

  test('reportCrash on an unconfigured reporter performs no network call', async () => {
    const reporter = createReporter({ crashReportEnabled: true, version: '1.8.2' });
    await reporter.reportCrash(new Error('test error'));
    await reporter.stop();
    expect(fetchCalls).toHaveLength(0);
  });

  test('no third-party telemetry host survives in executable code', async () => {
    const { readFileSync } = await import('fs');
    const { dirname, join } = await import('path');
    const { fileURLToPath } = await import('url');
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'lib', 'reporter.js'),
      'utf-8',
    );
    // The upstream worker is still named in the PHI-VENDOR comment that records
    // why it was dropped — that is documentation. What must never come back is a
    // hostname the code can actually reach, so only live statements are checked.
    const code = source
      .split('\n')
      .filter((line) => {
        const t = line.trim();
        return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
      })
      .join('\n');
    expect(code).not.toContain('workers.dev');
  });
});

