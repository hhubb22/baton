import { defineConfig } from 'vite-plus'

export default defineConfig({
  test: {
    name: 'e2e',
    fsModuleCachePath: 'node_modules/.vitest-cache',
    include: ['src/**/*.integration.test.ts'],
    testTimeout: 10000,
  },
})
