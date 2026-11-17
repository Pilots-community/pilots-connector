/**
 * The field builder: a business user's view of the `data` schema.
 *
 * It must never drop what it cannot show — a `pattern`, a `minimum` — so such a
 * field is classified `null` and shown read-only, and every write leaves the
 * rest of the schema exactly as it was.
 */
import { describe, expect, it } from 'vitest'

import { classify, readFields, removeField, setField } from '../src/forms/fields.js'
import { example } from './helpers/examples.js'

describe('classify', () => {
  it.each([
    [{ type: 'string' }, 'text'],
    [{ type: 'number' }, 'number'],
    [{ type: 'string', format: 'date-time' }, 'datetime'],
    [{ type: 'string', enum: ['a', 'b'] }, 'choice'],
    [{ type: 'boolean' }, 'boolean'],
    [{ type: 'object', properties: {}, required: [] }, 'group'],
  ])('recognises %j as %s', (schema, type) => {
    expect(classify(schema)).toBe(type)
  })

  it.each([
    { type: 'string', pattern: '^[A-Z]+$' },
    { type: 'number', minimum: 0 },
    { type: 'string', format: 'email' },
    { type: 'array' },
    { type: 'object', additionalProperties: false },
  ])('leaves %j to the JSON tab', (schema) => {
    expect(classify(schema)).toBeNull()
  })
})

describe('readFields on a committed definition', () => {
  const fields = readFields(example('container-transport-quotation').data)

  it('shows a group the form can edit in full', () => {
    const pickup = fields.find((field) => field.name === 'pickup')!
    expect(pickup).toMatchObject({ type: 'group', required: true })
    expect(pickup.fields.map((f) => [f.name, f.type])).toEqual([
      ['location', 'text'],
      ['earliest', 'datetime'],
      ['latest', 'datetime'],
    ])
  })

  it('flags what it cannot show rather than guessing', () => {
    expect(fields.find((field) => field.name === 'containerNumber')?.type).toBeNull()
    const price = fields.find((field) => field.name === 'price')!
    expect(price.fields.find((f) => f.name === 'value')?.type).toBeNull()
  })
})

describe('setField and removeField', () => {
  const root = {
    type: 'object',
    additionalProperties: false,
    required: ['a'],
    properties: {
      a: { type: 'string' },
      code: { type: 'string', pattern: '^X' },
      group: { type: 'object', properties: { inner: { type: 'number' } } },
    },
  }

  it('adds a field and its required flag without touching anything else', () => {
    const result = setField(root, ['b'], { type: 'choice', options: ['x', 'y'], required: true })
    expect(result.ok && result.schema).toEqual({
      ...root,
      required: ['a', 'b'],
      properties: { ...root.properties, b: { type: 'string', enum: ['x', 'y'] } },
    })
  })

  it('changes a field’s type, and drops `required` once nothing is left in it', () => {
    const result = setField(root, ['a'], { type: 'number', required: false })
    expect(result.ok && result.schema['required']).toBeUndefined()
    expect(result.ok && (result.schema['properties'] as Record<string, unknown>)['a']).toEqual({ type: 'number' })
  })

  it('edits inside a group, and keeps a group’s children when only its flag changes', () => {
    const inner = setField(root, ['group', 'more'], { type: 'boolean', required: false })
    expect(inner.ok && JSON.stringify(inner.schema)).toContain('"more":{"type":"boolean"}')
    const flag = setField(root, ['group'], { type: 'group', required: true })
    expect(flag.ok && JSON.stringify(flag.schema)).toContain('"inner":{"type":"number"}')
  })

  it('refuses to overwrite what it cannot show', () => {
    expect(setField(root, ['code'], { type: 'text', required: false }).ok).toBe(false)
  })

  it('removes a field and its required flag', () => {
    const result = removeField(root, ['a'])
    expect(result.ok && result.schema['required']).toBeUndefined()
    expect(result.ok && Object.keys(result.schema['properties'] as object)).toEqual(['code', 'group'])
  })
})
