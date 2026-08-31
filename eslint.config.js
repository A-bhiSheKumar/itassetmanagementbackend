import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';

export default [
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**'] },
  {
    files: ['src/**/*.ts', 'tests/**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: { ecmaVersion: 2023, sourceType: 'module' },
    },
    plugins: { '@typescript-eslint': tseslint },
    rules: {
      ...tseslint.configs.recommended.rules,
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-console': 'error',
    },
  },

  // ── Module boundaries (ADR-008) ──────────────────────────────────────────
  // Modules talk to each other through index.ts only. Reaching into another
  // module's model/repository/service is a build failure, not a review note.
  {
    files: ['src/modules/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/modules/*/*', '!**/modules/*/index', '!./*', '!../*/index'],
              message:
                "Import other modules through their index.ts only. Never reach into another module's internals.",
            },
          ],
        },
      ],
    },
  },

  // ── The tenant-scope escape hatch is restricted to the platform module ────
  {
    files: ['src/**/*.ts'],
    ignores: ['src/core/**', 'src/modules/platform/**', 'tests/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@core/context',
              importNames: ['withoutTenantScope'],
              message:
                'withoutTenantScope() is restricted to src/modules/platform/. Cross-tenant reads must be deliberate and audited.',
            },
          ],
        },
      ],
    },
  },
];
