// @ts-check
/**
 * One lint run for the whole workspace.
 *
 * The rule that earns its keep here is the **boundary rule**: `apps/process-ui`
 * may import `packages/client` and `packages/protocol`, and may never import
 * from `apps/connector`. If the demo UI needs something the local API does not
 * expose, that is a gap in the local API, not a reason to reach inside — and
 * that is also what guarantees a third party's UI can do everything ours can.
 *
 * The `apps/*` element types below are declared before those packages exist, on
 * purpose: the rule should be in force from the first file they contain rather
 * than added once someone has already crossed the line.
 */
import js from '@eslint/js'
import boundaries from 'eslint-plugin-boundaries'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      // Tooling that ships with the agent skills, not this project's source.
      '.claude/**',
      '**/dist/**',
      '**/coverage/**',
      '**/node_modules/**',
      'packages/*/schema/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    settings: {
      'boundaries/elements': [
        { type: 'protocol', pattern: 'packages/protocol/*' },
        { type: 'client', pattern: 'packages/client/*' },
        { type: 'connector', pattern: 'apps/connector/*' },
        { type: 'process-ui', pattern: 'apps/process-ui/*' },
        { type: 'e2e', pattern: 'tests/e2e/*' },
      ],
      'boundaries/include': ['packages/**/*', 'apps/**/*', 'tests/**/*'],
    },
    plugins: { boundaries },
    rules: {
      'boundaries/dependencies': [
        'error',
        {
          default: 'disallow',
          policies: [
            // The spec depends on nobody in this workspace.
            {
              from: { element: { type: 'protocol' } },
              allow: { to: { element: { type: 'protocol' } } },
            },
            {
              from: { element: { type: 'client' } },
              allow: { to: { element: { types: { anyOf: ['client', 'protocol'] } } } },
            },
            {
              from: { element: { type: 'connector' } },
              allow: {
                to: { element: { types: { anyOf: ['connector', 'client', 'protocol'] } } },
              },
            },
            // The one that matters: never `connector`.
            {
              from: { element: { type: 'process-ui' } },
              allow: {
                to: { element: { types: { anyOf: ['process-ui', 'client', 'protocol'] } } },
              },
            },
            {
              from: { element: { type: 'e2e' } },
              allow: { to: { element: { types: { anyOf: ['e2e', 'client', 'protocol'] } } } },
            },
          ],
        },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // The store and the wire both hand us `unknown`; narrowing it is the job.
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      // Ports are async by contract, not by implementation: the local signer and
      // the static resolver have nothing to await, and a remote one will. An
      // implementation that drops `async` to satisfy a linter breaks the port.
      '@typescript-eslint/require-await': 'off',
      // TypeScript resolves identifiers; no-undef only duplicates it, badly.
      'no-undef': 'off',
    },
  },
  {
    // Tests deliberately construct malformed documents to prove they are refused.
    files: ['**/test/**/*.ts', '**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
    },
  },
  {
    // Config files sit outside every tsconfig, so type-aware rules cannot run on them.
    files: ['**/*.js', '**/*.mjs', '**/*.cjs', '**/*.config.ts', '**/*.config.mts'],
    ...tseslint.configs.disableTypeChecked,
  },
)
