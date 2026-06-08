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
  await page.goto(server.baseURL);

  // 1. Create an endpoint
  await page.click('#newEndpointBtn');
  await page.fill('#port', '17001');
  await page.fill('#path', '/api/e2e');
  // CodeMirror content; save first (response can be empty)
  await page.click('#saveBtn');

  // 2. Start runtime
  await page.click('#startStopBtn');
  await expect(page.locator('#globalStatus')).toHaveAttribute('data-state', 'running', { timeout: 5000 });

  // 3. Hit the mock
  const res = await hitMock(17001, '/api/e2e');
  expect(res.status).toBe(200);

  // 4. Wait for the log entry to appear
  await expect(page.locator('.log-entry').filter({ hasText: '/api/e2e' })).toBeVisible({ timeout: 5000 });
});
