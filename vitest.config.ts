import { defineConfig } from 'vite-plus'
import { configDefaults } from 'vitest/config'

// Windows 启动进程、打包 bundle 与文件系统操作明显慢于 POSIX：并发跑全量时既需要更大超时，
// 也需要限制同时运行的文件数，否则各测试争抢进程与磁盘导致互相拖慢。
const windows = process.platform === 'win32'
const timeoutScale = windows ? 4 : 1

export default defineConfig({
  test: {
    fsModuleCachePath: 'node_modules/.vitest-cache',
    passWithNoTests: true,
    testTimeout: 10000 * timeoutScale,
    hookTimeout: 10000 * timeoutScale,
    ...(windows ? { maxWorkers: 2 } : {}),
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
          exclude: [...configDefaults.exclude, '**/*.integration.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['src/**/*.integration.test.ts', 'test/**/*.integration.test.ts'],
        },
      },
    ],
  },
})
