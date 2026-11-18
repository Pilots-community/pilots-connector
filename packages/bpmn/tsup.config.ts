import { defineConfig } from 'tsup'

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'node24',
  // Drawn in a browser, tested in Node: nothing here may assume either. The
  // protocol and zod are imported as types only, so neither reaches the bundle.
  platform: 'neutral',
})
