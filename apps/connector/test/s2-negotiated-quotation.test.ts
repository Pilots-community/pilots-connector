/**
 * S2 — negotiated quotation and the transport it authorises.
 *
 * M4's exit criterion. What it proves that S1 could not:
 *
 * - **Quotation and service are one primitive.** Two instances of two
 *   definitions, running side by side, on the same engine with no second code
 *   path for "a negotiation".
 * - **The quotation does not block execution.** The service instance is real
 *   and addressable from step 2, sitting in `PENDING_CONTRACT` while the price
 *   is still being argued about. It simply cannot advance yet.
 * - **`links` advance one instance from a signed event in another**, and the
 *   resulting event names the event that caused it.
 * - **A deadline fires a transition no participant may invoke by hand** — by
 *   advancing a fake clock, not by shortening the duration and waiting.
 */
import { headerHash } from '@pilots/protocol'
import { beforeEach, afterEach, describe, expect, it } from 'vitest'

import type { ServiceResult } from '../src/instances/instance.service.js'
import { ACME, VANMOER } from './helpers/core.js'
import { buildScenario, type Scenario } from './helpers/network.js'

const PARTICIPANTS = { shipper: ACME.did, transporter: VANMOER.did }
const QUOTATION = 'container-transport-quotation@1.0.0'
const SERVICE = 'container-transport@1.0.0'

let scenario: Scenario

beforeEach(async () => {
  scenario = await buildScenario({
    acme: { participants: [ACME] },
    vanmoer: { participants: [VANMOER] },
  })
  await scenario.connect('acme', 'vanmoer')
})

afterEach(async () => {
  await scenario.close()
})

function unwrap<T>(result: ServiceResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.errors, null, 2))
  return result.value
}

/** Steps 1–2: both instances exist, and only one of them can move. */
async function requestTransport(): Promise<{ quotation: string; service: string }> {
  const acme = scenario.node('acme')

  const quotation = unwrap(
    await acme.runtime.instances.create(acme.caller(), {
      definition: QUOTATION,
      participants: PARTICIPANTS,
      data: {
        pickup: { location: 'Antwerp 869' },
        dropoff: { location: 'Ghent' },
        containerType: '40HC',
      },
    }),
  )

  const service = unwrap(
    await acme.runtime.instances.create(acme.caller(), {
      definition: SERVICE,
      participants: PARTICIPANTS,
      quotationId: quotation.instance.id,
      data: { containerType: '40HC' },
    }),
  )

  await scenario.settle()
  return { quotation: quotation.instance.id, service: service.instance.id }
}

