/**
 * S5 — a participant is both supplier and consumer, at the same time.
 *
 * **Scenario test only, never part of the container demo.** The demo runs one
 * direction, so a per-definition hosting shortcut would pass every container
 * run and every happy path. Only a test that stands up two instances of *one*
 * definition with opposite participants catches it — and that test is impossible
 * to write cheaply unless two connectors can run in one process, which is why
 * the harness exists at all.
 *
 * ```
 *   Freight forwarder ──── requests transport ────▶ Transporter A
 *                                                         │  subcontracts
 *                                                         ▼
 *                                                   Transporter B
 * ```
 *
 * The two assertions that are the whole point:
 *
 * - **Instance 1 vs instance 2.** One definition, two instances, two different
 *   home nodes. An implementation that resolves hosting per definition — or
 *   caches "we host container-transport" — fails only here.
 * - **`action.required` in both directions.** The same subscription serves A as
 *   provider and A as requester, because it is computed from *our roles in that
 *   instance*. Needing a per-role subscription would mean a participant type has
 *   leaked into the design.
 */
import { beforeEach, afterEach, describe, expect, it } from 'vitest'

import type { ParticipantConfig } from '../src/config/config.js'
import type { ServiceResult } from '../src/instances/instance.service.js'
import { buildScenario, type Scenario } from './helpers/network.js'

const FORWARDER: ParticipantConfig = {
  id: 'forwarder',
  did: 'did:web:forwarder.example',
  displayName: 'Global Freight',
  baseUrl: 'https://forwarder.example',
}
const TRANSPORTER_A: ParticipantConfig = {
  id: 'transporter-a',
  did: 'did:web:transporter-a.example',
  displayName: 'Transporter A',
  baseUrl: 'https://transporter-a.example',
}
const TRANSPORTER_B: ParticipantConfig = {
  id: 'transporter-b',
  did: 'did:web:transporter-b.example',
  displayName: 'Transporter B',
  baseUrl: 'https://transporter-b.example',
}

const DEFINITION = 'container-transport@1.0.0'

let scenario: Scenario

beforeEach(async () => {
  scenario = await buildScenario({
    ff: { participants: [FORWARDER] },
    a: { participants: [TRANSPORTER_A] },
    b: { participants: [TRANSPORTER_B] },
  })
  // One connection between each pair, carrying both directions. There is no
  // supplier connection and no consumer connection.
  await scenario.connect('ff', 'a')
  await scenario.connect('a', 'b')
})

afterEach(async () => {
  await scenario.close()
})

function unwrap<T>(result: ServiceResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.errors, null, 2))
  return result.value
}

