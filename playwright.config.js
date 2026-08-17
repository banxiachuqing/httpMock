import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './test/e2e',
  timeout: 30000,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    // 默认无头模式运行（项目约定 2026-08-17）；MOCK_E2E_HEADED=1 可切回前台（人工观察排错）
    headless: process.env.MOCK_E2E_HEADED !== '1',
    slowMo: process.env.MOCK_E2E_HEADED === '1' ? 50 : 0,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
