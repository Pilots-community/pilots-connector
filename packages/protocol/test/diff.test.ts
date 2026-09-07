/**
 * The diff an operator reads before agreeing to a new version of somebody
 * else's process. What it must get right is *specificity*: naming the field
 * that moved, and not reporting a change where there is none.
 */
import { describe, expect, it } from 'vitest'

import { diffDefinitions } from '../src/lint/diff.js'
import { ProcessDefinition } from '../src/schemas/definition.js'

function defineProcess(overrides: Record<string, unknown> = {}): ProcessDefinition {
  return ProcessDefinition.parse({
    '@context': 'https://pilots.example/process/v1',
    id: 'p',
    version: '1.0.0',
    kind: 'service',
    title: 'P',
    roles: [
      { id: 'a', title: 'A', cardinality: 1, protocolRole: 'requester' },
      { id: 'b', title: 'B', cardinality: 1, protocolRole: 'provider' },
    ],
    hostedBy: 'b',
    initialState: 'START',
    states: [
      { id: 'START', title: 'Start' },
      { id: 'DONE', title: 'Done', outcome: 'fulfilled' },
    ],
    data: { type: 'object' },
    transitions: [{ id: 'go', title: 'Go', from: ['START'], to: 'DONE', by: ['a'] }],
    visibility: [],
    links: [],
    ...overrides,
  })
}

describe('diffDefinitions', () => {
  it('is empty for identical definitions', () => {
    expect(diffDefinitions(defineProcess(), defineProcess())).toEqual([])
  })

  it('is empty when only key order differs, because that is not a change', () => {
    const reordered = defineProcess({
      transitions: [{ title: 'Go', id: 'go', by: ['a'], to: 'DONE', from: ['START'] }],
    })
    expect(diffDefinitions(defineProcess(), reordered)).toEqual([])
  })

  it('reports an added state and says it is a new way to end', () => {
    const after = defineProcess({
      states: [
        { id: 'START', title: 'Start' },
        { id: 'DONE', title: 'Done', outcome: 'fulfilled' },
        { id: 'REFUSED', title: 'Refused', outcome: 'abandoned' },
      ],
    })
    const change = diffDefinitions(defineProcess(), after).find((one) => one.id === 'REFUSED')
    expect(change?.change).toBe('added')
    expect(change?.detail).toContain('terminal state: abandoned')
  })

  it('names the field that changed on a transition, not merely that one did', () => {
    const after = defineProcess({
      transitions: [{ id: 'go', title: 'Go', from: ['START'], to: 'DONE', by: ['a', 'b'] }],
    })
    const change = diffDefinitions(defineProcess(), after).find((one) => one.id === 'go')
    expect(change?.change).toBe('changed')
    expect(change?.detail).toContain('by')
  })

  it('says who gained a right when a transition is added', () => {
    const after = defineProcess({
      states: [
        { id: 'START', title: 'Start' },
        { id: 'DONE', title: 'Done', outcome: 'fulfilled' },
        { id: 'GONE', title: 'Gone', outcome: 'abandoned' },
      ],
      transitions: [
        { id: 'go', title: 'Go', from: ['START'], to: 'DONE', by: ['a'] },
        { id: 'cancel', title: 'Cancel', from: ['*'], to: 'GONE', by: ['b'] },
      ],
    })
    const change = diffDefinitions(defineProcess(), after).find((one) => one.id === 'cancel')
    expect(change?.detail).toContain('fireable by b')
  })

  it('reports a removed role', () => {
    const before = defineProcess({
      roles: [
        { id: 'a', title: 'A', cardinality: 1, protocolRole: 'requester' },
        { id: 'b', title: 'B', cardinality: 1, protocolRole: 'provider' },
        { id: 'c', title: 'C', cardinality: 1, protocolRole: 'observer' },
      ],
    })
    const change = diffDefinitions(before, defineProcess()).find((one) => one.id === 'c')
    expect(change).toEqual({
      kind: 'role',
      change: 'removed',
      id: 'c',
      detail: 'role removed: c',
    })
  })

  it('flags a changed data schema, because it changes what an instance may hold', () => {
    const after = defineProcess({
      data: {
        type: 'object',
        required: ['reference'],
        properties: { reference: { type: 'string' } },
      },
    })
    const change = diffDefinitions(defineProcess(), after).find((one) => one.id === 'data')
    expect(change?.kind).toBe('metadata')
  })

  it('reports a visibility grant by its path', () => {
    const after = defineProcess({ visibility: [{ path: 'price', roles: ['a'] }] })
    const change = diffDefinitions(defineProcess(), after).find((one) => one.kind === 'visibility')
    expect(change).toMatchObject({ change: 'added', id: 'price' })
  })

  it('reports a link by the event it reacts to', () => {
    const after = defineProcess({
      transitions: [
        { id: 'go', title: 'Go', from: ['START'], to: 'DONE', by: ['a'] },
        { id: 'begin', title: 'Begin', from: ['START'], to: 'DONE', by: [] },
      ],
      links: [{ onEvent: 'quotation:AGREED', triggers: 'begin' }],
    })
    const change = diffDefinitions(defineProcess(), after).find((one) => one.kind === 'link')
    expect(change).toMatchObject({ change: 'added', id: 'quotation:AGREED' })
  })

  it('reports who hosts the process changing, which decides who holds the bytes', () => {
    const after = defineProcess({ hostedBy: 'a' })
    const change = diffDefinitions(defineProcess(), after).find((one) => one.id === 'hostedBy')
    expect(change?.detail).toBe('hostedBy: b → a')
  })
})
