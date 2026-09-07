/**
 * S4a and S4b — the two demos that actually sell the architecture.
 *
 * Happy paths convince nobody. These are the two most important behaviours in
 * the whole design — "a restart loses nothing" and "the host cannot lie" — and
 * they were manual demo steps in an earlier plan, which was a mistake. They
 * should not be things a person checks by hand before a demo.
 *
 * Both run here in milliseconds, with no containers and no network.
 */
import { beforeEach, afterEach, describe, expect, it } from 'vitest'

import type { ServiceResult } from '../src/instances/instance.service.js'
import { ORG_A, ORG_B } from './helpers/core.js'
import { buildScenario, type Scenario } from './helpers/network.js'

const PARTICIPANTS = { shipper: ORG_A.did, weigher: ORG_B.did }

let scenario: Scenario

beforeEach(async () => {
  scenario = await buildScenario({
    'org-a': { participants: [ORG_A] },
    'org-b': { participants: [ORG_B] },
  })
  // Org A dials out and holds a line. It has no inbound endpoint at all, which
  // is the profile a one-truck haulier runs.
  await scenario.connect('org-a', 'org-b', {
    fromWants: { channel: 'stream' },
    toWants: { channel: 'webhook', url: `${ORG_B.baseUrl}/api/peer/v1/deliveries` },
  })
})

afterEach(async () => {
  await scenario.close()
})

function unwrap<T>(result: ServiceResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.errors, null, 2))
  return result.value
}

async function startAndAnnounce(): Promise<string> {
  const orgA = scenario.node('org-a')
  const created = unwrap(
    await orgA.runtime.instances.create(orgA.caller(), {
      definition: 'container-weighing@1.0.0',
      participants: PARTICIPANTS,
      data: { containerNumber: 'MSCU1234567', terminal: '869' },
    }),
  )
  unwrap(
    await orgA.runtime.instances.applyTransition(
      orgA.caller(),
      created.instance.id,
      { transition: 'announceTruck', patch: { truckPlate: '1-ABC-123' } },
      1,
    ),
  )
  await scenario.settle()
  return created.instance.id
}

