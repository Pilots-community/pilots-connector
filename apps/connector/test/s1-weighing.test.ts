/**
 * S1 — the standing quotation and the container weighing, end to end.
 *
 * M2's exit criterion, as a test rather than a demo someone remembers to run.
 * One connector, no database, no counterparty node. The step numbers below are
 * the step numbers in docs/SCENARIOS.md §S1.
 */
import { Problem, verifyChain } from '@pilots/protocol'
import { beforeEach, describe, expect, it } from 'vitest'

import type { WriteOutcome, ServiceResult } from '../src/instances/instance.service.js'
import { ORG_A, ORG_B, buildCore, type TestCore } from './helpers/core.js'

const PARTICIPANTS = { shipper: ORG_A.did, weigher: ORG_B.did }
const CERTIFICATE_SHA = `sha256:${'a'.repeat(64)}`

let core: TestCore

beforeEach(async () => {
  core = await buildCore()
})

function unwrap<T>(result: ServiceResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.errors, null, 2))
  return result.value
}

async function orderWeighing(): Promise<WriteOutcome> {
  return unwrap(
    await core.instances.create(core.caller('org-a'), {
      definition: 'container-weighing@1.0.0',
      participants: PARTICIPANTS,
      data: { containerNumber: 'MSCU1234567', terminal: '869' },
    }),
  )
}

describe('S1 step 2 — the standing quotation is born agreed', () => {
  it('fires its `auto` transition on creation, with no special case in code', async () => {
    const created = unwrap(
      await core.instances.create(core.caller('org-a'), {
        definition: 'container-weighing-quotation@1.0.0',
        participants: PARTICIPANTS,
        data: {
          offering: 'urn:offering:org-b:container-weighing',
          price: { value: 45, currency: 'EUR' },
          conditions: { terminal: '869' },
        },
      }),
    )

    expect(created.instance.state).toBe('AGREED')
    // Creation is seq 1 and `agree` is seq 2: the log alone rebuilds the instance.
    expect(created.instance.seq).toBe(2)
    expect(created.events.map((e) => e.header.transition)).toEqual(['create', 'agree'])
    // The runtime fired it, and the runtime is the **home node** — Org B
    // hosts this definition. Org A could not have signed it: it did not act.
    expect(created.events[1]?.header.actor).toBe(ORG_B.did)
  })

  it('leaves a negotiated quotation waiting, because its definition says so', async () => {
    const created = unwrap(
      await core.instances.create(core.caller('org-a'), {
        definition: 'container-transport-quotation@1.0.0',
        participants: { shipper: ORG_A.did, transporter: ORG_B.did },
        data: {
          pickup: { location: 'Antwerp 869' },
          dropoff: { location: 'Ghent' },
          containerType: '40HC',
        },
      }),
    )
    expect(created.instance.state).toBe('REQUESTED')
    expect(created.instance.seq).toBe(1)
  })
})

describe('S1 steps 3–9 — the weighing runs', () => {
  it('walks the whole sequence to VGM_ISSUED', async () => {
    const ordered = await orderWeighing()
    const id = ordered.instance.id
    expect(ordered.instance.state).toBe('ORDERED')

    // Step 4 — the shipper announces the truck.
    const announced = unwrap(
      await core.instances.applyTransition(
        core.caller('org-a', 'alice@org-a.example'),
        id,
        {
          transition: 'announceTruck',
          patch: { truckPlate: '1-ABC-123', expectedAt: '2026-08-25T08:00:00.000Z' },
        },
        1,
      ),
    )
    expect(announced.instance.state).toBe('TRUCK_ANNOUNCED')

    // Step 5 — the weigher records the weighing.
    const weighed = unwrap(
      await core.instances.applyTransition(
        core.caller('org-b', 'backoffice'),
        id,
        {
          transition: 'weigh',
          patch: {
            grossMass: { value: 24000, unit: 'kg', measuredAt: '2026-08-24T09:19:00.000Z' },
          },
        },
        2,
      ),
    )
    expect(weighed.instance.state).toBe('WEIGHED')

    // Step 7 — payment.
    unwrap(
      await core.instances.applyTransition(
        core.caller('org-b'),
        id,
        { transition: 'recordPayment', patch: { paymentReference: 'PAY-2026-0042' } },
        3,
      ),
    )

    // Step 9 — the certificate, with its content-addressed attachment.
    const issued = unwrap(
      await core.instances.applyTransition(
        core.caller('org-b'),
        id,
        {
          transition: 'issueVgm',
          patch: {
            certificate: { sha256: CERTIFICATE_SHA, issuedAt: '2026-08-24T09:30:00.000Z' },
          },
          attachments: [{ sha256: CERTIFICATE_SHA, mime: 'application/pdf', size: 41022 }],
        },
        4,
      ),
    )

    expect(issued.instance.state).toBe('VGM_ISSUED')
    expect(issued.instance.seq).toBe(5)
    expect(issued.events[0]?.header.attachments).toEqual([
      { sha256: CERTIFICATE_SHA, mime: 'application/pdf', size: 41022 },
    ])
  })
})

