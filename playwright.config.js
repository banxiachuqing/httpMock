import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './test/e2e',
  timeout: 30000,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    // 默认 headed（项目约定）；MOCK_E2E_HEADLESS=1 可切无头（CI/远程环境）
    headless: process.env.MOCK_E2E_HEADLESS === '1',
    slowMo: process.env.MOCK_E2E_HEADLESS === '1' ? 0 : 50,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
