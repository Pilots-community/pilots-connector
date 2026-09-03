/**
 * One connector, several participants — the fully-hosted topology.
 *
 * A provider runs one process holding keys for two customers who do business
 * with each other, and with an outside peer. From each customer's side this is
 * **zero self-run containers**, which is the deployment claim; from the code's
 * side it is the case where "every document carries `participantId`" stops being
 * tidiness and starts being load-bearing.
 *
 * Three things only this shape can break, and none of them needs a container to
 * prove:
 *
 * - **A write touches two local copies at once**, exactly one of which is
 *   authoritative. Get that wrong and a provider's customers silently share a
 *   row.
 * - **A read must not see across tenants.** Two participants in one process is
 *   where a forgotten `participantId` filter would leak, and it would leak
 *   quietly.
 * - **Hosting is still resolved per instance.** The provider hosts one side of
 *   one instance and neither side of another; caching that answer anywhere would
 *   pass every other test in the suite.
 */
import { beforeEach, afterEach, describe, expect, it } from 'vitest'

import type { ParticipantConfig } from '../src/config/config.js'
import type { ServiceResult } from '../src/instances/instance.service.js'
import { VANMOER } from './helpers/core.js'
import { buildScenario, type Scenario } from './helpers/network.js'

/** Two customers of one hosting provider. Separate participants, one process. */
const TENANT_A: ParticipantConfig = {
  id: 'tenant-a',
  did: 'did:web:connectors.example:t:tenant-a',
  displayName: 'Northbound Freight',
  baseUrl: 'https://connectors.example',
}
const TENANT_B: ParticipantConfig = {
  id: 'tenant-b',
  did: 'did:web:connectors.example:t:tenant-b',
  displayName: 'Dockside Weighing',
  baseUrl: 'https://connectors.example',
}

let scenario: Scenario

beforeEach(async () => {
  scenario = await buildScenario({
    // One node, two participants: that is what "hosted" means here.
    provider: { participants: [TENANT_A, TENANT_B] },
    vanmoer: { participants: [VANMOER] },
  })
})

afterEach(async () => {
  await scenario.close()
})

function unwrap<T>(result: ServiceResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.errors, null, 2))
  return result.value
}

const WEIGHING = 'container-weighing@1.0.0'