describe('S2 — the quotation runs without blocking the service', () => {
  it('creates the service instance up front, waiting on the contract', async () => {
    const acme = scenario.node('acme')
    const { quotation, service } = await requestTransport()

    const q = await acme.runtime.instances.read(acme.caller(), quotation)
    const s = await acme.runtime.instances.read(acme.caller(), service)

    expect(q?.instance.state).toBe('REQUESTED')
    // Real and addressable from the moment it is created, not conjured later.
    expect(s?.instance.state).toBe('PENDING_CONTRACT')
    expect(s?.instance.quotationId).toBe(quotation)

    // And genuinely unable to advance: `startExecution` is `by: []`, so it is
    // not merely hidden from the UI, it is refused.
    const forced = await acme.runtime.instances.applyTransition(
      acme.caller(),
      service,
      { transition: 'startExecution', patch: null },
      1,
    )
    expect(forced.ok).toBe(false)
    if (forced.ok) return
    expect(forced.errors[0]?.type).toContain('role-not-permitted')
  })

  it('runs the counter-offer loop and links the agreement to the service', async () => {
    const acme = scenario.node('acme')
    const vanmoer = scenario.node('vanmoer')
    const { quotation, service } = await requestTransport()

    // 3. Van Moer quotes.
    unwrap(
      await vanmoer.runtime.instances.applyTransition(
        vanmoer.caller(),
        quotation,
        { transition: 'offer', patch: { price: { value: 320, currency: 'EUR' } } },
        1,
      ),
    )
    await scenario.settle()

    // 4. Acme counters — relayed, because Van Moer hosts the quotation too.
    unwrap(
      await acme.runtime.instances.applyTransition(
        acme.caller(),
        quotation,
        { transition: 'counter', patch: { notes: 'that window is too early' } },
        2,
      ),
    )
    await scenario.settle()

    // 5. Van Moer quotes again.
    unwrap(
      await vanmoer.runtime.instances.applyTransition(
        vanmoer.caller(),
        quotation,
        { transition: 'offer', patch: { price: { value: 355, currency: 'EUR' } } },
        3,
      ),
    )
    await scenario.settle()

    // 6. Acme accepts.
    const accepted = unwrap(
      await acme.runtime.instances.applyTransition(
        acme.caller(),
        quotation,
        { transition: 'accept', patch: null },
        4,
      ),
    )
    expect(accepted.instance.state).toBe('AGREED')
    await scenario.settle()

    // 7. The link fired. Nobody clicked anything, and no client knew the rule.
    const contracted = await vanmoer.runtime.store.instances.get(VANMOER.id, service)
    expect(contracted?.state).toBe('CONTRACTED')

    const events = await vanmoer.runtime.store.events.read(VANMOER.id, service, 0)
    const started = events.find((event) => event.header.transition === 'startExecution')
    expect(started).toBeDefined()
    // `by: []`, so the home node is the actor — the runtime that fired it.
    expect(started?.header.actor).toBe(VANMOER.did)

    /*
     * And it names what justified it.
     *
     * Without `cause`, a transition no participant may invoke is one the host
     * simply asserts. With it, Acme can take the hash, find that event in the
     * quotation it holds, and check the claim rather than trusting it.
     */
    const quotationEvents = await acme.runtime.store.events.read(ACME.id, quotation, 0)
    const acceptEvent = quotationEvents.find((event) => event.header.transition === 'accept')
    expect(started?.header.cause).toBe(headerHash(acceptEvent!.header))

    // Acme's replica of the service agrees, having verified the chain itself.
    const onAcme = await acme.runtime.store.instances.get(ACME.id, service)
    expect(onAcme?.state).toBe('CONTRACTED')
  })

  it('carries the transport through to delivery, releasing the driver’s name on pickup', async () => {
    const acme = scenario.node('acme')
    const vanmoer = scenario.node('vanmoer')
    const { quotation, service } = await requestTransport()

    unwrap(
      await vanmoer.runtime.instances.applyTransition(
        vanmoer.caller(),
        quotation,
        { transition: 'offer', patch: { price: { value: 320, currency: 'EUR' } } },
        1,
      ),
    )
    await scenario.settle()
    unwrap(
      await acme.runtime.instances.applyTransition(
        acme.caller(),
        quotation,
        { transition: 'accept', patch: null },
        2,
      ),
    )
    await scenario.settle()

    // 8. Assign a driver.
    unwrap(
      await vanmoer.runtime.instances.applyTransition(
        vanmoer.caller(),
        service,
        {
          transition: 'assign',
          patch: {
            vehiclePlate: '1-ABC-123',
            driverName: 'Jan Peeters',
            plannedPickupAt: '2026-08-25T08:00:00.000Z',
          },
        },
        2,
      ),
    )
    await scenario.settle()

    // 9. The shipper may not see who is driving. Not hidden — never sent.
    const assigned = await acme.runtime.instances.read(acme.caller(), service)
    expect(assigned?.instance.state).toBe('ASSIGNED')
    expect(assigned?.instance.data['driverName']).toBeUndefined()
    expect(
      (await acme.runtime.store.instances.get(ACME.id, service))?.data['driverName'],
    ).toBeUndefined()

    // 10. On pickup the grant matches, and the value arrives with the event
    // that released it.
    unwrap(
      await vanmoer.runtime.instances.applyTransition(
        vanmoer.caller(),
        service,
        {
          transition: 'pickup',
          patch: {
            actualPickupAt: '2026-08-25T08:12:00.000Z',
            containerNumber: 'MSCU1234567',
          },
        },
        3,
      ),
    )
    await scenario.settle()

    const pickedUp = await acme.runtime.instances.read(acme.caller(), service)
    expect(pickedUp?.instance.state).toBe('PICKED_UP')
    expect(pickedUp?.instance.data['driverName']).toBe('Jan Peeters')
  })
})

