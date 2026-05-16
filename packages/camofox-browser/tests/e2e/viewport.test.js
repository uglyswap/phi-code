import { createClient } from '../helpers/client.js';
import { getSharedEnv } from './sharedEnv.js';

describe('Viewport', () => {
  let serverUrl;
  let testSiteUrl;

  beforeAll(() => {
    const env = getSharedEnv();
    serverUrl = env.serverUrl;
    testSiteUrl = env.testSiteUrl;
  });

  test('set viewport to mobile size', async () => {
    const client = createClient(serverUrl);

    try {
      const { tabId } = await client.createTab(`${testSiteUrl}/`);

      const result = await client.viewport(tabId, { width: 375, height: 667 });
      expect(result.ok).toBe(true);
      expect(result.width).toBe(375);
      expect(result.height).toBe(667);
    } finally {
      await client.cleanup();
    }
  });

  test('set viewport to desktop size', async () => {
    const client = createClient(serverUrl);

    try {
      const { tabId } = await client.createTab(`${testSiteUrl}/`);

      const result = await client.viewport(tabId, { width: 1920, height: 1080 });
      expect(result.ok).toBe(true);
      expect(result.width).toBe(1920);
      expect(result.height).toBe(1080);
    } finally {
      await client.cleanup();
    }
  });

  test('rejects invalid dimensions', async () => {
    const client = createClient(serverUrl);

    try {
      const { tabId } = await client.createTab(`${testSiteUrl}/`);

      // Width too small — client throws on non-200
      await expect(client.viewport(tabId, { width: 50, height: 720 }))
        .rejects.toThrow('width and height required');
    } finally {
      await client.cleanup();
    }
  });

  test('viewport change triggers layout reflow', async () => {
    const client = createClient(serverUrl);

    try {
      const { tabId } = await client.createTab(`${testSiteUrl}/`);

      // Set to wide desktop
      await client.viewport(tabId, { width: 1920, height: 1080 });

      // Set to narrow mobile — if the page has responsive CSS,
      // snapshot content may differ (we just verify the call succeeds)
      const result = await client.viewport(tabId, { width: 320, height: 568 });
      expect(result.ok).toBe(true);
      expect(result.width).toBe(320);
    } finally {
      await client.cleanup();
    }
  });
});
