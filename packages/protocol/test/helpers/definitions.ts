import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ProcessDefinition } from '../../src/schemas/definition.js'
import type { JsonValue } from '../../src/json.js'

/** The five real definitions in docs/definitions/ — the corpus M1 must satisfy. */
export const DEFINITIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../docs/definitions',
)

export interface ShippedDefinition {
  name: string
  raw: JsonValue
  parsed: ProcessDefinition
}

export function loadShippedDefinitions(): ShippedDefinition[] {
  return readdirSync(DEFINITIONS_DIR)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => {
      const raw = JSON.parse(readFileSync(join(DEFINITIONS_DIR, name), 'utf8')) as JsonValue
      return { name, raw, parsed: ProcessDefinition.parse(raw) }
    })
}

export function shipped(name: string): ProcessDefinition {
  const found = loadShippedDefinitions().find((d) => d.name === name)
  if (!found) throw new Error(`no shipped definition named ${name}`)
  return found.parsed
}