describe('S1 steps 6 and 8 — the point of the scenario', () => {
  async function weighed(): Promise<string> {
    const ordered = await orderWeighing()
    const id = ordered.instance.id
    unwrap(
      await core.instances.applyTransition(
        core.caller('org-a'),
        id,
        { transition: 'announceTruck', patch: { truckPlate: '1-ABC-123' } },
        1,
      ),
    )
    unwrap(
      await core.instances.applyTransition(
        core.caller('org-b'),
        id,
        {
          transition: 'weigh',
          patch: {
            grossMass: { value: 24000, unit: 'kg', measuredAt: '2026-08-24T09:19:00.000Z' },
          },
        },
        2,
      ),
    )
    return id
  }

  it('withholds grossMass from the shipper in WEIGHED, and shows it to the weigher', async () => {
    const id = await weighed()

    const asShipper = await core.instances.read(core.caller('org-a'), id)
    expect(asShipper?.instance.data).not.toHaveProperty('grossMass')
    expect(asShipper?.redacted).toBe(true)

    const asWeigher = await core.instances.read(core.caller('org-b'), id)
    expect(asWeigher?.instance.data.grossMass).toEqual({
      value: 24000,
      unit: 'kg',
      measuredAt: '2026-08-24T09:19:00.000Z',
    })
  })

  it('releases it to the shipper once payment is recorded — nothing re-sent, nothing re-signed', async () => {
    const id = await weighed()
    const before = await core.instances.read(core.caller('org-a'), id)
    expect(before?.instance.data).not.toHaveProperty('grossMass')

    unwrap(
      await core.instances.applyTransition(
        core.caller('org-b'),
        id,
        { transition: 'recordPayment', patch: { paymentReference: 'PAY-1' } },
        3,
      ),
    )

    const after = await core.instances.read(core.caller('org-a'), id)
    expect(after?.instance.data.grossMass).toBeDefined()
    // …and the payment reference stays the weigher's business, always.
    expect(after?.instance.data).not.toHaveProperty('paymentReference')
  })

  it('applies the same rule to the event log the shipper replays', async () => {
    const id = await weighed()

    const beforePayment = await core.instances.events(core.caller('org-a'), id)
    const weighEvent = beforePayment?.find((e) => e.header.transition === 'weigh')
    expect(weighEvent?.redacted).toBe(true)
    // Withheld in full, so `null` rather than `{}` — see docs/PROTOCOL.md §7.3.
    expect(weighEvent?.payload).toBeNull()

    unwrap(
      await core.instances.applyTransition(
        core.caller('org-b'),
        id,
        { transition: 'recordPayment', patch: { paymentReference: 'PAY-1' } },
        3,
      ),
    )

    const afterPayment = await core.instances.events(core.caller('org-a'), id)
    const released = afterPayment?.find((e) => e.header.transition === 'weigh')
    expect(released?.redacted).toBe(false)
    expect(released?.payload).toHaveProperty('grossMass')
    // The stored event never changed: only the filter's answer did.
    expect(released?.sig).toBe(weighEvent?.sig)
  })

  it('still verifies as a chain when the shipper cannot see a payload', async () => {
    const id = await weighed()
    const asShipper = (await core.instances.events(core.caller('org-a'), id))!

    const verified = await verifyChain(asShipper, {
      resolver: core.resolver,
      definition: core.registry.require('container-weighing@1.0.0').definition,
      participants: PARTICIPANTS,
      instanceId: id,
    })

    expect(verified.failures).toEqual([])
    expect(verified.ok).toBe(true)
    expect(verified.state).toBe('WEIGHED')
    expect(verified.redacted).toBe(true)
  })
})

describe('home-node resolution is per instance', () => {
  it('marks the weigher’s copy authoritative and the shipper’s a replica', async () => {
    const ordered = await orderWeighing()

    const asWeigher = await core.instances.read(core.caller('org-b'), ordered.instance.id)
    const asShipper = await core.instances.read(core.caller('org-a'), ordered.instance.id)

    expect(asWeigher?.home).toBe(true)
    expect(asShipper?.home).toBe(false)
  })

  it('refuses an instance whose home node is nobody this connector holds', async () => {
    const result = await core.instances.create(core.caller('org-a'), {
      definition: 'container-weighing@1.0.0',
      participants: { shipper: ORG_A.did, weigher: 'did:web:someone-else.example' },
      data: { containerNumber: 'MSCU1234567', terminal: '869' },
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors[0]?.type).toBe(Problem.peerUnreachable)
      expect(result.errors[0]?.detail).toMatch(/no peer transport/)
    }
  })
})

