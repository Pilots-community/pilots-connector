import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

const here = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      // Against source, so a change to the client or the spec is visible here
      // without a build step. Note what is *not* aliased: `apps/connector`. It
      // must not be reachable from this app, and the lint rule says so too.
      '@pilots/client': resolve(here, '../../packages/client/src/index.ts'),
      '@pilots/protocol': resolve(here, '../../packages/protocol/src/index.ts'),
    },
  },
  test: { name: 'process-ui', include: ['test/**/*.test.ts'], environment: 'node' },
})
