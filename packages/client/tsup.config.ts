import { defineConfig } from 'tsup'

export default defineConfig({
  entry: { index: 'src/index.ts', 'bin/export-openapi': 'src/bin/export-openapi.ts' },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'node24',
  // The client runs in a browser as readily as in Node: it uses `fetch` and
  // nothing else. Keeping the platform neutral is what makes it usable from the
  // process UI's SPA and from somebody's backoffice script alike.
  platform: 'neutral',
})