describe('S4a — offline catch-up', () => {
  it('converges after a restart, with no operator action and no resync tool', async () => {
    const orgA = scenario.node('org-a')
    const orgB = scenario.node('org-b')
    const id = await startAndAnnounce()

    expect((await orgA.runtime.store.instances.get(ORG_A.id, id))?.seq).toBe(2)

    // Org A stops. Its line drops; Org B carries on regardless, which is the
    // point — one party's outage is not the process's outage.
    await scenario.stop('org-a')

    unwrap(
      await orgB.runtime.instances.applyTransition(
        orgB.caller(),
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
    unwrap(
      await orgB.runtime.instances.applyTransition(
        orgB.caller(),
        id,
        { transition: 'recordPayment', patch: { paymentReference: 'PMT-1' } },
        3,
      ),
    )
    await orgB.runtime.tick()

    // Org A has missed two events and knows nothing about it.
    expect((await orgA.runtime.store.instances.get(ORG_A.id, id))?.seq).toBe(2)
    expect((await orgB.runtime.store.instances.get(ORG_B.id, id))?.seq).toBe(4)

    // Org A comes back. It reattaches, sends `Last-Event-ID`, receives what it
    // missed, verifies the chain, and converges. Nobody did anything.
    await scenario.start('org-a')

    const caught = await orgA.runtime.store.instances.get(ORG_A.id, id)
    expect(caught?.seq).toBe(4)
    expect(caught?.state).toBe('PAID')
    // And the field released while it was away arrived with the events.
    expect(caught?.data['grossMass']).toMatchObject({ value: 24000 })

    const events = await orgA.runtime.store.events.read(ORG_A.id, id, 0)
    expect(events.map((event) => event.header.seq)).toEqual([1, 2, 3, 4])
  })

  it('resumes from the cursor rather than replaying everything', async () => {
    const orgA = scenario.node('org-a')
    const id = await startAndAnnounce()

    const connection = await orgA.runtime.connections.between(ORG_A.id, ORG_B.did)
    // The peer's cursor, opaque to us, persisted so a restart resumes.
    expect(connection?.receiveCursor).not.toBeNull()

    await scenario.stop('org-a')
    await scenario.start('org-a')

    const after = await orgA.runtime.connections.between(ORG_A.id, ORG_B.did)
    expect(after?.receiveCursor).toBe(connection?.receiveCursor)
    expect((await orgA.runtime.store.events.read(ORG_A.id, id, 0)).length).toBe(2)
  })

  it('keeps the process running while a webhook peer is unreachable', async () => {
    const orgA = scenario.node('org-a')
    const orgB = scenario.node('org-b')
    const id = await startAndAnnounce()

    // The home node goes away mid-process.
    await scenario.stop('org-b')
    await orgB.runtime.tick()

    const relayed = await orgA.runtime.instances.applyTransition(
      orgA.caller(),
      id,
      { transition: 'cancel', patch: { cancellationReason: 'no truck' } },
      2,
    )
    // The home node is unreachable, so the write cannot happen — but it is
    // reported as a network fault, and the instance is untouched rather than
    // half-applied.
    expect(relayed.ok).toBe(false)
    if (relayed.ok) return
    expect(relayed.errors[0]?.type).toContain('peer-unreachable')
    expect((await orgA.runtime.store.instances.get(ORG_A.id, id))?.seq).toBe(2)
  })
})

describe('S4b — tamper detection', () => {
  /**
   * The failure must be **hard**. Not a retry, not a resync, not a fresh copy.
   * A broken chain means the host rewrote history, and recovering from it
   * silently would delete the only evidence that it happened.
   */
  it('refuses a rewritten payload and audits it as chain.verify / failed', async () => {
    const orgA = scenario.node('org-a')
    const orgB = scenario.node('org-b')
    const id = await startAndAnnounce()

    // Org B edits an event in its own store — with the file adapter this is
    // literally editing a JSON file, which makes the demo better, not worse.
    const events = await orgB.runtime.store.events.read(ORG_B.id, id, 0)
    const target = events[1]!
    const tampered = {
      instance: {
        ...identityOf(id, orgA.runtime.registry.require('container-weighing@1.0.0').contentHash),
        createdAt: events[0]!.header.at,
      },
      events: [
        {
          header: target.header,
          payload: { truckPlate: '9-XYZ-999' },
          redacted: false,
          sig: target.sig,
        },
      ],
    }

    const applied = await orgA.runtime.replication.apply(ORG_A, ORG_B.did, tampered)

    expect(applied.ok).toBe(false)
    if (applied.ok) return

    const audit = await orgA.runtime.store.audit.read(ORG_A.id)
    const entry = audit.findLast((one) => one.action === 'chain.verify')
    expect(entry?.outcome).toBe('failed')

    // And nothing was accepted: no silent resync, no partially applied history.
    const held = await orgA.runtime.store.events.read(ORG_A.id, id, 0)
    expect(held[1]?.payload).toMatchObject({ truckPlate: '1-ABC-123' })
  })

  it('refuses an event whose header was altered, because the signature is over it', async () => {
    const orgA = scenario.node('org-a')
    const orgB = scenario.node('org-b')
    const id = await startAndAnnounce()

    const events = await orgB.runtime.store.events.read(ORG_B.id, id, 0)
    const target = events[1]!
    const rewritten = {
      instance: {
        ...identityOf(id, orgA.runtime.registry.require('container-weighing@1.0.0').contentHash),
        createdAt: events[0]!.header.at,
      },
      events: [
        {
          header: { ...target.header, to: 'WEIGHED' },
          payload: target.payload,
          redacted: false,
          sig: target.sig,
        },
      ],
    }

    const applied = await orgA.runtime.replication.apply(ORG_A, ORG_B.did, rewritten)
    expect(applied.ok).toBe(false)
    if (applied.ok) return
    expect(applied.errors[0]?.type).toMatch(/chain-broken|signature-invalid/)
  })

  /**
   * The gap `genesis` closes.
   *
   * A perfectly signed, perfectly chained log, presented with a participants map
   * naming somebody who was never in the instance. Before every header committed
   * to the instance's identity, a replica had nothing to check that map against
   * — and the map is precisely what authority is judged by.
   */
  it('refuses a genuine chain presented as running a different definition', async () => {
    const orgA = scenario.node('org-a')
    const orgB = scenario.node('org-b')
    const id = await startAndAnnounce()

    const events = await orgB.runtime.store.events.read(ORG_B.id, id, 0)
    // The same two participants, the same signatures, the same chain — relabelled
    // as a different process. `genesis` is what makes that detectable; the
    // participants-map variant of the same attack is proven in the protocol
    // package, where the rule lives.
    const swapped = {
      instance: {
        ...identityOf(id, orgA.runtime.registry.require('container-weighing@1.0.0').contentHash),
        createdAt: events[0]!.header.at,
        definition: 'container-weighing-quotation@1.0.0',
      },
      events: events.map((event) => ({
        header: event.header,
        payload: event.payload,
        redacted: event.redacted,
        sig: event.sig,
      })),
    }

    const applied = await orgA.runtime.replication.apply(ORG_A, ORG_B.did, swapped)
    expect(applied.ok).toBe(false)
    if (applied.ok) return
    expect(applied.errors[0]?.type).toContain('chain-broken')
  })

  it('refuses events for an instance we are not in', async () => {
    const orgA = scenario.node('org-a')
    const orgB = scenario.node('org-b')
    const id = await startAndAnnounce()
    const events = await orgB.runtime.store.events.read(ORG_B.id, id, 0)

    const foreign = {
      instance: {
        ...identityOf(id, orgA.runtime.registry.require('container-weighing@1.0.0').contentHash),
        createdAt: events[0]!.header.at,
        participants: {
          shipper: 'did:web:someone.example',
          weigher: 'did:web:interloper.example',
        },
      },
      events: [
        {
          header: events[0]!.header,
          payload: events[0]!.payload,
          redacted: false,
          sig: events[0]!.sig,
        },
      ],
    }

    const applied = await orgA.runtime.replication.apply(ORG_A, ORG_B.did, foreign)
    expect(applied.ok).toBe(false)
    if (applied.ok) return
    expect(applied.errors[0]?.type).toContain('not-a-participant')
  })
})

function identityOf(id: string, definitionHash: string) {
  return {
    id,
    kind: 'service' as const,
    definition: 'container-weighing@1.0.0',
    // The real hash, read from the registry: the genesis commits to the bytes,
    // so a stand-in here would fail the chain check for the wrong reason and
    // this test would stop testing tampering.
    definitionHash,
    participants: PARTICIPANTS,
    quotationId: null,
    offering: null,
  }
}
