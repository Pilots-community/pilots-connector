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
import { ACME, VANMOER } from './helpers/core.js'
import { buildScenario, type Scenario } from './helpers/network.js'

const PARTICIPANTS = { shipper: ACME.did, weigher: VANMOER.did }

let scenario: Scenario

beforeEach(async () => {
  scenario = await buildScenario({
    acme: { participants: [ACME] },
    vanmoer: { participants: [VANMOER] },
  })
  // Acme dials out and holds a line. It has no inbound endpoint at all, which
  // is the profile a one-truck haulier runs.
  await scenario.connect('acme', 'vanmoer', {
    fromWants: { channel: 'stream' },
    toWants: { channel: 'webhook', url: `${VANMOER.baseUrl}/api/peer/v1/deliveries` },
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
  const acme = scenario.node('acme')
  const created = unwrap(
    await acme.runtime.instances.create(acme.caller(), {
      definition: 'container-weighing@1.0.0',
      participants: PARTICIPANTS,
      data: { containerNumber: 'MSCU1234567', terminal: '869' },
    }),
  )
  unwrap(
    await acme.runtime.instances.applyTransition(
      acme.caller(),
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
    const acme = scenario.node('acme')
    const vanmoer = scenario.node('vanmoer')
    const id = await startAndAnnounce()

    expect((await acme.runtime.store.instances.get(ACME.id, id))?.seq).toBe(2)

    // Acme stops. Its line drops; Van Moer carries on regardless, which is the
    // point — one party's outage is not the process's outage.
    await scenario.stop('acme')

    unwrap(
      await vanmoer.runtime.instances.applyTransition(
        vanmoer.caller(),
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
      await vanmoer.runtime.instances.applyTransition(
        vanmoer.caller(),
        id,
        { transition: 'recordPayment', patch: { paymentReference: 'PMT-1' } },
        3,
      ),
    )
    await vanmoer.runtime.tick()

    // Acme has missed two events and knows nothing about it.
    expect((await acme.runtime.store.instances.get(ACME.id, id))?.seq).toBe(2)
    expect((await vanmoer.runtime.store.instances.get(VANMOER.id, id))?.seq).toBe(4)

    // Acme comes back. It reattaches, sends `Last-Event-ID`, receives what it
    // missed, verifies the chain, and converges. Nobody did anything.
    await scenario.start('acme')

    const caught = await acme.runtime.store.instances.get(ACME.id, id)
    expect(caught?.seq).toBe(4)
    expect(caught?.state).toBe('PAID')
    // And the field released while it was away arrived with the events.
    expect(caught?.data['grossMass']).toMatchObject({ value: 24000 })

    const events = await acme.runtime.store.events.read(ACME.id, id, 0)
    expect(events.map((event) => event.header.seq)).toEqual([1, 2, 3, 4])
  })

  it('resumes from the cursor rather than replaying everything', async () => {
    const acme = scenario.node('acme')
    const id = await startAndAnnounce()

    const connection = await acme.runtime.connections.between(ACME.id, VANMOER.did)
    // The peer's cursor, opaque to us, persisted so a restart resumes.
    expect(connection?.receiveCursor).not.toBeNull()

    await scenario.stop('acme')
    await scenario.start('acme')

    const after = await acme.runtime.connections.between(ACME.id, VANMOER.did)
    expect(after?.receiveCursor).toBe(connection?.receiveCursor)
    expect((await acme.runtime.store.events.read(ACME.id, id, 0)).length).toBe(2)
  })

  it('keeps the process running while a webhook peer is unreachable', async () => {
    const acme = scenario.node('acme')
    const vanmoer = scenario.node('vanmoer')
    const id = await startAndAnnounce()

    // The home node goes away mid-process.
    await scenario.stop('vanmoer')
    await vanmoer.runtime.tick()

    const relayed = await acme.runtime.instances.applyTransition(
      acme.caller(),
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
    expect((await acme.runtime.store.instances.get(ACME.id, id))?.seq).toBe(2)
  })
})

describe('S4b — tamper detection', () => {
  /**
   * The failure must be **hard**. Not a retry, not a resync, not a fresh copy.
   * A broken chain means the host rewrote history, and recovering from it
   * silently would delete the only evidence that it happened.
   */
  it('refuses a rewritten payload and audits it as chain.verify / failed', async () => {
    const acme = scenario.node('acme')
    const vanmoer = scenario.node('vanmoer')
    const id = await startAndAnnounce()

    // Van Moer edits an event in its own store — with the file adapter this is
    // literally editing a JSON file, which makes the demo better, not worse.
    const events = await vanmoer.runtime.store.events.read(VANMOER.id, id, 0)
    const target = events[1]!
    const tampered = {
      instance: { ...identityOf(id), createdAt: events[0]!.header.at },
      events: [
        {
          header: target.header,
          payload: { truckPlate: '9-XYZ-999' },
          redacted: false,
          sig: target.sig,
        },
      ],
    }

    const applied = await acme.runtime.replication.apply(ACME, VANMOER.did, tampered)

    expect(applied.ok).toBe(false)
    if (applied.ok) return

    const audit = await acme.runtime.store.audit.read(ACME.id)
    const entry = audit.findLast((one) => one.action === 'chain.verify')
    expect(entry?.outcome).toBe('failed')

    // And nothing was accepted: no silent resync, no partially applied history.
    const held = await acme.runtime.store.events.read(ACME.id, id, 0)
    expect(held[1]?.payload).toMatchObject({ truckPlate: '1-ABC-123' })
  })

  it('refuses an event whose header was altered, because the signature is over it', async () => {
    const acme = scenario.node('acme')
    const vanmoer = scenario.node('vanmoer')
    const id = await startAndAnnounce()

    const events = await vanmoer.runtime.store.events.read(VANMOER.id, id, 0)
    const target = events[1]!
    const rewritten = {
      instance: { ...identityOf(id), createdAt: events[0]!.header.at },
      events: [
        {
          header: { ...target.header, to: 'WEIGHED' },
          payload: target.payload,
          redacted: false,
          sig: target.sig,
        },
      ],
    }

    const applied = await acme.runtime.replication.apply(ACME, VANMOER.did, rewritten)
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
    const acme = scenario.node('acme')
    const vanmoer = scenario.node('vanmoer')
    const id = await startAndAnnounce()

    const events = await vanmoer.runtime.store.events.read(VANMOER.id, id, 0)
    // The same two participants, the same signatures, the same chain — relabelled
    // as a different process. `genesis` is what makes that detectable; the
    // participants-map variant of the same attack is proven in the protocol
    // package, where the rule lives.
    const swapped = {
      instance: {
        ...identityOf(id),
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

    const applied = await acme.runtime.replication.apply(ACME, VANMOER.did, swapped)
    expect(applied.ok).toBe(false)
    if (applied.ok) return
    expect(applied.errors[0]?.type).toContain('chain-broken')
  })

  it('refuses events for an instance we are not in', async () => {
    const acme = scenario.node('acme')
    const vanmoer = scenario.node('vanmoer')
    const id = await startAndAnnounce()
    const events = await vanmoer.runtime.store.events.read(VANMOER.id, id, 0)

    const foreign = {
      instance: {
        ...identityOf(id),
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

    const applied = await acme.runtime.replication.apply(ACME, VANMOER.did, foreign)
    expect(applied.ok).toBe(false)
    if (applied.ok) return
    expect(applied.errors[0]?.type).toContain('not-a-participant')
  })
})

function identityOf(id: string) {
  return {
    id,
    kind: 'service' as const,
    definition: 'container-weighing@1.0.0',
    participants: PARTICIPANTS,
    quotationId: null,
    offering: null,
  }
}
