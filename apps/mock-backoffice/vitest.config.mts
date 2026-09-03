import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

const here = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@pilots/client': resolve(here, '../../packages/client/src/index.ts'),
      '@pilots/protocol': resolve(here, '../../packages/protocol/src/index.ts'),
    },
  },
  test: { name: 'mock-backoffice', include: ['test/**/*.test.ts'], environment: 'node' },
})
