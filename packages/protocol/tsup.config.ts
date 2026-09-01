import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'testing/index': 'src/testing/index.ts',
    'did-web': 'src/did-web.ts',
    'bin/lint-definitions': 'src/bin/lint-definitions.ts',
    'bin/export-schemas': 'src/bin/export-schemas.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'node24',
  platform: 'node',
  // canonicalize is ESM-only and publishes no `require` condition, so a CJS
  // consumer (the NestJS connector) cannot load it. It is ~100 lines and it is
  // the one primitive every hash and signature depends on: inline it.
  noExternal: ['canonicalize'],
  banner: { js: '' },
})
