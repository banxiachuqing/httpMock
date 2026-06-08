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
  await page.goto(server.baseURL);
  await page.click('#newEndpointBtn');

  // Focus the CodeMirror editor
  await page.locator('.cm-content').click();

  // Type a valid compact JSON
  await page.keyboard.type('{"a":1,"b":[1,2,3]}');
  await page.click('#formatBtn');

  // After format, the editor should have multiple lines
  const lineText = await page.locator('#lineCount').textContent();
  expect(lineText).not.toBe('0 lines');
  expect(lineText).not.toBe('1 line');

  // Clear and type invalid JSON
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Delete');
  await page.keyboard.type('{"a":');

  // Wait for the linter (200ms debounce + render) to flag invalid
  await expect(page.locator('#validationStatus')).toHaveAttribute('data-state', 'invalid', { timeout: 3000 });
});
