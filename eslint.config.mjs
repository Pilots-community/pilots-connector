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
        { type: 'bpmn', pattern: 'packages/bpmn/*' },
        { type: 'connector-test', pattern: 'apps/connector/test/**' },
        { type: 'connector', pattern: 'apps/connector/*' },
        { type: 'process-ui', pattern: 'apps/process-ui/*' },
        { type: 'backoffice', pattern: 'apps/mock-backoffice/*' },
        { type: 'e2e', pattern: 'tests/e2e/*' },
      ],
      'boundaries/include': ['packages/**/*', 'apps/**/*', 'tests/**/*'],
      /*
       * Without a resolver the boundary rule is **silently inert**: it cannot
       * turn `../../../connector/src/x.js` into a file, so it classifies
       * nothing and reports nothing. It looked configured and enforced nothing
       * from M2 until M5, which is the failure mode a lint rule has — it is
       * quiet either way, so the only proof it works is watching it refuse
       * something.
       *
       * `eslint-import-resolver-typescript` also maps the `.js` specifier a
       * NodeNext import writes back to the `.ts` on disk, which every import in
       * this repo relies on.
       */
      'import/resolver': {
        typescript: {
          alwaysTryTypes: true,
          project: ['packages/*/tsconfig.json', 'apps/*/tsconfig.json', 'tests/e2e/tsconfig.json'],
          // A workspace genuinely has several projects; the warning is advice
          // about speed, not a problem to fix.
          noWarnOnMultipleProjects: true,
        },
      },
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
            // The diagram is a projection of the spec and depends on nothing else.
            {
              from: { element: { type: 'bpmn' } },
              allow: { to: { element: { types: { anyOf: ['bpmn', 'protocol'] } } } },
            },
            // A scenario test may build its fixture with the editor's commands, to
            // prove an editor-made process runs here. The connector itself may not.
            {
              from: { element: { type: 'connector-test' } },
              allow: {
                to: {
                  element: {
                    types: { anyOf: ['connector-test', 'connector', 'client', 'protocol', 'bpmn'] },
                  },
                },
              },
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
            // The backoffice is an ordinary integrator: the client and nothing
            // else. If it ever needed the connector's internals, so would every
            // real integrator, and the claim would be false.
            {
              from: { element: { type: 'backoffice' } },
              allow: {
                to: { element: { types: { anyOf: ['backoffice', 'client', 'protocol'] } } },
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
