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
      'upstream/**',
      '.agents/**',
      '.claude/**',
      'design/**',
      'third_party/**',
    ],
    overrides: [
      {
        files: ['tools/*.test.mjs'],
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
      'upstream/**',
      '**/pnpm-lock.yaml',
      '**/package-lock.json',
      'skills-lock.json',
      '**/*.md',
      '.agents/**',
      '.claude/**',
      'design/**',
      'third_party/**',
    ],
  },
})
