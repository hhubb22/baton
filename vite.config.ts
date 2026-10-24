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
      '**/fixtures/**',
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
        files: ['packages/effect-acp/scripts/generate.ts', 'packages/effect-codex-app-server/scripts/generate.ts'],
        // JSON Schema 来自 JSON 解码，JsonObject 按普通记录展开。
        rules: {
          'typescript/no-misused-spread': [
            'warn',
            { allow: [{ from: 'package', package: 'effect', name: 'JsonObject' }] },
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
      '**/fixtures/**',
      '**/pnpm-lock.yaml',
      '**/package-lock.json',
      'skills-lock.json',
      '**/*.md',
      '.agents/**',
      '.claude/**',
      'internal/**',
      'design/**',
      'third_party/**',
      'packages/effect-acp/**',
      'packages/effect-codex-app-server/**',
    ],
  },
})