describe('two tenants on one connector', () => {
  it('writes both copies of an instance they share, with exactly one authoritative', async () => {
    const provider = scenario.node('provider')

    // A hosts the shipper role, B the weigher. Both are this provider's.
    const created = unwrap(
      await provider.runtime.instances.create(provider.caller('tenant-a'), {
        definition: WEIGHING,
        participants: { shipper: TENANT_A.did, weigher: TENANT_B.did },
        data: { containerNumber: 'MSCU1234567', terminal: '869' },
      }),
    )

    const forA = await provider.runtime.store.instances.get(TENANT_A.id, created.instance.id)
    const forB = await provider.runtime.store.instances.get(TENANT_B.id, created.instance.id)

    // Two documents, not one shared row. A provider's customers must not be
    // able to observe each other by accident of co-location.
    expect(forA).toBeDefined()
    expect(forB).toBeDefined()
    expect(forA?.participantId).toBe(TENANT_A.id)
    expect(forB?.participantId).toBe(TENANT_B.id)

    // `hostedBy: weigher`, so B is the home node and A holds a replica —
    // resolved from this instance's participants, in one process, where a
    // shortcut would be invisible.
    expect(forB?.home).toBe(true)
    expect(forA?.home).toBe(false)

    // And each has its own log, not a pointer into somebody else's.
    expect(
      await provider.runtime.store.events.read(TENANT_A.id, created.instance.id, 0),
    ).toHaveLength(1)
    expect(
      await provider.runtime.store.events.read(TENANT_B.id, created.instance.id, 0),
    ).toHaveLength(1)
  })

  it('advances between tenants without a network, and both copies agree', async () => {
    const provider = scenario.node('provider')
    const created = unwrap(
      await provider.runtime.instances.create(provider.caller('tenant-a'), {
        definition: WEIGHING,
        participants: { shipper: TENANT_A.did, weigher: TENANT_B.did },
        data: { containerNumber: 'MSCU1234567', terminal: '869' },
      }),
    )
    const id = created.instance.id

    unwrap(
      await provider.runtime.instances.applyTransition(
        provider.caller('tenant-a'),
        id,
        { transition: 'announceTruck', patch: { truckPlate: '1-ABC-123' } },
        1,
      ),
    )
    unwrap(
      await provider.runtime.instances.applyTransition(
        provider.caller('tenant-b'),
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

    expect((await provider.runtime.store.instances.get(TENANT_A.id, id))?.state).toBe('WEIGHED')
    expect((await provider.runtime.store.instances.get(TENANT_B.id, id))?.state).toBe('WEIGHED')

    // Visibility holds between co-located tenants exactly as between strangers.
    // Sharing a process is not a reason to share a field.
    const asShipper = await provider.runtime.instances.read(provider.caller('tenant-a'), id)
    const asWeigher = await provider.runtime.instances.read(provider.caller('tenant-b'), id)
    expect(asShipper?.instance.data['grossMass']).toBeUndefined()
    expect(asWeigher?.instance.data['grossMass']).toMatchObject({ value: 24000 })
  })

  it('never lets one tenant read the other’s instances', async () => {
    const provider = scenario.node('provider')

    // An instance only B takes part in — with an outside peer, so A has no
    // business with it at all. Note whose connection this is: B's. A's
    // relationship with Van Moer, if any, is a different record.
    await scenario.connect('provider', 'vanmoer', { fromParticipant: 'tenant-b' })
    const shared = unwrap(
      await provider.runtime.instances.create(provider.caller('tenant-b'), {
        definition: WEIGHING,
        participants: { shipper: TENANT_B.did, weigher: VANMOER.did },
        data: { containerNumber: 'MSCU7654321', terminal: '869' },
      }),
    )
    await scenario.settle()

    const asA = await provider.runtime.instances.list(provider.caller('tenant-a'))
    const asB = await provider.runtime.instances.list(provider.caller('tenant-b'))

    expect(asB.map((one) => one.instance.id)).toContain(shared.instance.id)
    // Not filtered out of a list it was in — never in it. The read is scoped by
    // participant at the store, not tidied up afterwards.
    expect(asA.map((one) => one.instance.id)).not.toContain(shared.instance.id)
    expect(
      await provider.runtime.instances.read(provider.caller('tenant-a'), shared.instance.id),
    ).toBeUndefined()
  })

  it('gives each tenant its own connection, so one cannot ride on another’s', async () => {
    const provider = scenario.node('provider')
    await scenario.connect('provider', 'vanmoer', { fromParticipant: 'tenant-b' })

    // B connected. A did not, and sharing a process does not change that.
    expect(await provider.runtime.connections.between(TENANT_B.id, VANMOER.did)).toBeDefined()
    expect(await provider.runtime.connections.between(TENANT_A.id, VANMOER.did)).toBeUndefined()

    const refused = await provider.runtime.instances.create(provider.caller('tenant-a'), {
      definition: WEIGHING,
      participants: { shipper: TENANT_A.did, weigher: VANMOER.did },
      data: { containerNumber: 'MSCU3333333', terminal: '869' },
    })
    expect(refused.ok).toBe(false)
    if (refused.ok) return
    expect(refused.errors[0]?.type).toContain('connection-not-active')
  })

  it('resolves hosting per instance, even for two instances of one definition', async () => {
    const provider = scenario.node('provider')
    await scenario.connect('provider', 'vanmoer', { fromParticipant: 'tenant-a' })

    // B is the weigher here, so the provider hosts it.
    const hosted = unwrap(
      await provider.runtime.instances.create(provider.caller('tenant-a'), {
        definition: WEIGHING,
        participants: { shipper: TENANT_A.did, weigher: TENANT_B.did },
        data: { containerNumber: 'MSCU1111111', terminal: '869' },
      }),
    )

    // Van Moer is the weigher here, so the provider hosts neither side —
    // same definition, same process, opposite answer.
    const external = unwrap(
      await provider.runtime.instances.create(provider.caller('tenant-a'), {
        definition: WEIGHING,
        participants: { shipper: TENANT_A.did, weigher: VANMOER.did },
        data: { containerNumber: 'MSCU2222222', terminal: '869' },
      }),
    )
    await scenario.settle()

    expect(
      (await provider.runtime.store.instances.get(TENANT_B.id, hosted.instance.id))?.home,
    ).toBe(true)
    expect(
      (await provider.runtime.store.instances.get(TENANT_A.id, external.instance.id))?.home,
    ).toBe(false)
    expect(
      (await scenario.node('vanmoer').runtime.store.instances.get(VANMOER.id, external.instance.id))
        ?.home,
    ).toBe(true)
  })

  it('keeps each tenant’s audit log separate and separately verifiable', async () => {
    const provider = scenario.node('provider')
    unwrap(
      await provider.runtime.instances.create(provider.caller('tenant-a'), {
        definition: WEIGHING,
        participants: { shipper: TENANT_A.did, weigher: TENANT_B.did },
        data: { containerNumber: 'MSCU1234567', terminal: '869' },
      }),
    )

    const { verifyAuditChain } = await import('@pilots/protocol')
    for (const tenant of [TENANT_A, TENANT_B]) {
      const entries = await provider.runtime.store.audit.read(tenant.id)
      // Each chain starts at 1 and is its own: a provider hands a customer
      // their audit log, not a filtered view of everybody's.
      expect(verifyAuditChain(entries).ok).toBe(true)
      if (entries.length > 0) expect(entries[0]?.seq).toBe(1)
      expect(entries.every((entry) => entry.participantId === tenant.id)).toBe(true)
    }
  })
})
