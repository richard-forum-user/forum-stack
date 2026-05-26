import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  // Build artifacts and third-party / generated JS should never be linted.
  // The Android assets folder is populated by `cap sync` with the same
  // minified bundle that lives in `dist/`. The PWA `public/` tree contains
  // pre-shipped service-worker and icon assets that are not source code.
  globalIgnores([
    'dist/**',
    'android/**',
    'public/service-worker.js',
    'node_modules/**',
  ]),

  // Application source (browser-targeted React + plain JS).
  {
    files: ['src/**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      // Allow intentionally-unused names if they are underscore-prefixed
      // (signature stubs, future plug-in points, swallowed catch vars).
      'no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          caughtErrors: 'all',
        },
      ],
    },
  },

  // Vite config runs in Node, not the browser.
  {
    files: ['vite.config.js'],
    extends: [js.configs.recommended],
    languageOptions: {
      globals: { ...globals.node },
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
    rules: {
      'no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
])
