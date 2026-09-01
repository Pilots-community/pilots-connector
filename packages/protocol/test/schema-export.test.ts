import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import Ajv2020Module from 'ajv/dist/2020.js'
import addFormatsModule from 'ajv-formats'
import { describe, expect, it } from 'vitest'

import { protocolJsonSchemas } from '../src/schema-export.js'
import { loadShippedDefinitions } from './helpers/definitions.js'

type Ajv2020Constructor = typeof Ajv2020Module
const Ajv2020: Ajv2020Constructor =
  typeof Ajv2020Module === 'function'
    ? Ajv2020Module
    : (Ajv2020Module as unknown as { default: Ajv2020Constructor }).default
type AddFormats = (ajv: unknown) => unknown
const addFormats: AddFormats =
  typeof addFormatsModule === 'function'
    ? (addFormatsModule as unknown as AddFormats)
    : (addFormatsModule as unknown as { default: AddFormats }).default

const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), '../schema')

const generated = protocolJsonSchemas()

function ajv() {
  const instance = new Ajv2020({ strict: false, allErrors: true })
  addFormats(instance)
  return instance
}

describe('the committed schema files match the code that generates them', () => {
  it.each(Object.keys(generated))('%s.schema.json is up to date', (name) => {
    const onDisk = JSON.parse(readFileSync(join(SCHEMA_DIR, `${name}.schema.json`), 'utf8'))
    expect(onDisk).toEqual(generated[name as keyof typeof generated])
  })

  it('has no stale files left behind by a renamed schema', () => {
    const onDisk = readdirSync(SCHEMA_DIR)
      .filter((f) => f.endsWith('.schema.json'))
      .map((f) => f.replace('.schema.json', ''))
      .sort()
    expect(onDisk).toEqual(Object.keys(generated).sort())
  })
})

describe('the exported schemas are usable outside TypeScript', () => {
  it('compiles under a plain 2020-12 validator', () => {
    for (const [name, schema] of Object.entries(generated)) {
      expect(() => ajv().compile(schema), name).not.toThrow()
    }
  })

  it('validates the five shipped definitions, which is the point of exporting it', () => {
    const validate = ajv().compile(generated['process-definition'])
    for (const { name, raw } of loadShippedDefinitions()) {
      const valid = validate(raw)
      if (!valid) throw new Error(`${name}: ${JSON.stringify(validate.errors, null, 2)}`)
      expect(valid).toBe(true)
    }
  })

  it('rejects a definition with a mistyped key, exactly as the zod schema does', () => {
    const validate = ajv().compile(generated['process-definition'])
    const [first] = loadShippedDefinitions()
    expect(validate({ ...(first!.raw as object), hostedby: 'weigher' })).toBe(false)
  })

  it('treats fields with defaults as optional, because that is how a human authors one', () => {
    const validate = ajv().compile(generated['process-definition'])
    expect(
      validate({
        id: 'minimal',
        version: '1.0.0',
        kind: 'service',
        title: 'Minimal',
        roles: [{ id: 'a', title: 'A' }],
        hostedBy: 'a',
        initialState: 'START',
        states: [
          { id: 'START', title: 'Start' },
          { id: 'DONE', title: 'Done' },
        ],
        terminalStates: ['DONE'],
        data: { type: 'object' },
        transitions: [{ id: 'finish', title: 'Finish', from: ['START'], to: 'DONE', by: ['a'] }],
      }),
    ).toBe(true)
  })
})
