import { describe, expect, it } from 'vitest'

import { ProcessDefinition, definitionRef, expandFromStates } from '../src/schemas/definition.js'
import { loadShippedDefinitions } from './helpers/definitions.js'

const shipped = loadShippedDefinitions()

describe('ProcessDefinition schema', () => {
  it('finds the five shipped definitions', () => {
    expect(shipped.map((d) => d.name).sort()).toEqual([
      'container-transport-quotation.json',
      'container-transport-with-terminal.json',
      'container-transport.json',
      'container-weighing-quotation.json',
      'container-weighing.json',
    ])
  })

  it.each(shipped)('parses $name', ({ raw }) => {
    const result = ProcessDefinition.safeParse(raw)
    if (!result.success) throw new Error(JSON.stringify(result.error.issues, null, 2))
    expect(result.success).toBe(true)
  })

  it('applies defaults for the optional collections', () => {
    const minimal = ProcessDefinition.parse({
      id: 'x',
      version: '1.0.0',
      kind: 'service',
      title: 'X',
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
    })
    expect(minimal['@context']).toBe('https://pilots.example/process/v1')
    expect(minimal.defaultVisibility).toBe('all')
    expect(minimal.visibility).toEqual([])
    expect(minimal.links).toEqual([])
    expect(minimal.roles[0]?.cardinality).toBe(1)
    expect(minimal.transitions[0]?.auto).toBe(false)
  })

  it('rejects an unknown key rather than silently dropping it', () => {
    const weighing = shipped.find((d) => d.name === 'container-weighing.json')!
    const typo = { ...(weighing.raw as object), hostedby: 'weigher' }
    expect(ProcessDefinition.safeParse(typo).success).toBe(false)
  })

  it('rejects a deadline outside the accepted duration subset', () => {
    const withBadDeadline = structuredClone(
      shipped.find((d) => d.name === 'container-transport-quotation.json')!.raw,
    ) as { transitions: Array<Record<string, unknown>> }
    withBadDeadline.transitions[0]!.deadline = 'P1DT2H'
    expect(ProcessDefinition.safeParse(withBadDeadline).success).toBe(false)
  })
})

describe('definitionRef', () => {
  it('joins id and version', () => {
    const weighing = shipped.find((d) => d.name === 'container-weighing.json')!.parsed
    expect(definitionRef(weighing)).toBe('container-weighing@1.0.0')
  })
})

describe('expandFromStates', () => {
  it('leaves explicit from-states alone', () => {
    const weighing = shipped.find((d) => d.name === 'container-weighing.json')!.parsed
    const weigh = weighing.transitions.find((t) => t.id === 'weigh')!
    expect(expandFromStates(weighing, weigh)).toEqual(['TRUCK_ANNOUNCED'])
  })

  it('expands "*" to every non-terminal state, never a terminal one', () => {
    const weighing = shipped.find((d) => d.name === 'container-weighing.json')!.parsed
    const cancel = weighing.transitions.find((t) => t.id === 'cancel')!
    expect(expandFromStates(weighing, cancel)).toEqual([
      'ORDERED',
      'TRUCK_ANNOUNCED',
      'WEIGHED',
      'PAID',
    ])
    expect(expandFromStates(weighing, cancel)).not.toContain('VGM_ISSUED')
    expect(expandFromStates(weighing, cancel)).not.toContain('CANCELLED')
  })
})
