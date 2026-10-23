import base from './eslint.base.js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', '**/_generated/**'] },
  ...base,
  {
    languageOptions: { globals: globals.node },
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    files: ['packages/effect-acp/src/compat.ts'],
    rules: { '@typescript-eslint/no-empty-object-type': 'off' },
  },
)
