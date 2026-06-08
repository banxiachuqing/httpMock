import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.js', 'test/integration/**/*.test.js'],
    testTimeout: 10000,
    hookTimeout: 10000,
  },
});
