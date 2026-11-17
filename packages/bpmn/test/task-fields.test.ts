import { describe, expect, it } from 'vitest'

import type { TransitionDocument } from '../src/document.js'
import { readTaskFields, writeTaskFields } from '../src/forms/task-fields.js'
import { example } from './helpers/examples.js'

const quotation = example('container-transport-quotation')
const offer = quotation.transitions.find((t) => t.id === 'offer')!

describe('readTaskFields', () => {
  it('reads what a step fills in and what must already be there', () => {
    const view = readTaskFields(offer)
    expect(view.fills.map((f) => f.name)).toEqual(['price', 'pickup', 'dropoff', 'terms', 'notes'])
    expect(view.fills.find((f) => f.name === 'price')?.required).toBe(true)
    expect(view.requires).toEqual(['price'])
    expect(view.advanced).toBe(false)
  })

  it('calls a guard it cannot express advanced, rather than ignoring it', () => {
    const odd: TransitionDocument = { ...offer, guards: [{ properties: { price: { minimum: 1 } } }] }
    expect(readTaskFields(odd).advanced).toBe(true)
    expect(writeTaskFields(odd, quotation.data, { fills: [], requires: [] })).toBeNull()
  })
})

describe('writeTaskFields', () => {
  const plain: TransitionDocument = { id: 'go', title: 'Go', from: ['A'], to: 'B', by: ['alpha'] }
  const data = { type: 'object', properties: { note: { type: 'string', maxLength: 5 }, size: { type: 'number' } } }

  it('builds the patch from the data schema, and a guard from what must be present', () => {
    const patch = writeTaskFields(plain, data, { fills: [{ name: 'note', required: true }], requires: ['size'] })
    expect(patch).toEqual({
      patch: { type: 'object', required: ['note'], properties: { note: { type: 'string', maxLength: 5 } } },
      guards: [{ required: ['size'] }],
    })
  })

  it('keeps the schema a step already had for a field, rather than copying it again', () => {
    const counter = quotation.transitions.find((t) => t.id === 'counter')!
    const patch = writeTaskFields(counter, quotation.data, {
      fills: readTaskFields(counter).fills,
      requires: [],
    })
    expect((patch?.patch as { properties: Record<string, unknown> }).properties['price']).toEqual({ type: 'object' })
  })

  it('removes patch and guards when the step fills and requires nothing', () => {
    expect(writeTaskFields(offer, quotation.data, { fills: [], requires: [] })).toEqual({
      patch: undefined,
      guards: undefined,
    })
  })
})
