import { beforeEach, describe, expect, it } from 'vitest'

import {
  availableTransitions,
  autoTransitions,
  evaluateCreate,
  evaluateTransition,
} from '../src/engine/evaluator.js'
import { Problem } from '../src/problems.js'
import { ProcessDefinition } from '../src/schemas/definition.js'
import type { Instance } from '../src/schemas/instance.js'
import { shipped } from './helpers/definitions.js'

const ACME = 'did:web:acme-shipping.example'
const VANMOER = 'did:web:vanmoer.example'
const AT = '2026-08-24T09:14:02.000Z'

const weighing = shipped('container-weighing.json')
const standingQuotation = shipped('container-weighing-quotation.json')
const transportQuotation = shipped('container-transport-quotation.json')

function instanceOf(overrides: Partial<Instance> = {}): Instance {
  return {
    id: '01J0000000000000000000000A',
    kind: 'service',
    definition: 'container-weighing@1.0.0',
    participants: { shipper: ACME, weigher: VANMOER },
    quotationId: null,
    offering: null,
    state: 'ORDERED',
    seq: 1,
    data: { containerNumber: 'MSCU1234567', terminal: '869' },
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  }
}

function problems(result: ReturnType<typeof evaluateTransition>): string[] {
  return result.ok ? [] : result.error.map((e) => e.type)
}

describe('evaluateTransition — the happy path', () => {
  it('applies the patch and moves the state', () => {
    const result = evaluateTransition(weighing, instanceOf(), {
      transition: 'announceTruck',
      patch: { truckPlate: '1-ABC-123', expectedAt: '2026-08-25T08:00:00.000Z' },
      actor: { roles: ['shipper'] },
      at: '2026-08-24T10:00:00.000Z',
    })
    if (!result.ok) throw new Error(JSON.stringify(result.error))
    expect(result.value.from).toBe('ORDERED')
    expect(result.value.to).toBe('TRUCK_ANNOUNCED')
    expect(result.value.instance.state).toBe('TRUCK_ANNOUNCED')
    expect(result.value.instance.seq).toBe(2)
    expect(result.value.instance.updatedAt).toBe('2026-08-24T10:00:00.000Z')
    expect(result.value.instance.data).toEqual({
      containerNumber: 'MSCU1234567',
      terminal: '869',
      truckPlate: '1-ABC-123',
      expectedAt: '2026-08-25T08:00:00.000Z',
    })
    expect(result.value.payload).toEqual({
      truckPlate: '1-ABC-123',
      expectedAt: '2026-08-25T08:00:00.000Z',
    })
  })

  it('does not mutate the instance it was given', () => {
    const instance = instanceOf()
    evaluateTransition(weighing, instance, {
      transition: 'announceTruck',
      patch: { truckPlate: '1-ABC-123' },
      actor: { roles: ['shipper'] },
      at: AT,
    })
    expect(instance.state).toBe('ORDERED')
    expect(instance.data).toEqual({ containerNumber: 'MSCU1234567', terminal: '869' })
  })

  it('expands "*" so cancel works from any non-terminal state', () => {
    for (const state of ['ORDERED', 'TRUCK_ANNOUNCED', 'WEIGHED', 'PAID']) {
      const result = evaluateTransition(weighing, instanceOf({ state }), {
        transition: 'cancel',
        patch: { cancellationReason: 'no longer needed' },
        actor: { roles: ['shipper'] },
        at: AT,
      })
      expect(result.ok, `cancel should be possible from ${state}`).toBe(true)
    }
  })
})

