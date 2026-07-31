import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: ['dist', 'node_modules', 'coverage', 'playwright-report', 'test-results'],
  },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': 'off',
      // Unused arguments prefixed with _ are intentional (interface conformance).
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      // Empty catch blocks are used deliberately where storage may be unavailable.
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    // Supabase Edge Functions run on Deno with remote imports and their own globals.
    files: ['supabase/functions/**/*.ts'],
    languageOptions: { globals: { ...globals.deno } },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
)
