import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

const here = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      // Tests use the spec at runtime — the linter, the schema, the hash — and
      // against its source, so a schema change needs no build step to be seen.
      '@pilots/protocol': resolve(here, '../protocol/src/index.ts'),
    },
  },
  test: { name: 'bpmn', include: ['test/**/*.test.ts'], environment: 'node' },
})