describe('evaluateTransition — refusals', () => {
  it('refuses an unknown transition', () => {
    const result = evaluateTransition(weighing, instanceOf(), {
      transition: 'teleport',
      actor: { roles: ['shipper'] },
      at: AT,
    })
    expect(problems(result)).toEqual([Problem.unknownTransition])
  })

  it('refuses a role that is not in `by`', () => {
    const result = evaluateTransition(weighing, instanceOf({ state: 'TRUCK_ANNOUNCED' }), {
      transition: 'weigh',
      patch: { grossMass: { value: 24000, unit: 'kg', measuredAt: AT } },
      actor: { roles: ['shipper'] },
      at: AT,
    })
    expect(problems(result)).toEqual([Problem.roleNotPermitted])
  })

  it('refuses a transition from the wrong state', () => {
    const result = evaluateTransition(weighing, instanceOf({ state: 'ORDERED' }), {
      transition: 'weigh',
      patch: { grossMass: { value: 24000, unit: 'kg', measuredAt: AT } },
      actor: { roles: ['weigher'] },
      at: AT,
    })
    expect(problems(result)).toEqual([Problem.illegalState])
  })

  it('refuses any transition once the instance is terminal', () => {
    const result = evaluateTransition(weighing, instanceOf({ state: 'VGM_ISSUED' }), {
      transition: 'cancel',
      actor: { roles: ['shipper'] },
      at: AT,
    })
    expect(problems(result)).toEqual([Problem.instanceTerminal])
  })

  it('refuses a patch that fails the transition’s patch schema', () => {
    const result = evaluateTransition(weighing, instanceOf({ state: 'TRUCK_ANNOUNCED' }), {
      transition: 'weigh',
      patch: { grossMass: { value: -1, unit: 'kg', measuredAt: AT } },
      actor: { roles: ['weigher'] },
      at: AT,
    })
    expect(problems(result)).toEqual([Problem.schemaInvalid])
  })

  it('refuses a missing required patch field', () => {
    const result = evaluateTransition(weighing, instanceOf({ state: 'TRUCK_ANNOUNCED' }), {
      transition: 'weigh',
      actor: { roles: ['weigher'] },
      at: AT,
    })
    expect(problems(result)).toEqual([Problem.schemaInvalid])
  })

  it('refuses a patch on a transition that declares none', () => {
    const result = evaluateTransition(
      transportQuotation,
      instanceOf({
        definition: 'container-transport-quotation@1.0.0',
        kind: 'quotation',
        state: 'OFFERED',
        participants: { shipper: ACME, transporter: VANMOER },
        data: {
          pickup: { location: 'Antwerp' },
          dropoff: { location: 'Ghent' },
          containerType: '40HC',
          price: { value: 320, currency: 'EUR' },
        },
      }),
      {
        transition: 'accept',
        patch: { price: { value: 1, currency: 'EUR' } },
        actor: { roles: ['shipper'] },
        at: AT,
      },
    )
    expect(problems(result)).toEqual([Problem.schemaInvalid])
  })

  it('refuses when the resulting document breaks the definition’s data schema', () => {
    // `truckPlate` is fine, but the patch also breaks `containerNumber`'s pattern.
    const result = evaluateTransition(weighing, instanceOf(), {
      transition: 'announceTruck',
      patch: { truckPlate: '1-ABC-123', containerNumber: 'not-a-container' },
      actor: { roles: ['shipper'] },
      at: AT,
    })
    expect(problems(result)).toEqual([Problem.schemaInvalid])
  })

  it('refuses when a guard does not hold after the patch', () => {
    const withoutPrice = instanceOf({
      definition: 'container-transport-quotation@1.0.0',
      kind: 'quotation',
      state: 'OFFERED',
      participants: { shipper: ACME, transporter: VANMOER },
      data: {
        pickup: { location: 'Antwerp' },
        dropoff: { location: 'Ghent' },
        containerType: '40HC',
      },
    })
    const result = evaluateTransition(transportQuotation, withoutPrice, {
      transition: 'accept',
      actor: { roles: ['shipper'] },
      at: AT,
    })
    expect(problems(result)).toEqual([Problem.guardFailed])
  })

  it('refuses when a required attachment is missing, and accepts it when present', () => {
    const paid = instanceOf({
      state: 'PAID',
      data: {
        containerNumber: 'MSCU1234567',
        terminal: '869',
        grossMass: { value: 24000, unit: 'kg', measuredAt: AT },
        paymentReference: 'PAY-1',
      },
    })
    const patch = { certificate: { sha256: 'sha256:' + 'a'.repeat(64), issuedAt: AT } }

    const missing = evaluateTransition(weighing, paid, {
      transition: 'issueVgm',
      patch,
      actor: { roles: ['weigher'] },
      at: AT,
    })
    expect(problems(missing)).toEqual([Problem.attachmentsInvalid])

    const wrongMime = evaluateTransition(weighing, paid, {
      transition: 'issueVgm',
      patch,
      attachments: [{ sha256: 'sha256:' + 'a'.repeat(64), mime: 'image/png', size: 10 }],
      actor: { roles: ['weigher'] },
      at: AT,
    })
    expect(problems(wrongMime)).toEqual([Problem.attachmentsInvalid])

    const good = evaluateTransition(weighing, paid, {
      transition: 'issueVgm',
      patch,
      attachments: [{ sha256: 'sha256:' + 'a'.repeat(64), mime: 'application/pdf', size: 41022 }],
      actor: { roles: ['weigher'] },
      at: AT,
    })
    expect(good.ok).toBe(true)
  })
})

