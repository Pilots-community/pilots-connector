import { describe, expect, it } from 'vitest'

import {
  ProcessDefinition,
  definitionRef,
  expandFromStates,
  isTerminal,
  outcomeOf,
  terminalStates,
} from '../src/schemas/definition.js'
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
        { id: 'DONE', title: 'Done', outcome: 'fulfilled' },
      ],
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

/**
 * A process instance's **outcome** — running, fulfilled, or abandoned.
 *
 * The problem this solves is not presentational. A terminal flag said *that* a
 * process had ended and never *how*, so `AGREED` and `REJECTED` were
 * indistinguishable to anything that did not already know the definition's
 * vocabulary. Every integrator therefore hardcoded which of a definition's
 * state names meant success — once per definition it touched.
 *
 * Declaring it on the state, and carrying the computed value on the wire, is
 * what removes that.
 */
describe('state outcomes', () => {
  const definition = ProcessDefinition.parse({
    id: 'x',
    version: '1.0.0',
    kind: 'quotation',
    title: 'X',
    roles: [{ id: 'a', title: 'A' }],
    hostedBy: 'a',
    initialState: 'DRAFT',
    states: [
      { id: 'DRAFT', title: 'Draft' },
      { id: 'AGREED', title: 'Agreed', outcome: 'fulfilled' },
      { id: 'REJECTED', title: 'Rejected', outcome: 'abandoned' },
    ],
    data: { type: 'object' },
    transitions: [
      { id: 'accept', title: 'Accept', from: ['DRAFT'], to: 'AGREED', by: ['a'] },
      { id: 'withdraw', title: 'Withdraw', from: ['*'], to: 'REJECTED', by: ['a'] },
    ],
  })

  it('treats a state with no outcome as still running', () => {
    expect(outcomeOf(definition, 'DRAFT')).toBe('running')
  })

  it('tells a successful ending from an unsuccessful one', () => {
    // The distinction a terminal flag could not make: both are simply "over",
    // so anything generic had to know the names to tell them apart.
    expect(outcomeOf(definition, 'AGREED')).toBe('fulfilled')
    expect(outcomeOf(definition, 'REJECTED')).toBe('abandoned')
  })

  it('derives terminality from the outcome, so the two cannot disagree', () => {
    expect(isTerminal(definition, 'DRAFT')).toBe(false)
    expect(isTerminal(definition, 'AGREED')).toBe(true)
    expect(terminalStates(definition).sort()).toEqual(['AGREED', 'REJECTED'])
  })

  it('reports an unknown state as running rather than throwing', () => {
    // A replica can hold an instance whose definition it has since replaced.
    // A list that renders "in progress" beats one that crashes.
    expect(outcomeOf(definition, 'NO_SUCH_STATE')).toBe('running')
  })

  it('still keeps a wildcard from resurrecting a finished instance', () => {
    const withdraw = definition.transitions.find((t) => t.id === 'withdraw')!
    expect(expandFromStates(definition, withdraw)).toEqual(['DRAFT'])
  })

  it('classifies every shipped definition, with exactly one fulfilled ending', () => {
    // The guard on the claim that this is authored rather than guessed: if a
    // definition ships without saying how it ends, the linter fails it, and if
    // it says so ambiguously this catches it.
    for (const { name, parsed } of shipped) {
      const outcomes = parsed.states.filter((s) => s.outcome !== undefined)
      expect(outcomes.length, name).toBeGreaterThan(0)
      expect(
        outcomes.filter((s) => s.outcome === 'fulfilled'),
        name,
      ).toHaveLength(1)
    }
  })
})
