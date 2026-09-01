import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import swc from 'unplugin-swc'
import { defineConfig } from 'vitest/config'

/**
 * Nest's DI reads constructor parameter types from decorator metadata, which
 * esbuild — the transform Vitest uses by default — does not emit. The SWC plugin
 * does, and that is the whole reason this config differs from the protocol
 * package's, which stays plain because it is the tier that must run on save.
 */
const here = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  resolve: {
    alias: {
      // Test against the spec's source, not its build output: changing a schema
      // should not need a build step before the connector's tests see it.
      // More specific entries first: these are prefix matches, so a bare
      // '@pilots/protocol' alias would rewrite the subpath entries into
      // `.../src/index.ts/did-web` and fail with ENOTDIR.
      '@pilots/protocol/did-web': resolve(here, '../../packages/protocol/src/did-web.ts'),
      '@pilots/protocol/testing': resolve(here, '../../packages/protocol/src/testing/index.ts'),
      '@pilots/protocol': resolve(here, '../../packages/protocol/src/index.ts'),
    },
  },
  test: {
    name: 'connector',
    // Resolved here, not from `process.cwd()`: the same tests run both from this
    // package and from the workspace root, and those have different cwds.
    env: { PILOTS_TEST_DEFINITIONS: resolve(here, '../../docs/definitions') },
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    environment: 'node',
  },
})
