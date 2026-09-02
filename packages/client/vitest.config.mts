import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

const here = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      // Against the spec's source, so a schema change needs no build step to be
      // seen here.
      '@pilots/protocol': resolve(here, '../protocol/src/index.ts'),
    },
  },
  test: { name: 'client', include: ['test/**/*.test.ts'], environment: 'node' },
})
