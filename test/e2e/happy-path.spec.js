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
  await page.waitForTimeout(1500);

  // Configure endpoint via API (faster + more reliable than UI clicks for setup)
  const createResp = await page.evaluate(async () => {
    const r = await fetch('/api/endpoints', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        port: 17001, method: 'GET', path: '/api/e2e',
        statusCode: 200, response: { hello: 'world' }, enabled: true,
      }),
    });
    return { status: r.status, body: await r.json() };
  });
  expect(createResp.status).toBe(201);

  // Start the mock engine via API
  const startResp = await page.evaluate(async () => {
    const r = await fetch('/api/runtime/start', { method: 'POST' });
    return { status: r.status, body: await r.json() };
  });
  expect(startResp.status).toBe(200);
  expect(startResp.body.running.map((p) => p.port)).toContain(17001);
  expect(startResp.body.failed).toEqual([]);

  // Hit the mock
  const res = await hitMock(17001, '/api/e2e');
  expect(res.status).toBe(200);
  expect(JSON.parse(res.body)).toEqual({ hello: 'world' });

  // Reload the page and verify the runtime status is reflected
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1500);
  // Hit again — log should appear via SSE
  await hitMock(17001, '/api/e2e');
  // Verify the log entry appears in the UI
  await expect(page.locator('.log-entry').first()).toBeVisible({ timeout: 5000 });
});