describe('evaluateTransition — the runtime actor', () => {
  const offered = instanceOf({
    definition: 'container-transport-quotation@1.0.0',
    kind: 'quotation',
    state: 'OFFERED',
    participants: { shipper: ACME, transporter: VANMOER },
    data: { pickup: { location: 'A' }, dropoff: { location: 'B' }, containerType: '40HC' },
  })

  it('lets the runtime fire a transition nobody may fire by hand', () => {
    const result = evaluateTransition(transportQuotation, offered, {
      transition: 'expire',
      actor: { runtime: true },
      at: AT,
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.instance.state).toBe('EXPIRED')
  })

  it('refuses the same transition to a participant', () => {
    for (const roles of [['shipper'], ['transporter'], ['shipper', 'transporter']]) {
      const result = evaluateTransition(transportQuotation, offered, {
        transition: 'expire',
        actor: { roles },
        at: AT,
      })
      expect(problems(result)).toEqual([Problem.roleNotPermitted])
    }
  })

  it('still enforces the state machine for the runtime', () => {
    const result = evaluateTransition(
      transportQuotation,
      { ...offered, state: 'REQUESTED' },
      {
        transition: 'expire',
        actor: { runtime: true },
        at: AT,
      },
    )
    expect(problems(result)).toEqual([Problem.illegalState])
  })
})

describe('a transition with no `to` is a pure data update', () => {
  const notes = ProcessDefinition.parse({
    id: 'notes',
    version: '1.0.0',
    kind: 'service',
    title: 'Notes',
    roles: [{ id: 'author', title: 'Author' }],
    hostedBy: 'author',
    initialState: 'OPEN',
    states: [
      { id: 'OPEN', title: 'Open' },
      { id: 'CLOSED', title: 'Closed' },
    ],
    terminalStates: ['CLOSED'],
    data: { type: 'object', properties: { note: { type: 'string' } } },
    transitions: [
      {
        id: 'annotate',
        title: 'Annotate',
        from: ['OPEN'],
        by: ['author'],
        patch: { type: 'object', required: ['note'], properties: { note: { type: 'string' } } },
      },
      { id: 'close', title: 'Close', from: ['OPEN'], to: 'CLOSED', by: ['author'] },
    ],
  })

  it('keeps the state and records `to` as null', () => {
    const result = evaluateTransition(
      notes,
      instanceOf({
        definition: 'notes@1.0.0',
        state: 'OPEN',
        data: {},
        participants: { author: ACME },
      }),
      { transition: 'annotate', patch: { note: 'hello' }, actor: { roles: ['author'] }, at: AT },
    )
    if (!result.ok) throw new Error(JSON.stringify(result.error))
    expect(result.value.to).toBeNull()
    expect(result.value.instance.state).toBe('OPEN')
    expect(result.value.instance.data).toEqual({ note: 'hello' })
    expect(result.value.instance.seq).toBe(2)
  })
})

describe('availableTransitions — one rule, three consumers', () => {
  it('lists what this participant may fire right now, with the role that permits it', () => {
    expect(availableTransitions(weighing, instanceOf(), ['shipper'])).toEqual([
      { transition: 'announceTruck', role: 'shipper' },
      { transition: 'cancel', role: 'shipper' },
    ])
  })

  it('is empty for the party whose turn it is not', () => {
    expect(availableTransitions(weighing, instanceOf(), ['weigher'])).toEqual([
      { transition: 'cancel', role: 'weigher' },
    ])
    expect(
      availableTransitions(weighing, instanceOf({ state: 'TRUCK_ANNOUNCED' }), ['weigher']),
    ).toContainEqual({ transition: 'weigh', role: 'weigher' })
  })

  it('is empty in a terminal state', () => {
    expect(
      availableTransitions(weighing, instanceOf({ state: 'VGM_ISSUED' }), ['weigher']),
    ).toEqual([])
  })

  it('never lists a runtime-only transition', () => {
    const offered = instanceOf({
      definition: 'container-transport-quotation@1.0.0',
      state: 'OFFERED',
      participants: { shipper: ACME, transporter: VANMOER },
      data: {},
    })
    const ids = availableTransitions(transportQuotation, offered, ['shipper', 'transporter']).map(
      (a) => a.transition,
    )
    expect(ids).not.toContain('expire')
  })

  it('reports one entry per permitting role, which is what the notification envelope carries', () => {
    expect(availableTransitions(weighing, instanceOf(), ['shipper', 'weigher'])).toEqual([
      { transition: 'announceTruck', role: 'shipper' },
      { transition: 'cancel', role: 'shipper' },
      { transition: 'cancel', role: 'weigher' },
    ])
  })
})

describe('autoTransitions — what makes a standing quotation a definition concern', () => {
  it('finds the transition that fires on entry into the initial state', () => {
    const draft = instanceOf({
      definition: 'container-weighing-quotation@1.0.0',
      kind: 'quotation',
      state: 'DRAFT',
      data: { offering: 'urn:offering:x', price: { value: 45, currency: 'EUR' }, conditions: {} },
    })
    expect(autoTransitions(standingQuotation, draft).map((t) => t.id)).toEqual(['agree'])
  })

  it('finds none in a negotiated quotation', () => {
    const requested = instanceOf({
      definition: 'container-transport-quotation@1.0.0',
      kind: 'quotation',
      state: 'REQUESTED',
      participants: { shipper: ACME, transporter: VANMOER },
      data: {},
    })
    expect(autoTransitions(transportQuotation, requested)).toEqual([])
  })
})

describe('evaluateCreate', () => {
  const base = {
    id: '01J0000000000000000000000A',
    participants: { shipper: ACME, weigher: VANMOER },
    data: { containerNumber: 'MSCU1234567', terminal: '869' },
    actorDid: ACME,
    at: AT,
  }

  let created: ReturnType<typeof evaluateCreate>
  beforeEach(() => {
    created = evaluateCreate(weighing, base)
  })

  it('starts the instance in the definition’s initial state at seq 1', () => {
    if (!created.ok) throw new Error(JSON.stringify(created.error))
    expect(created.value.state).toBe('ORDERED')
    expect(created.value.seq).toBe(1)
    expect(created.value.kind).toBe('service')
    expect(created.value.definition).toBe('container-weighing@1.0.0')
    expect(created.value.createdAt).toBe(AT)
  })

  it('refuses a creator who is not a participant', () => {
    const result = evaluateCreate(weighing, { ...base, actorDid: 'did:web:stranger.example' })
    expect(problems(result as never)).toEqual([Problem.notAParticipant])
  })

  it('refuses a missing role', () => {
    const result = evaluateCreate(weighing, { ...base, participants: { shipper: ACME } })
    expect(problems(result as never)).toEqual([Problem.notAParticipant])
  })

  it('refuses a role the definition does not declare', () => {
    const result = evaluateCreate(weighing, {
      ...base,
      participants: { ...base.participants, stowaway: ACME },
    })
    expect(problems(result as never)).toEqual([Problem.notAParticipant])
  })

  it('refuses data that fails the definition’s data schema', () => {
    const result = evaluateCreate(weighing, { ...base, data: { terminal: '869' } })
    expect(problems(result as never)).toEqual([Problem.schemaInvalid])
  })
})
