/**
 * Which parts of a definition can actually be walked, and by what.
 *
 * The distinction these tests pin down is the one that let a valid definition
 * produce an instance that could never succeed: `links` are declared per
 * definition and anchored **per instance**, so a link-fired edge is walkable
 * only when the relation it names is set on the instance being asked about.
 */
import { describe, expect, it } from 'vitest'

import {
  analyseReachability,
  definitionEdges,
  statesWithoutFireableExit,
  statesWithoutFulfilment,
} from '../src/engine/reachability.js'
import { ProcessDefinition } from '../src/schemas/definition.js'

/** A minimal valid definition, so each case shows only what it is testing. */
function defineProcess(overrides: Record<string, unknown>): ProcessDefinition {
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
      { id: 'GONE', title: 'Gone', outcome: 'abandoned' },
    ],
    data: { type: 'object' },
    transitions: [],
    visibility: [],
    links: [],
    ...overrides,
  })
}

describe('definitionEdges', () => {
  it('marks an edge a participant may fire', () => {
    const definition = defineProcess({
      transitions: [{ id: 'go', title: 'Go', from: ['START'], to: 'DONE', by: ['a'] }],
    })
    const edges = definitionEdges(definition)
    expect(edges).toHaveLength(1)
    expect(edges[0]?.drivers).toEqual(['participant'])
  })

  it('marks an auto edge, which no participant fires', () => {
    const definition = defineProcess({
      transitions: [{ id: 'go', title: 'Go', from: ['START'], to: 'DONE', by: [], auto: true }],
    })
    expect(definitionEdges(definition)[0]?.drivers).toEqual(['auto'])
  })

  it('marks an edge a link fires, naming the relation', () => {
    const definition = defineProcess({
      transitions: [{ id: 'go', title: 'Go', from: ['START'], to: 'DONE', by: [] }],
      links: [{ onEvent: 'quotation:AGREED', triggers: 'go' }],
    })
    expect(definitionEdges(definition)[0]?.drivers).toEqual([{ link: 'quotation' }])
  })

  it('marks an edge a deadline fires, from the state the deadline arms in', () => {
    // `arm` enters WAIT and arms PT1H; when it expires, `lapse` fires from WAIT.
    const definition = defineProcess({
      states: [
        { id: 'START', title: 'Start' },
        { id: 'WAIT', title: 'Wait' },
        { id: 'DONE', title: 'Done', outcome: 'fulfilled' },
        { id: 'GONE', title: 'Gone', outcome: 'abandoned' },
      ],
      transitions: [
        {
          id: 'arm',
          title: 'Arm',
          from: ['START'],
          to: 'WAIT',
          by: ['a'],
          deadline: 'PT1H',
          onDeadline: 'lapse',
        },
        { id: 'lapse', title: 'Lapse', from: ['WAIT'], to: 'GONE', by: [] },
        { id: 'finish', title: 'Finish', from: ['WAIT'], to: 'DONE', by: ['b'] },
      ],
    })
    const lapse = definitionEdges(definition).find((edge) => edge.transition === 'lapse')
    expect(lapse?.drivers).toEqual(['deadline'])
  })
})

describe('analyseReachability', () => {
  it('reaches fulfilment across participant edges', () => {
    const definition = defineProcess({
      transitions: [{ id: 'go', title: 'Go', from: ['START'], to: 'DONE', by: ['a'] }],
    })
    const result = analyseReachability(definition)
    expect(result.fulfilmentReachable).toBe(true)
    expect(result.unlockingRelations).toEqual([])
  })

  it('does NOT reach fulfilment when the only forward edge waits on an unanchored relation', () => {
    // The shape of container-transport: PENDING_CONTRACT is left only by a
    // link-fired transition, and cancel reaches an *abandoned* ending.
    const definition = defineProcess({
      transitions: [
        { id: 'start', title: 'Start', from: ['START'], to: 'DONE', by: [] },
        { id: 'cancel', title: 'Cancel', from: ['*'], to: 'GONE', by: ['a', 'b'] },
      ],
      links: [{ onEvent: 'quotation:AGREED', triggers: 'start' }],
    })
    const result = analyseReachability(definition)
    expect(result.fulfilmentReachable).toBe(false)
    expect(result.unlockingRelations).toEqual(['quotation'])
  })

  it('reaches fulfilment once that relation is anchored', () => {
    const definition = defineProcess({
      transitions: [
        { id: 'start', title: 'Start', from: ['START'], to: 'DONE', by: [] },
        { id: 'cancel', title: 'Cancel', from: ['*'], to: 'GONE', by: ['a', 'b'] },
      ],
      links: [{ onEvent: 'quotation:AGREED', triggers: 'start' }],
    })
    expect(
      analyseReachability(definition, { anchoredRelations: ['quotation'] }).fulfilmentReachable,
    ).toBe(true)
    expect(analyseReachability(definition, { anchoredRelations: 'all' }).fulfilmentReachable).toBe(
      true,
    )
  })

  it('treats an abandoned-only ending as not fulfilled', () => {
    const definition = defineProcess({
      transitions: [{ id: 'quit', title: 'Quit', from: ['START'], to: 'GONE', by: ['a'] }],
    })
    expect(analyseReachability(definition).fulfilmentReachable).toBe(false)
    expect(analyseReachability(definition).unlockingRelations).toEqual([])
  })
})

describe('statesWithoutFireableExit', () => {
  it('finds a state nothing at all can leave', () => {
    const definition = defineProcess({
      states: [
        { id: 'START', title: 'Start' },
        { id: 'STUCK', title: 'Stuck' },
        { id: 'DONE', title: 'Done', outcome: 'fulfilled' },
        { id: 'GONE', title: 'Gone', outcome: 'abandoned' },
      ],
      transitions: [
        { id: 'go', title: 'Go', from: ['START'], to: 'STUCK', by: ['a'] },
        { id: 'win', title: 'Win', from: ['START'], to: 'DONE', by: ['a'] },
      ],
    })
    expect(statesWithoutFireableExit(definition)).toEqual(['STUCK'])
  })

  it('does not fault a terminal state for having no exit', () => {
    const definition = defineProcess({
      transitions: [{ id: 'go', title: 'Go', from: ['START'], to: 'DONE', by: ['a'] }],
    })
    expect(statesWithoutFireableExit(definition)).toEqual([])
  })

  it('counts a link-fired exit as fireable, since the runtime can walk it', () => {
    const definition = defineProcess({
      transitions: [{ id: 'go', title: 'Go', from: ['START'], to: 'DONE', by: [] }],
      links: [{ onEvent: 'quotation:AGREED', triggers: 'go' }],
    })
    expect(statesWithoutFireableExit(definition)).toEqual([])
  })
})

describe('statesWithoutFulfilment', () => {
  it('finds a non-terminal state that can only end badly', () => {
    const definition = defineProcess({
      states: [
        { id: 'START', title: 'Start' },
        { id: 'DOOMED', title: 'Doomed' },
        { id: 'DONE', title: 'Done', outcome: 'fulfilled' },
        { id: 'GONE', title: 'Gone', outcome: 'abandoned' },
      ],
      transitions: [
        { id: 'win', title: 'Win', from: ['START'], to: 'DONE', by: ['a'] },
        { id: 'doom', title: 'Doom', from: ['START'], to: 'DOOMED', by: ['a'] },
        { id: 'quit', title: 'Quit', from: ['DOOMED'], to: 'GONE', by: ['a'] },
      ],
    })
    expect(statesWithoutFulfilment(definition)).toEqual(['DOOMED'])
  })
})
