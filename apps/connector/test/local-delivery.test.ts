/**
 * Local delivery — and the participant that has no UI at all.
 *
 * This is the tier that must cover notifications, because a webhook receiver is
 * exactly the kind of external dependency that tempts people into containers.
 * Everything here runs against an in-memory channel and a fake clock, so a
 * ten-minute backoff is a function call.
 *
 * The last test in this file is the one that matters: **an automated
 * participant is a test fixture**. It subscribes to `action.required`, posts
 * back the transition the envelope names, and S1 runs with no UI and no human in
 * it at all. If that fixture ever needs a copy of the definition or a state
 * machine of its own, the design has failed at the thing it claims.
 */
import { beforeEach, afterEach, describe, expect, it } from 'vitest'

import type { NotificationEnvelope } from '@pilots/protocol'

import type { ServiceResult } from '../src/instances/instance.service.js'
import { ORG_A, ORG_B } from './helpers/core.js'
import { buildScenario, type Scenario, type ScenarioNode } from './helpers/network.js'

const PARTICIPANTS = { shipper: ORG_A.did, weigher: ORG_B.did }

let scenario: Scenario

beforeEach(async () => {
  scenario = await buildScenario({
    'org-a': { participants: [ORG_A] },
    'org-b': { participants: [ORG_B] },
  })
  await scenario.connect('org-a', 'org-b')
})

afterEach(async () => {
  await scenario.close()
})

function unwrap<T>(result: ServiceResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.errors, null, 2))
  return result.value
}

async function order(): Promise<string> {
  const orgA = scenario.node('org-a')
  const created = unwrap(
    await orgA.runtime.instances.create(orgA.caller(), {
      definition: 'container-weighing@1.0.0',
      participants: PARTICIPANTS,
      data: { containerNumber: 'MSCU1234567', terminal: '869' },
    }),
  )
  await scenario.settle()
  return created.instance.id
}

describe('action.required is computed, not configured', () => {
  it('carries the transition id and the role that permits it', async () => {
    const orgA = scenario.node('org-a')
    const orgB = scenario.node('org-b')
    await orgB.subscribe({ notify: ['action.required'] })

    const id = await order()
    unwrap(
      await orgA.runtime.instances.applyTransition(
        orgA.caller(),
        id,
        { transition: 'announceTruck', patch: { truckPlate: '1-ABC-123' } },
        1,
      ),
    )
    await scenario.settle()

    const required = orgB.channel.ofType('action.required').filter((one) => one.instance.id === id)
    const last = required.at(-1)

    expect(last?.instance.state).toBe('TRUCK_ANNOUNCED')
    // The instruction: an internal system reads this and posts it straight back.
    expect(last?.available.map((action) => action.transition)).toContain('weigh')
    expect(last?.available.find((action) => action.transition === 'weigh')?.role).toBe('weigher')
    // And the signed event travels whole, so the backoffice can verify it
    // instead of trusting its own connector.
    expect(last?.event.sig).toBeTruthy()
    expect(last?.event.header.transition).toBe('announceTruck')
  })

  it('is visibility-filtered exactly as a read would be', async () => {
    const orgA = scenario.node('org-a')
    const orgB = scenario.node('org-b')
    await orgA.subscribe({ notify: ['event'] })

    const id = await order()
    unwrap(
      await orgA.runtime.instances.applyTransition(
        orgA.caller(),
        id,
        { transition: 'announceTruck', patch: { truckPlate: '1-ABC-123' } },
        1,
      ),
    )
    await scenario.settle()
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
    await scenario.settle()

    // Org A's own backoffice must not be told something Org A could not read.
    const weighEvent = orgA.channel
      .ofType('event')
      .find((one) => one.event.header.transition === 'weigh')
    expect(weighEvent).toBeDefined()
    // Withheld in full, so the payload is `null` rather than an empty object —
    // which is what makes total withholding detectable from the header alone.
    expect(weighEvent?.event.payload).toBeNull()
    expect(weighEvent?.event.redacted).toBe(true)
  })

  it('respects a filter, and an absent key matches everything', async () => {
    const orgB = scenario.node('org-b')
    await orgB.subscribe({
      label: 'weighing-only',
      notify: ['state.changed'],
      filter: { transitions: ['weigh'] },
    })

    const id = await order()
    unwrap(
      await scenario
        .node('org-a')
        .runtime.instances.applyTransition(
          scenario.node('org-a').caller(),
          id,
          { transition: 'announceTruck', patch: { truckPlate: '1-ABC-123' } },
          1,
        ),
    )
    await scenario.settle()

    // `announceTruck` changed state, but the filter names `weigh`.
    expect(orgB.channel.received).toHaveLength(0)

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
    await scenario.settle()

    expect(orgB.channel.received).toHaveLength(1)
    expect(orgB.channel.received[0]?.envelope.event.header.transition).toBe('weigh')
  })
})

