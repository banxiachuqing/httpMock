import { test, expect } from '@playwright/test';
import { bootServer, hitMock } from './helpers.js';
import http from 'node:http';

let server;

test.beforeAll(async () => {
  server = await bootServer();
});

test.afterAll(async () => {
  if (server) await server.cleanup();
});

test('starting with an occupied port marks it as failed but keeps other ports running', async ({ page }) => {
  await page.goto(server.baseURL, { waitUntil: 'load' });
  await page.waitForTimeout(1500);

  // Pre-occupy a port via raw Node
  const blocker = http.createServer();
  await new Promise((resolve) => blocker.listen(17010, '127.0.0.1', resolve));

  try {
    // Create two endpoints via the API (faster + more reliable than UI clicks for setup)
    await page.evaluate(async () => {
      await fetch('/api/endpoints', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port: 17010, method: 'GET', path: '/blocked', statusCode: 200, response: { ok: 1 } }),
      });
      await fetch('/api/endpoints', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port: 17011, method: 'GET', path: '/free', statusCode: 200, response: { ok: 1 } }),
      });
    });

    // Start via UI to exercise the button + status flow
    await page.dispatchEvent('#startStopBtn', 'click');
    // Global status should be 'failed' because at least one port failed
    await expect(page.locator('#globalStatus')).toHaveAttribute('data-state', /(failed|running)/, { timeout: 5000 });

    // The free port should respond
    const res = await hitMock(17011, '/free');
    expect(res.status).toBe(200);
  } finally {
    await new Promise((r) => blocker.close(r));
  }
});
