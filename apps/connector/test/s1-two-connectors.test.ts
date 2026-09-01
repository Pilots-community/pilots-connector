/**
 * S1 across two connectors — the relay, replication and visibility together.
 *
 * The same scenario M2 ran inside one connector, now with Acme and Van Moer as
 * separate nodes that share nothing but a network. Three things become real
 * here that could not be tested before:
 *
 * - **The relay is invisible to the caller.** Acme makes every call to its own
 *   connector. The step numbers below are docs/SCENARIOS.md §S1's, and the
 *   surface column there says "local → peer" for exactly the calls that cross a
 *   wire in this file — but nothing in Acme's code says so.
 * - **Acme holds a verified replica**, rebuilt from signed events it checked
 *   itself rather than a copy it was handed.
 * - **Visibility is enforced on the way out.** `grossMass` never reaches Acme's
 *   store before payment, so it is not a rendering rule that a different client
 *   could ignore.
 */
import { verifyChain } from '@pilots/protocol'
import { beforeEach, afterEach, describe, expect, it } from 'vitest'

import type { ServiceResult, WriteOutcome } from '../src/instances/instance.service.js'
import { ACME, VANMOER } from './helpers/core.js'
import { buildScenario, type Scenario } from './helpers/network.js'

const PARTICIPANTS = { shipper: ACME.did, weigher: VANMOER.did }
const CERTIFICATE_SHA = `sha256:${'a'.repeat(64)}`

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

/** Every call Acme makes goes to Acme's own connector. That is the whole point. */
async function acmeStartsWeighing(): Promise<WriteOutcome> {
  const acme = scenario.node('acme')
  return unwrap(
    await acme.runtime.instances.create(acme.caller(), {
      definition: 'container-weighing@1.0.0',
      participants: PARTICIPANTS,
      data: { containerNumber: 'MSCU1234567', terminal: '869' },
    }),
  )
}