describe('delivery guarantees', () => {
  /**
   * A `DEGRADED` subscription must keep **recording**, not just stop delivering.
   *
   * The state means "delivery is failing; events accumulate and go out on
   * recovery". Recording only for `ACTIVE` drops them permanently the moment a
   * backoffice has a bad minute, and leaves the replay endpoint — which is
   * specified as authoritative — with nothing to replay. That failed silently in
   * the container demo: the automated participant did one step and stopped, with
   * no error anywhere, because the notification that should have told it to
   * continue was never written down.
   */
  it('keeps recording while degraded, and delivers the backlog on recovery', async () => {
    const orgA = scenario.node('org-a')
    const orgB = scenario.node('org-b')
    const subscriptionId = await orgB.subscribe({ notify: ['action.required'] })

    // The backoffice is down before anything happens, so the very first
    // notification fails and the subscription degrades.
    orgB.channel.failures = 99
    const id = await order()
    expect((await orgB.runtime.store.subscriptions.get(ORG_B.id, subscriptionId))?.status).toBe(
      'DEGRADED',
    )

    // The process carries on while the backoffice is unreachable.
    unwrap(
      await orgA.runtime.instances.applyTransition(
        orgA.caller(),
        id,
        { transition: 'announceTruck', patch: { truckPlate: '1-ABC-123' } },
        1,
      ),
    )
    await scenario.settle()

    // The notification for "it is your turn to weigh" exists, even though
    // nothing could be delivered.
    const recorded = await orgB.runtime.notifications.replay(ORG_B.id)
    const turns = recorded.filter((one) => one.notification === 'action.required')
    expect(
      turns.some(
        (one) =>
          (one.envelope as { instance: { state: string } }).instance.state === 'TRUCK_ANNOUNCED',
      ),
    ).toBe(true)

    // The backoffice comes back. The backlog goes out, in order, and the
    // subscription recovers on its own.
    orgB.channel.failures = 0
    scenario.clock.advance('PT1M')
    await orgB.runtime.notifications.pump()

    const delivered = orgB.channel.ofType('action.required')
    expect(delivered.map((one) => one.instance.state)).toContain('TRUCK_ANNOUNCED')
    expect((await orgB.runtime.store.subscriptions.get(ORG_B.id, subscriptionId))?.status).toBe(
      'ACTIVE',
    )
  })

  it('stops recording only when an operator pauses the subscription', async () => {
    const orgA = scenario.node('org-a')
    const orgB = scenario.node('org-b')
    const subscriptionId = await orgB.subscribe({ notify: ['action.required'] })

    const id = await order()
    const paused = await orgB.runtime.store.subscriptions.get(ORG_B.id, subscriptionId)
    await orgB.runtime.store.subscriptions.replace({ ...paused!, status: 'PAUSED' })

    const before = (await orgB.runtime.notifications.replay(ORG_B.id)).length
    unwrap(
      await orgA.runtime.instances.applyTransition(
        orgA.caller(),
        id,
        { transition: 'announceTruck', patch: { truckPlate: '1-ABC-123' } },
        1,
      ),
    )
    await scenario.settle()

    // Paused is a decision somebody made, and it is the one state where
    // dropping the notification is what was asked for.
    expect((await orgB.runtime.notifications.replay(ORG_B.id)).length).toBe(before)
  })

  it('retries with backoff, degrades, dead-letters, and replays from a cursor', async () => {
    const orgB = scenario.node('org-b')
    const subscriptionId = await orgB.subscribe({ notify: ['event'] })

    // The backoffice is down. Five attempts is the whole ladder.
    orgB.channel.failures = 99
    const id = await order()
    await orgB.runtime.notifications.pump()

    let subscription = await orgB.runtime.store.subscriptions.get(ORG_B.id, subscriptionId)
    expect(subscription?.status).toBe('DEGRADED')

    // Nothing is retried before it is due: the pump is a scan over a timestamp,
    // never a timer.
    const before = await orgB.runtime.notifications.pump()
    expect(before.failed).toBe(0)

    for (const wait of [1_000, 5_000, 30_000, 120_000, 600_000]) {
      scenario.clock.advance(wait)
      await orgB.runtime.notifications.pump()
    }

    const dead = await orgB.runtime.notifications.deadLetters(ORG_B.id)
    expect(dead.length).toBeGreaterThan(0)
    expect(dead[0]?.lastError).toContain('told to fail')

    // The business process is unaffected by any of it.
    expect((await orgB.runtime.store.instances.get(ORG_B.id, id))?.state).toBe('ORDERED')

    // `delivery.fail` is audited, because none of this produced an event.
    const audit = await orgB.runtime.store.audit.read(ORG_B.id)
    expect(audit.some((entry) => entry.action === 'delivery.fail')).toBe(true)

    // Replay is authoritative: a backoffice that was down catches up without
    // anyone deciding whether a delivery "really" happened.
    const replayed = await orgB.runtime.notifications.replay(ORG_B.id)
    expect(replayed.length).toBeGreaterThan(0)
    const after = await orgB.runtime.notifications.replay(ORG_B.id, replayed[0]!.id)
    expect(after.length).toBe(replayed.length - 1)

    // And an operator can requeue what was dead-lettered. Never automatic.
    orgB.channel.failures = 0
    expect(await orgB.runtime.notifications.retryDeadLetters(ORG_B.id)).toBe(dead.length)
    await orgB.runtime.notifications.pump()

    subscription = await orgB.runtime.store.subscriptions.get(ORG_B.id, subscriptionId)
    expect(subscription?.status).toBe('ACTIVE')
    expect(orgB.channel.received.length).toBeGreaterThan(0)
  })
})

