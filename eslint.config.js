// @ts-check
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'coverage/', 'node_modules/', 'cdk.out/'] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      'no-console': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    },
  },
  { files: ['**/*.js'], ...tseslint.configs.disableTypeChecked },
  prettier,
);