describe('S2 — concurrency through the relay', () => {
  it('answers a stale If-Match with the home node’s 409, carrying the real seq', async () => {
    const acme = scenario.node('acme')
    const vanmoer = scenario.node('vanmoer')
    const { quotation } = await requestTransport()

    unwrap(
      await vanmoer.runtime.instances.applyTransition(
        vanmoer.caller(),
        quotation,
        { transition: 'offer', patch: { price: { value: 320, currency: 'EUR' } } },
        1,
      ),
    )
    await scenario.settle()

    const first = await acme.runtime.instances.applyTransition(
      acme.caller(),
      quotation,
      { transition: 'counter', patch: { notes: 'too early' } },
      2,
    )
    expect(first.ok).toBe(true)
    await scenario.settle()

    // The same If-Match again. Acme's own replica has moved on, so this is
    // refused before it reaches the wire — same rule, evaluated on both sides.
    const second = await acme.runtime.instances.applyTransition(
      acme.caller(),
      quotation,
      { transition: 'counter', patch: { notes: 'still too early' } },
      2,
    )
    expect(second.ok).toBe(false)
    if (second.ok) return
    expect(second.errors[0]?.type).toContain('seq-conflict')
    expect(second.conflict?.actualSeq).toBe(3)
    // A conflict, never a 502: a stale write is a business outcome, and an
    // integrator has to be able to tell it from a network fault.
    expect(second.status).toBeUndefined()
  })
})

describe('S2 — the deadline path', () => {
  /**
   * An offer left unanswered past `PT24H`.
   *
   * `expire` is `by: []` — a transition no participant can invoke by hand. In a
   * container demo this would be a day's wait or a shortened duration and a
   * hope; here it is one call on a fake clock, which is the whole reason timers
   * are a scan loop over stored state rather than `setTimeout`.
   */
  it('expires an unanswered offer, and only once the clock has actually passed it', async () => {
    const acme = scenario.node('acme')
    const vanmoer = scenario.node('vanmoer')
    const { quotation, service } = await requestTransport()

    unwrap(
      await vanmoer.runtime.instances.applyTransition(
        vanmoer.caller(),
        quotation,
        { transition: 'offer', patch: { price: { value: 320, currency: 'EUR' } } },
        1,
      ),
    )
    await scenario.settle()

    // Not yet. A deadline that fires early is worse than one that fires late.
    scenario.clock.advance('PT23H')
    expect(await vanmoer.runtime.deadlines.pump()).toEqual([])
    expect((await vanmoer.runtime.store.instances.get(VANMOER.id, quotation))?.state).toBe(
      'OFFERED',
    )

    scenario.clock.advance('PT2H')
    const fired = await vanmoer.runtime.deadlines.pump()
    expect(fired).toEqual([{ instanceId: quotation, transition: 'expire', from: 'OFFERED' }])
    await scenario.settle()

    const expired = await vanmoer.runtime.store.instances.get(VANMOER.id, quotation)
    expect(expired?.state).toBe('EXPIRED')

    const events = await vanmoer.runtime.store.events.read(VANMOER.id, quotation, 0)
    const expiry = events.findLast((event) => event.header.transition === 'expire')
    expect(expiry?.header.actor).toBe(VANMOER.did)
    // Nothing signed the passing of time, so there is nothing to point at. What
    // a counterparty checks instead is the arithmetic — it holds the same log.
    expect(expiry?.header.cause).toBeNull()

    // And the service instance was cancelled by the link, not left dangling.
    expect((await vanmoer.runtime.store.instances.get(VANMOER.id, service))?.state).toBe(
      'CANCELLED',
    )
    expect((await acme.runtime.store.instances.get(ACME.id, service))?.state).toBe('CANCELLED')
  })

  it('does not fire a deadline on a replica, only on the home node', async () => {
    const acme = scenario.node('acme')
    const vanmoer = scenario.node('vanmoer')
    const { quotation } = await requestTransport()

    unwrap(
      await vanmoer.runtime.instances.applyTransition(
        vanmoer.caller(),
        quotation,
        { transition: 'offer', patch: { price: { value: 320, currency: 'EUR' } } },
        1,
      ),
    )
    await scenario.settle()
    scenario.clock.advance('PT25H')

    // Acme holds a replica and sees the same deadline pass. It must not act:
    // a replica firing its own runtime transitions would fork the chain, and
    // the fork would be signed.
    expect(await acme.runtime.deadlines.pump()).toEqual([])
    expect((await acme.runtime.store.instances.get(ACME.id, quotation))?.state).toBe('OFFERED')

    expect((await vanmoer.runtime.deadlines.pump()).length).toBe(1)
  })
})