/**
 * S1 with nobody watching.
 *
 * The fixture below is the whole claim about automated participants, so read
 * what it is allowed to know: a map from transition id to the business data its
 * own systems hold. It has no copy of the definition, no notion of what state
 * the process is in, and no rule about what may follow what. It reacts to
 * `action.required` by posting back the transition the envelope named.
 */
interface BusinessData {
  patch: Record<string, unknown>
  attachments?: { sha256: string; mime: string; size: number }[]
}

class Backoffice {
  readonly applied: string[] = []
  /** Recorded rather than ignored, so this test cannot pass by doing nothing. */
  readonly refused: string[] = []

  constructor(
    private readonly node: ScenarioNode,
    private readonly data: Record<string, BusinessData>,
  ) {}

  async react(): Promise<void> {
    for (const envelope of this.take()) {
      for (const action of envelope.available) {
        const business = this.data[action.transition]
        if (business === undefined) continue

        const result = await this.node.runtime.instances.applyTransition(
          this.node.caller(undefined, 'backoffice'),
          envelope.instance.id,
          {
            transition: action.transition,
            patch: business.patch as never,
            ...(business.attachments === undefined ? {} : { attachments: business.attachments }),
          },
          // The envelope carried the seq. No read-before-write, no state
          // machine, and `If-Match` still protects the write.
          envelope.instance.seq,
        )
        if (result.ok) this.applied.push(action.transition)
        else this.refused.push(`${action.transition}: ${result.errors[0]?.detail ?? ''}`)
        break
      }
    }
  }

  private take(): NotificationEnvelope[] {
    const envelopes = this.node.channel.ofType('action.required')
    this.node.channel.clear()
    return envelopes
  }
}

describe('an automated participant', () => {
  it('runs its whole half of S1 with no UI and no human', async () => {
    const orgA = scenario.node('org-a')
    const orgB = scenario.node('org-b')
    await orgB.subscribe({ notify: ['action.required'] })

    // Everything the backoffice knows: its own business data, keyed by the
    // transition ids it might be asked for. No definition, no states, no order.
    const certificate = `sha256:${'a'.repeat(64)}`
    const backoffice = new Backoffice(orgB, {
      weigh: {
        patch: {
          grossMass: { value: 24000, unit: 'kg', measuredAt: '2026-08-24T09:19:00.000Z' },
        },
      },
      recordPayment: { patch: { paymentReference: 'PMT-1' } },
      issueVgm: {
        patch: { certificate: { sha256: certificate, issuedAt: '2026-08-24T09:30:00.000Z' } },
        attachments: [{ sha256: certificate, mime: 'application/pdf', size: 41022 }],
      },
    })

    const id = await order()
    // Org A does the one thing that is genuinely the shipper's: it announces a
    // truck. Everything after that is Org B's, and nobody at Org B acts.
    unwrap(
      await orgA.runtime.instances.applyTransition(
        orgA.caller(),
        id,
        { transition: 'announceTruck', patch: { truckPlate: '1-ABC-123' } },
        1,
      ),
    )
    await scenario.settle()

    for (let round = 0; round < 5; round += 1) {
      await backoffice.react()
      await scenario.settle()
    }

    expect(backoffice.refused).toEqual([])
    expect(backoffice.applied).toEqual(['weigh', 'recordPayment', 'issueVgm'])
    expect((await orgB.runtime.store.instances.get(ORG_B.id, id))?.state).toBe('VGM_ISSUED')
    // And Org A's replica converged to the same terminal state, without Org A
    // knowing a machine was on the other end.
    expect((await orgA.runtime.store.instances.get(ORG_A.id, id))?.state).toBe('VGM_ISSUED')
  })
})