describe('S5 — supplier and consumer are per-instance roles', () => {
  it('resolves the home node per instance, not per definition', async () => {
    const ff = scenario.node('ff')
    const a = scenario.node('a')

    // 3. FF starts instance 1 — A is the transporter, so **A** is the home node.
    const first = unwrap(
      await ff.runtime.instances.create(ff.caller(), {
        definition: DEFINITION,
        participants: { shipper: FORWARDER.did, transporter: TRANSPORTER_A.did },
        data: { containerType: '40HC' },
      }),
    )

    // 4. A starts instance 2 of the **same definition** — B is the transporter,
    // so **B** is the home node and A holds a replica of its own subcontract.
    const second = unwrap(
      await a.runtime.instances.create(a.caller(), {
        definition: DEFINITION,
        participants: { shipper: TRANSPORTER_A.did, transporter: TRANSPORTER_B.did },
        data: { containerType: '40HC' },
      }),
    )
    await scenario.settle()

    // 5. A's list holds both, one authoritative and one a replica.
    const held = await a.runtime.instances.list(a.caller())
    const byId = new Map(held.map((view) => [view.instance.id, view]))
    expect(byId.size).toBe(2)

    expect(byId.get(first.instance.id)?.home).toBe(true)
    expect(byId.get(second.instance.id)?.home).toBe(false)

    // The same definition, in both. A connector that cached "we host
    // container-transport" would have got one of these wrong.
    expect(byId.get(first.instance.id)?.instance.definition).toBe(DEFINITION)
    expect(byId.get(second.instance.id)?.instance.definition).toBe(DEFINITION)

    // And the counterparties agree about who is authoritative.
    expect((await ff.runtime.store.instances.get(FORWARDER.id, first.instance.id))?.home).toBe(
      false,
    )
    expect(
      (await scenario.node('b').runtime.store.instances.get(TRANSPORTER_B.id, second.instance.id))
        ?.home,
    ).toBe(true)
  })

  it('fires action.required for both of A’s roles, from one subscription', async () => {
    const ff = scenario.node('ff')
    const a = scenario.node('a')
    const b = scenario.node('b')

    // One subscription. No per-role configuration anywhere.
    await a.subscribe({ notify: ['action.required', 'action.cleared'] })

    const asProvider = unwrap(
      await ff.runtime.instances.create(ff.caller(), {
        definition: DEFINITION,
        participants: { shipper: FORWARDER.did, transporter: TRANSPORTER_A.did },
        data: { containerType: '40HC' },
      }),
    )
    const asRequester = unwrap(
      await a.runtime.instances.create(a.caller(), {
        definition: DEFINITION,
        participants: { shipper: TRANSPORTER_A.did, transporter: TRANSPORTER_B.did },
        data: { containerType: '40HC' },
      }),
    )
    await scenario.settle()

    const required = a.channel.ofType('action.required')
    const forFirst = required.find((one) => one.instance.id === asProvider.instance.id)
    const forSecond = required.find((one) => one.instance.id === asRequester.instance.id)

    /*
     * Steps 6 and 7, and the whole point of the test.
     *
     * Both notifications came from the **same** subscription, and neither
     * needed configuring. What differs is the `role` each carries, because
     * `available` is computed from A's roles *in that instance*: transporter in
     * the one it hosts, shipper in the one it subcontracted. If this needed a
     * per-role subscription, a participant type would have leaked into the
     * design.
     */
    expect(forFirst?.available.map((action) => action.role)).toEqual(['transporter'])
    expect(forSecond?.available.map((action) => action.role)).toEqual(['shipper'])

    // 8. A advances both. One write is local and authoritative; the other
    // relays to B. The local API call is identical in shape.
    unwrap(
      await a.runtime.instances.applyTransition(
        a.caller(),
        asProvider.instance.id,
        { transition: 'cancel', patch: { cancellationReason: 'customer withdrew' } },
        1,
      ),
    )
    unwrap(
      await a.runtime.instances.applyTransition(
        a.caller(),
        asRequester.instance.id,
        { transition: 'cancel', patch: { cancellationReason: 'no longer needed' } },
        1,
      ),
    )
    await scenario.settle()

    expect(
      (await a.runtime.store.instances.get(TRANSPORTER_A.id, asProvider.instance.id))?.state,
    ).toBe('CANCELLED')
    expect(
      (await b.runtime.store.instances.get(TRANSPORTER_B.id, asRequester.instance.id))?.state,
    ).toBe('CANCELLED')

    // And once both are terminal there is nothing left for A to do, from the
    // same subscription — so a work queue drains instead of growing forever.
    const cleared = a.channel.ofType('action.cleared').map((one) => one.instance.id)
    expect(cleared).toContain(asProvider.instance.id)
    expect(cleared).toContain(asRequester.instance.id)
  })

  it('verifies both chains — one it signed, one it only checked', async () => {
    const ff = scenario.node('ff')
    const a = scenario.node('a')

    const asProvider = unwrap(
      await ff.runtime.instances.create(ff.caller(), {
        definition: DEFINITION,
        participants: { shipper: FORWARDER.did, transporter: TRANSPORTER_A.did },
        data: { containerType: '40HC' },
      }),
    )
    const asRequester = unwrap(
      await a.runtime.instances.create(a.caller(), {
        definition: DEFINITION,
        participants: { shipper: TRANSPORTER_A.did, transporter: TRANSPORTER_B.did },
        data: { containerType: '40HC' },
      }),
    )
    await scenario.settle()

    const { verifyChain } = await import('@pilots/protocol')
    const definition = a.runtime.registry.get(DEFINITION)!.definition

    for (const [id, participants] of [
      [asProvider.instance.id, { shipper: FORWARDER.did, transporter: TRANSPORTER_A.did }],
      [asRequester.instance.id, { shipper: TRANSPORTER_A.did, transporter: TRANSPORTER_B.did }],
    ] as const) {
      const events = await a.runtime.store.events.read(TRANSPORTER_A.id, id, 0)
      expect(events.length).toBeGreaterThan(0)
      const verified = await verifyChain(
        events.map((event) => ({
          header: event.header,
          payload: event.payload,
          redacted: event.redacted,
          sig: event.sig,
        })),
        { resolver: a.runtime.resolver, definition, participants, instanceId: id },
      )
      expect(verified.ok).toBe(true)
    }
  })

  it('lets A publish an offering and withdraw it without touching a running process', async () => {
    const ff = scenario.node('ff')
    const a = scenario.node('a')

    // 1–2. Publishing is what makes a participant a supplier: a runtime record,
    // no restart, no build flag, no deployment mode.
    await a.runtime.store.offerings.insert({
      id: 'urn:offering:a:container-transport',
      participantId: TRANSPORTER_A.id,
      title: 'Container transport',
      quotationDefinition: 'container-transport-quotation@1.0.0',
      serviceDefinition: DEFINITION,
      price: null,
      conditions: {},
      status: 'PUBLISHED',
      createdAt: scenario.clock.instant(),
      updatedAt: scenario.clock.instant(),
    })

    const running = unwrap(
      await ff.runtime.instances.create(ff.caller(), {
        definition: DEFINITION,
        participants: { shipper: FORWARDER.did, transporter: TRANSPORTER_A.did },
        data: { containerType: '40HC' },
      }),
    )
    await scenario.settle()

    // 10. Withdrawing stops discovery. It does not stop a process.
    const offering = await a.runtime.store.offerings.get(
      TRANSPORTER_A.id,
      'urn:offering:a:container-transport',
    )
    await a.runtime.store.offerings.replace({ ...offering!, status: 'WITHDRAWN' })

    const advanced = await a.runtime.instances.applyTransition(
      a.caller(),
      running.instance.id,
      { transition: 'cancel', patch: { cancellationReason: 'customer withdrew' } },
      1,
    )
    expect(advanced.ok).toBe(true)
  })
})
