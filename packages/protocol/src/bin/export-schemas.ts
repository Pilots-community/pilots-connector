#!/usr/bin/env node
/**
 * Write the JSON Schema export to disk.
 *
 *     pnpm --filter @pilots/protocol schema:export
 *
 * The generated files are committed, and a test asserts they match what this
 * script produces — so a schema change that is not exported fails the build
 * rather than silently shipping a stale contract.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { protocolJsonSchemas } from '../schema-export.js'

const outputDir = resolve(process.argv[2] ?? 'schema')
mkdirSync(outputDir, { recursive: true })

const schemas = protocolJsonSchemas()
for (const [name, schema] of Object.entries(schemas)) {
  const file = join(outputDir, `${name}.schema.json`)
  writeFileSync(file, `${JSON.stringify(schema, null, 2)}\n`, 'utf8')
  process.stdout.write(`wrote ${file}\n`)
}