describe('what each participant may do next', () => {
  it('computes the turn from the definition, for whichever role is ours', async () => {
    const ordered = await orderWeighing()
    const id = ordered.instance.id

    expect((await core.instances.read(core.caller('org-a'), id))?.available).toEqual([
      { transition: 'announceTruck', role: 'shipper' },
      { transition: 'cancel', role: 'shipper' },
    ])
    expect((await core.instances.read(core.caller('org-b'), id))?.available).toEqual([
      { transition: 'cancel', role: 'weigher' },
    ])

    unwrap(
      await core.instances.applyTransition(
        core.caller('org-a'),
        id,
        { transition: 'announceTruck', patch: { truckPlate: '1-ABC-123' } },
        1,
      ),
    )

    // Now it is the weigher's turn, and only the weigher's.
    expect(
      (await core.instances.read(core.caller('org-b'), id))?.available.map((a) => a.transition),
    ).toContain('weigh')
    expect(
      (await core.instances.read(core.caller('org-a'), id))?.available.map((a) => a.transition),
    ).not.toContain('weigh')
  })
})

describe('refusals', () => {
  it('refuses a transition the caller’s role may not fire', async () => {
    const ordered = await orderWeighing()
    unwrap(
      await core.instances.applyTransition(
        core.caller('org-a'),
        ordered.instance.id,
        { transition: 'announceTruck', patch: { truckPlate: '1-ABC-123' } },
        1,
      ),
    )

    const refused = await core.instances.applyTransition(
      core.caller('org-a'),
      ordered.instance.id,
      {
        transition: 'weigh',
        patch: { grossMass: { value: 1, unit: 'kg', measuredAt: '2026-08-24T09:19:00.000Z' } },
      },
      2,
    )

    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.errors[0]?.type).toBe(Problem.roleNotPermitted)

    // And no event was produced — which is exactly why the audit log exists.
    expect(await core.store.events.read('org-b', ordered.instance.id)).toHaveLength(2)
  })

  it('reports a stale If-Match as a conflict carrying the real seq', async () => {
    const ordered = await orderWeighing()
    unwrap(
      await core.instances.applyTransition(
        core.caller('org-a'),
        ordered.instance.id,
        { transition: 'announceTruck', patch: { truckPlate: '1-ABC-123' } },
        1,
      ),
    )

    const stale = await core.instances.applyTransition(
      core.caller('org-a'),
      ordered.instance.id,
      { transition: 'cancel', patch: { cancellationReason: 'changed my mind' } },
      1,
    )

    expect(stale.ok).toBe(false)
    if (!stale.ok) {
      expect(stale.conflict?.actualSeq).toBe(2)
      expect(stale.errors[0]?.type).toBe(Problem.seqConflict)
    }
  })

  it('refuses data that fails the definition’s schema at creation', async () => {
    const result = await core.instances.create(core.caller('org-a'), {
      definition: 'container-weighing@1.0.0',
      participants: PARTICIPANTS,
      data: { containerNumber: 'not-a-container-number', terminal: '869' },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors[0]?.type).toBe(Problem.schemaInvalid)
  })

  it('refuses a caller who holds no role in the instance', async () => {
    const stranger = await buildCore([
      ORG_A,
      ORG_B,
      {
        id: 'stranger',
        did: 'did:web:stranger.example',
        displayName: 'Stranger',
        baseUrl: 'https://stranger.example',
      },
    ])
    const ordered = unwrap(
      await stranger.instances.create(stranger.caller('org-a'), {
        definition: 'container-weighing@1.0.0',
        participants: PARTICIPANTS,
        data: { containerNumber: 'MSCU1234567', terminal: '869' },
      }),
    )

    // The stranger has no copy at all, so it cannot even name the instance.
    expect(
      await stranger.instances.read(stranger.caller('stranger'), ordered.instance.id),
    ).toBeUndefined()
  })
})

describe('the whole chain verifies for the home node', () => {
  it('verifies every signature, link and state transition', async () => {
    const ordered = await orderWeighing()
    const id = ordered.instance.id
    unwrap(
      await core.instances.applyTransition(
        core.caller('org-a'),
        id,
        { transition: 'announceTruck', patch: { truckPlate: '1-ABC-123' } },
        1,
      ),
    )
    unwrap(
      await core.instances.applyTransition(
        core.caller('org-b'),
        id,
        {
          transition: 'weigh',
          patch: {
            grossMass: { value: 24000, unit: 'kg', measuredAt: '2026-08-24T09:19:00.000Z' },
          },
        },
        2,
      ),
    )

    const events = (await core.instances.events(core.caller('org-b'), id))!
    const verified = await verifyChain(events, {
      resolver: core.resolver,
      definition: core.registry.require('container-weighing@1.0.0').definition,
      participants: PARTICIPANTS,
      instanceId: id,
    })

    expect(verified.failures).toEqual([])
    expect(verified.state).toBe('WEIGHED')
    expect(verified.data).toMatchObject({
      containerNumber: 'MSCU1234567',
      truckPlate: '1-ABC-123',
      grossMass: { value: 24000 },
    })
  })
})
