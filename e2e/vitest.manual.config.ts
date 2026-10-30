import { defineConfig } from 'vite-plus'

export default defineConfig({ test: { include: ['src/update-package.manual.test.ts'], testTimeout: 240000 } })
