import { base } from '@ai-pipeline/eslint-config/base';

/**
 * Root-level files that belong to no package: the e2e suites and the Vitest config. Each package
 * lints its own sources through its own `eslint.config.js`.
 */
export default [
  { ignores: ['{apps,packages,services,workflows}/*/**', 'tests/fixtures/*/**'] },
  ...base(import.meta.dirname),
  {
    // Test support and the Vitest config are test code: same relaxations as `*.test.ts`.
    files: ['tests/**/*.ts', 'vitest.config.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
    },
  },
];
