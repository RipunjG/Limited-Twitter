import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'public/silentfeed.user.js', 'node_modules'] },

  // Application + userscript sources: type-aware linting.
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
    files: ['src/**/*.{ts,tsx}', 'shared/**/*.ts', 'userscript/src/**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser, ...globals.greasemonkey },
      parserOptions: {
        project: ['./tsconfig.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // Unused args are fine when prefixed with _, matching tsconfig.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // `void somePromise()` is the codebase's deliberate fire-and-forget
      // marker; the rule would flag every one of them.
      '@typescript-eslint/no-confusing-void-expression': 'off',
    },
  },

  // Build tooling runs in Node and is not covered by tsconfig's project.
  {
    extends: [js.configs.recommended],
    files: ['userscript/build.mjs', 'vite.config.ts', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: globals.node,
    },
  },
);
