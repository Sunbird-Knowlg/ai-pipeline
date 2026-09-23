import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import turbo from 'eslint-plugin-turbo';
import tseslint from 'typescript-eslint';

/**
 * Type-aware base config for one workspace package.
 *
 * `root` is the package directory — pass `import.meta.dirname` from the package's
 * `eslint.config.js`, so the rules resolve the same way whether eslint runs from the package or
 * from the repo root.
 *
 * We take `recommendedTypeChecked` rather than `strictTypeChecked`: the rules worth having here are
 * the ones only type information can give (floating promises, unsafe `any` flow, misused
 * promises), while the strict preset's ban on `!` would fight `noUncheckedIndexedAccess` in code
 * where the index is provably present.
 */
export function base(root) {
  return defineConfig([
    { ignores: ['dist/**', '.turbo/**'] },
    js.configs.recommended,
    turbo.configs['flat/recommended'],
    {
      files: ['**/*.ts'],
      extends: [tseslint.configs.recommendedTypeChecked, tseslint.configs.stylisticTypeChecked],
      languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: root } },
      rules: {
        // An unawaited promise in a Restate handler is a lost durable step, not a style problem.
        '@typescript-eslint/no-floating-promises': 'error',
        '@typescript-eslint/no-misused-promises': 'error',
        '@typescript-eslint/consistent-type-imports': [
          'error',
          { fixStyle: 'inline-type-imports' },
        ],
        // An object-literal `type` carries an implicit index signature; an `interface` does not.
        // The Restate SDK's by-name clients constrain their generic to an index-signature type, so
        // forcing either form breaks real code. Both stay available.
        '@typescript-eslint/consistent-type-definitions': 'off',
        // `async` is part of a contract here, not an implementation detail: Fastify handlers and
        // hooks are declared async, and stubs implementing an async port must match its signature.
        // The real hazards (unawaited and misused promises) are covered by the two rules above.
        '@typescript-eslint/require-await': 'off',
        '@typescript-eslint/no-unused-vars': [
          'error',
          { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
        ],
        // Every wire status/kind union is mapped exhaustively; a new member must break the build.
        // A `default` branch counts as exhaustive — string dispatch on user input needs one.
        '@typescript-eslint/switch-exhaustiveness-check': [
          'error',
          { considerDefaultExhaustiveForUnions: true },
        ],
      },
    },
    {
      // Tests stub collaborators and reach into SDK internals; the unsafe-`any` rules would only
      // force casts that hide more than the stub does.
      files: ['**/*.test.ts'],
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
    {
      // Config files (`eslint.config.js`) belong to no TypeScript project.
      files: ['**/*.js'],
      extends: [tseslint.configs.disableTypeChecked],
    },
  ]);
}
