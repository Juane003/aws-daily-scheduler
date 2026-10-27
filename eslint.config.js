// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

// Layer boundaries from CLAUDE.md §1, enforced as lint errors.

const INFRASTRUCTURE_PACKAGES = [
  { group: ['@aws-sdk/*', 'aws-lambda'], message: 'AWS belongs in infrastructure/.' },
  { group: ['pg', 'pg-*'], message: 'Postgres belongs in infrastructure/.' },
];

const IMPURE_SYNTAX = [
  {
    selector: "NewExpression[callee.name='Date'][arguments.length=0]",
    message: 'Read the time from the Clock port.',
  },
  {
    selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
    message: 'Read the time from the Clock port.',
  },
  {
    selector: "CallExpression[callee.object.name='Math'][callee.property.name='random']",
    message: 'Inject the random source.',
  },
];

const IO_GLOBALS = [
  { name: 'fetch', message: 'HTTP belongs in infrastructure/.' },
  { name: 'process', message: 'Configuration is read in infrastructure/handlers.' },
];

export default tseslint.config(
  { ignores: ['dist/', 'coverage/', 'node_modules/', 'cdk.out/'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['**/application/**', '**/infrastructure/**'], message: 'domain/ imports nothing from outer layers.' },
            { group: ['node:*'], message: 'domain/ has no Node built-ins.' },
            ...INFRASTRUCTURE_PACKAGES,
          ],
        },
      ],
      'no-restricted-syntax': ['error', ...IMPURE_SYNTAX],
      'no-restricted-globals': ['error', ...IO_GLOBALS],
    },
  },
  {
    files: ['src/application/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['**/infrastructure/**'], message: 'application/ depends only on domain/ and its ports.' },
            { group: ['node:*'], message: 'application/ has no Node built-ins.' },
            ...INFRASTRUCTURE_PACKAGES,
          ],
        },
      ],
      'no-restricted-syntax': ['error', ...IMPURE_SYNTAX],
      'no-restricted-globals': ['error', ...IO_GLOBALS],
    },
  },
);
