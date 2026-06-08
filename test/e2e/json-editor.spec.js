import { test, expect } from '@playwright/test';
import { bootServer } from './helpers.js';

let server;

test.beforeAll(async () => {
  server = await bootServer();
});

test.afterAll(async () => {
  if (server) await server.cleanup();
});

test('format button pretty-prints JSON and validation surfaces errors', async ({ page }) => {
  await page.goto(server.baseURL, { waitUntil: 'load' });
  await page.waitForTimeout(1500);

  // Create an endpoint via API to get the editor form visible
  await page.evaluate(async () => {
    await fetch('/api/endpoints', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port: 17020, method: 'GET', path: '/api/json', statusCode: 200, response: { ok: 1 } }),
    });
  });
  // Reload to pick up the new endpoint
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1500);
  // Select the new endpoint (it should be the first one)
  await page.locator('.endpoint-item').first().dispatchEvent('click');
  await expect(page.locator('#editorForm')).toBeVisible();

  // Focus the CodeMirror editor
  await page.locator('.cm-content').click();

  // Type a valid compact JSON
  await page.keyboard.type('{"a":1,"b":[1,2,3]}');
  // Wait for linter
  await page.waitForTimeout(500);
  await page.dispatchEvent('#formatBtn', 'click');

  // After format, the editor should have multiple lines
  const lineText = await page.locator('#lineCount').textContent();
  expect(lineText).not.toBe('0 行');
  expect(lineText).not.toBe('1 行');

  // Clear and type invalid JSON
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Delete');
  await page.keyboard.type('{"a":');

  // Wait for the linter (200ms debounce + render) to flag invalid
  await expect(page.locator('#validationStatus')).toHaveAttribute('data-state', 'invalid', { timeout: 3000 });
});
