import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'e2e',
  testMatch: /.*\.spec\.ts/,
  timeout: 180_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'line',
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  use: {
    ignoreHTTPSErrors: true,
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
})