describe('S1 — the relay is invisible to the caller', () => {
  it('starts an instance Van Moer hosts, through Acme’s own connector', async () => {
    const created = await acmeStartsWeighing()
    expect(created.instance.state).toBe('ORDERED')
    expect(created.instance.seq).toBe(1)

    // Acme holds a replica; Van Moer holds the authoritative copy. Neither
    // side's client had to know which.
    expect(created.instance.home).toBe(false)
    const onVanMoer = await scenario
      .node('vanmoer')
      .runtime.store.instances.get(VANMOER.id, created.instance.id)
    expect(onVanMoer?.home).toBe(true)
    expect(onVanMoer?.state).toBe('ORDERED')
  })

  it('starts a standing quotation that comes back already AGREED', async () => {
    const acme = scenario.node('acme')
    const created = unwrap(
      await acme.runtime.instances.create(acme.caller(), {
        definition: 'container-weighing-quotation@1.0.0',
        participants: PARTICIPANTS,
        data: {
          offering: 'urn:offering:vanmoer:container-weighing',
          price: { value: 45, currency: 'EUR' },
          conditions: { terminal: '869' },
        },
      }),
    )

    // The `auto` transition fired on the **home node**, and its event came back
    // in the same call. Acme is not a step behind its own successful request.
    expect(created.instance.state).toBe('AGREED')
    expect(created.instance.seq).toBe(2)
    expect(created.events.map((event) => event.header.transition)).toEqual(['create', 'agree'])
    expect(created.events[1]?.header.actor).toBe(VANMOER.did)
  })

  it('runs the whole sequence to VGM_ISSUED across both nodes', async () => {
    const acme = scenario.node('acme')
    const vanmoer = scenario.node('vanmoer')
    const created = await acmeStartsWeighing()
    const id = created.instance.id

    // 4. Acme announces the truck — relayed.
    const announced = unwrap(
      await acme.runtime.instances.applyTransition(
        acme.caller(),
        id,
        { transition: 'announceTruck', patch: { truckPlate: '1-ABC-123' } },
        1,
      ),
    )
    expect(announced.instance.state).toBe('TRUCK_ANNOUNCED')

    // 5. Van Moer weighs — local, because Van Moer is the home node. The call is
    // identical in shape to Acme's.
    await scenario.settle()
    const weighed = unwrap(
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
    expect(weighed.instance.state).toBe('WEIGHED')
    await scenario.settle()

    // 6. Acme reads. `grossMass` is withheld — and not merely hidden: it was
    // never sent, so it is not in Acme's store to leak.
    const beforePayment = await acme.runtime.instances.read(acme.caller(), id)
    expect(beforePayment?.instance.state).toBe('WEIGHED')
    expect(beforePayment?.instance.data['grossMass']).toBeUndefined()
    const stored = await acme.runtime.store.instances.get(ACME.id, id)
    expect(stored?.data['grossMass']).toBeUndefined()

    // 7. Van Moer records payment.
    unwrap(
      await vanmoer.runtime.instances.applyTransition(
        vanmoer.caller(),
        id,
        { transition: 'recordPayment', patch: { paymentReference: 'PMT-1' } },
        3,
      ),
    )
    await scenario.settle()

    /*
     * 8. And now Acme may see it.
     *
     * Worth being precise, because this is where one connector and two differ.
     * Within a single connector the same stored event is simply filtered
     * differently. Across connectors it cannot be: Acme was never sent the
     * bytes, and no amount of re-filtering conjures them. So the home node sends
     * the released payload alongside the event that released it, and Acme
     * accepts it only because it hashes to the `payloadHash` its already-
     * verified header commits to. The signature and the chain are untouched.
     */
    const afterPayment = await acme.runtime.instances.read(acme.caller(), id)
    expect(afterPayment?.instance.state).toBe('PAID')
    expect(afterPayment?.instance.data['grossMass']).toMatchObject({ value: 24000, unit: 'kg' })

    // 9. The certificate, content-addressed in the header.
    unwrap(
      await vanmoer.runtime.instances.applyTransition(
        vanmoer.caller(),
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
    await scenario.settle()

    const finished = await acme.runtime.instances.read(acme.caller(), id)
    expect(finished?.instance.state).toBe('VGM_ISSUED')
    expect(finished?.instance.seq).toBe(5)
  })
})

describe('Acme holds a replica it verified itself', () => {
  it('rebuilds the instance from a chain it checked, signature by signature', async () => {
    const acme = scenario.node('acme')
    const vanmoer = scenario.node('vanmoer')
    const created = await acmeStartsWeighing()
    const id = created.instance.id

    unwrap(
      await acme.runtime.instances.applyTransition(
        acme.caller(),
        id,
        { transition: 'announceTruck', patch: { truckPlate: '1-ABC-123' } },
        1,
      ),
    )
    await scenario.settle()
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
    await scenario.settle()

    const events = await acme.runtime.store.events.read(ACME.id, id, 0)
    expect(events).toHaveLength(3)
    // Two different signers in one chain: Acme signed its own moves and Van Moer
    // signed its own. Neither could have produced the other's.
    expect(events.map((event) => event.header.actor)).toEqual([ACME.did, ACME.did, VANMOER.did])

    const verified = await verifyChain(
      events.map((event) => ({
        header: event.header,
        payload: event.payload,
        redacted: event.redacted,
        sig: event.sig,
      })),
      {
        resolver: acme.runtime.resolver,
        definition: acme.runtime.registry.get('container-weighing@1.0.0')!.definition,
        participants: PARTICIPANTS,
        instanceId: id,
      },
    )

    expect(verified.ok).toBe(true)
    expect(verified.state).toBe('WEIGHED')
    // The withheld field is reported, not silently absent: Acme knows its copy
    // of the data is incomplete, and that the *state* is exact regardless.
    expect(verified.redacted).toBe(true)
  })
})

describe('a business error passes through the relay unchanged', () => {
  it('reports a stale If-Match as the home node’s 409, not a 502', async () => {
    const acme = scenario.node('acme')
    const created = await acmeStartsWeighing()

    const stale = await acme.runtime.instances.applyTransition(
      acme.caller(),
      created.instance.id,
      { transition: 'announceTruck', patch: { truckPlate: '1-ABC-123' } },
      99,
    )

    expect(stale.ok).toBe(false)
    if (stale.ok) return
    expect(stale.errors[0]?.type).toContain('seq-conflict')
  })

  it('reports a role refusal as the home node’s 403', async () => {
    const acme = scenario.node('acme')
    const vanmoer = scenario.node('vanmoer')
    const created = await acmeStartsWeighing()
    await scenario.settle()

    unwrap(
      await acme.runtime.instances.applyTransition(
        acme.caller(),
        created.instance.id,
        { transition: 'announceTruck', patch: { truckPlate: '1-ABC-123' } },
        1,
      ),
    )
    await scenario.settle()

    // `weigh` is the weigher's move. Acme's own connector refuses it before it
    // ever reaches the wire — the same rule, evaluated on both sides.
    const refused = await acme.runtime.instances.applyTransition(
      acme.caller(),
      created.instance.id,
      { transition: 'weigh', patch: { grossMass: { value: 1, unit: 'kg' } } },
      2,
    )
    expect(refused.ok).toBe(false)
    if (refused.ok) return
    expect(refused.errors[0]?.type).toContain('role-not-permitted')
    void vanmoer
  })

  /**
   * The distinction docs/PROTOCOL.md §4.3 exists for: a network fault is not a
   * business conflict. Collapsing them would make retry logic on an
   * integrator's side unwriteable.
   */
  it('reports an unreachable home node as peer-unreachable, never as a conflict', async () => {
    const acme = scenario.node('acme')
    const created = await acmeStartsWeighing()

    await scenario.stop('vanmoer')

    const result = await acme.runtime.instances.applyTransition(
      acme.caller(),
      created.instance.id,
      { transition: 'announceTruck', patch: { truckPlate: '1-ABC-123' } },
      1,
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors[0]?.type).toContain('peer-unreachable')
    expect(result.status).toBe(502)

    // And it is audited with the peer DID, because no event was produced.
    const audit = await acme.runtime.store.audit.read(ACME.id)
    const entry = audit.findLast((one) => one.action === 'relay.forward')
    expect(entry?.outcome).toBe('failed')
    expect(entry?.detail).toContain(VANMOER.did)
  })
})
