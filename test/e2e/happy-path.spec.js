import { test, expect } from '@playwright/test';
import { bootServer, hitMock } from './helpers.js';

let server;

test.beforeAll(async () => {
  server = await bootServer();
});

test.afterAll(async () => {
  if (server) await server.cleanup();
});

test('configuring an endpoint and hitting it produces a log entry', async ({ page }) => {
  await page.goto(server.baseURL, { waitUntil: 'load' });
  await page.waitForTimeout(2000);

  // 1. Create an endpoint via the UI
  await page.dispatchEvent('#newEndpointBtn', 'click');
  await expect(page.locator('#editorForm')).toBeVisible();
  await page.locator('#port').fill('17001');
  await page.locator('#path').fill('/api/e2e');
  await page.dispatchEvent('#saveBtn', 'click');

  // 2. Start runtime
  await page.dispatchEvent('#startStopBtn', 'click');
  await expect(page.locator('#globalStatus')).toHaveAttribute('data-state', 'running', { timeout: 10000 });

  // 3. Hit the mock
  const res = await hitMock(17001, '/api/e2e');
  expect(res.status).toBe(200);

  // 4. Wait for the log entry to appear
  await expect(page.locator('.log-entry').filter({ hasText: '/api/e2e' })).toBeVisible({ timeout: 5000 });
});
