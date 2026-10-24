import { defineConfig } from 'vite-plus'

export default defineConfig({
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
    ignorePatterns: [
      '**/dist/**',
      '**/_generated/**',
      'packages/provider-testing/test/fixtures/**',
      'packages/protocol/fixtures/**',
      'upstream/**',
      '.agents/**',
      '.claude/**',
      'internal/**',
      'design/**',
      'third_party/**',
    ],
    overrides: [
      {
        files: ['runtimes/project-agent/test/**/*.ts', 'tools/*.test.mjs'],
        // Node runner 管理测试注册的 Promise；其余异步调用继续检查。
        rules: {
          'typescript/no-floating-promises': [
            'warn',
            { allowForKnownSafeCalls: [{ from: 'package', package: 'node:test', name: 'test' }] },
          ],
        },
      },
      {
        files: ['web/src/**/*.{ts,tsx}'],
        plugins: ['react'],
        env: { browser: true },
      },
    ],
  },
  fmt: {
    semi: false,
    singleQuote: true,
    printWidth: 120,
    sortPackageJson: false,
    ignorePatterns: [
      '**/dist/**',
      '**/_generated/**',
      'packages/provider-testing/test/fixtures/**',
      'packages/protocol/fixtures/**',
      'upstream/**',
      '**/pnpm-lock.yaml',
      '**/package-lock.json',
      'skills-lock.json',
      '**/*.md',
      '.agents/**',
      '.claude/**',
      'internal/**',
      'design/**',
      'third_party/**',
    ],
  },
})
