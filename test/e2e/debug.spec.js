import { test, expect } from '@playwright/test';
import { bootServer } from '/Users/zhangjie/Documents/idea-work/httpWork/test/e2e/helpers.js';

let server;

test.beforeAll(async () => {
  server = await bootServer();
});

test.afterAll(async () => {
  if (server) await server.cleanup();
});

test('debug', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push('CONSOLE: ' + msg.text());
  });
  page.on('requestfailed', (req) => errors.push('REQFAIL: ' + req.url() + ' ' + req.failure()?.errorText));

  await page.goto(server.baseURL);
  await page.waitForTimeout(2000);

  const html = await page.content();
  console.log('HAS newEndpointBtn:', html.includes('newEndpointBtn'));
  console.log('HAS editor.js script:', html.includes('editor.js'));
  console.log('--- errors ---');
  errors.forEach((e) => console.log(e));
  console.log('--- title ---');
  console.log(await page.title());
  console.log('--- first 500 chars of body ---');
  const body = await page.locator('body').innerHTML();
  console.log(body.substring(0, 500));
});
