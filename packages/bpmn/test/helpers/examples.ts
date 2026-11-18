import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { DefinitionDocument } from '../../src/document.js'

const DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../../docs/definitions')

export interface Example {
  name: string
  document: DefinitionDocument
}

/** The five committed definitions, exactly as written — never parsed, so defaults stay absent. */
export function examples(): Example[] {
  return readdirSync(DIR)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => ({
      name,
      document: JSON.parse(readFileSync(join(DIR, name), 'utf8')) as DefinitionDocument,
    }))
}

export function example(name: string): DefinitionDocument {
  const found = examples().find((one) => one.name === `${name}.json`)
  if (!found) throw new Error(`no example called ${name}`)
  return found.document
}
