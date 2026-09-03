/**
 * The log is the record — so prove the store can be thrown away.
 *
 * Two claims this repo makes constantly, tested here rather than asserted:
 *
 * - **The materialised instance is a cache.** If that is true, corrupting it
 *   must be repairable from the log alone, and corrupting the *log* must not be
 *   repairable at all.
 * - **A home node can be re-hosted.** Org B's connector loses its disk. Its
 *   key was in a secret manager rather than on that disk, so the same
 *   participant comes back on new infrastructure with an empty store — and gets
 *   its hosted processes back from the replicas of the peers it was hosting
 *   *for*, verifying every signature on the way in, including the ones it made
 *   itself.
 *
 * The second is the one that would be indefensible to check by hand: it is the
 * answer to "what happens when the host dies", and the answer has to be
 * "nothing that matters", or "the host cannot lie" is worth much less.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeEach, afterEach, describe, expect, it } from 'vitest'

import type { ServiceResult, WriteOutcome } from '../src/instances/instance.service.js'
import { ORG_A, ORG_B } from './helpers/core.js'
import { buildScenario, type Scenario } from './helpers/network.js'

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

/** S1 as far as WEIGHED: four events, two participants, one of them the host. */
async function weighedInstance(): Promise<WriteOutcome> {
  const orgA = scenario.node('org-a')
  const orgB = scenario.node('org-b')

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
  unwrap(
    await orgB.runtime.instances.applyTransition(
      orgB.caller(),
      created.instance.id,
      {
        transition: 'weigh',
        patch: { grossMass: { value: 24000, unit: 'kg', measuredAt: '2026-08-24T09:19:00.000Z' } },
      },
      2,
    ),
  )
  await scenario.settle()
  return created
}

describe('rebuilding an instance from its own log', () => {
  it('repairs a materialised instance that disagrees with the log', async () => {
    const orgB = scenario.node('org-b')
    const created = await weighedInstance()

    // Corrupt the cache, exactly the way a bad migration or a half-finished
    // write would: the document says one thing, the events say another.
    const stored = await orgB.runtime.store.instances.get(ORG_B.id, created.instance.id)
    await orgB.runtime.store.instances.replace({
      ...stored!,
      state: 'ORDERED',
      data: { ...stored!.data, containerNumber: 'WRONG0000000' },
    })

    const outcome = unwrapRecovery(await orgB.runtime.recovery.rebuild(ORG_B, created.instance.id))

    expect(outcome.repaired).toBe(true)
    expect(outcome.differences.sort()).toEqual(['data', 'state'])
    expect(outcome.verified).toBe(true)

    const after = await orgB.runtime.store.instances.get(ORG_B.id, created.instance.id)
    expect(after?.state).toBe('WEIGHED')
    expect(after?.data['containerNumber']).toBe('MSCU1234567')
    // Still the host. Home is a function of this instance's participants, and a
    // rebuild recomputes it rather than trusting what the stale document said.
    expect(after?.home).toBe(true)
  })

  it('says so, and changes nothing, when the document already matched', async () => {
    const orgB = scenario.node('org-b')
    const created = await weighedInstance()

    const outcome = unwrapRecovery(await orgB.runtime.recovery.rebuild(ORG_B, created.instance.id))
    expect(outcome.repaired).toBe(false)
    expect(outcome.differences).toEqual([])
    expect(outcome.seq).toBe(3)
    expect(outcome.state).toBe('WEIGHED')
  })
})

/**
 * The one case the memory store cannot express: somebody with disk access.
 *
 * On the file adapter — the small party's default — the log is a `.jsonl` file,
 * so tampering with it is a text edit. That makes the demo better rather than
 * worse: the guarantee was never that nobody can edit the file, it was that
 * editing it is detectable. A temp dir keeps this hermetic.
 */
describe('rebuilding refuses a log somebody edited on disk', () => {
  let directory: string
  let fileScenario: Scenario

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'pilots-recovery-'))
    fileScenario = await buildScenario({
      'org-a': { participants: [ORG_A] },
      'org-b': { participants: [ORG_B], storeDir: directory },
    })
    await fileScenario.connect('org-a', 'org-b')
  })

  afterEach(async () => {
    await fileScenario.close()
    await rm(directory, { recursive: true, force: true })
  })

  it('detects an edited payload and changes nothing', async () => {
    const orgA = fileScenario.node('org-a')

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
    await fileScenario.settle()

    // Edit the host's log with a text editor, which is all it takes.
    const path = join(directory, 'events', ORG_B.id, `${created.instance.id}.jsonl`)
    const lines = (await readFile(path, 'utf8')).trim().split('\n')
    const second = JSON.parse(lines[1]!) as { payload: Record<string, unknown> }
    second.payload['truckPlate'] = '9-XYZ-999'
    lines[1] = JSON.stringify(second)
    await writeFile(path, `${lines.join('\n')}\n`)

    // Restart it, so the edited file is what it loads.
    await fileScenario.restore('org-b')
    const restarted = fileScenario.node('org-b')

    const outcome = await restarted.runtime.recovery.rebuild(ORG_B, created.instance.id)

    // Refused, not repaired *from*. A rebuild that quietly folded an edited log
    // would launder the edit into the cache and call it recovery.
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.detail).toContain('does not verify')

    const after = await restarted.runtime.store.instances.get(ORG_B.id, created.instance.id)
    expect(after?.data['truckPlate']).toBe('1-ABC-123')

    const audit = await restarted.runtime.store.audit.read(ORG_B.id)
    expect(audit.findLast((entry) => entry.action === 'instance.rebuild')?.outcome).toBe('failed')
  })
})

describe('re-hosting: the home node comes back from its counterparty’s replica', () => {
  it('restores a hosted instance, as the home node, from a peer that only holds a replica', async () => {
    const created = await weighedInstance()
    const id = created.instance.id

    // Org B's connector loses everything but its keys and its configuration.
    await scenario.restore('org-b')
    const orgB = scenario.node('org-b')
    expect(await orgB.runtime.store.instances.get(ORG_B.id, id)).toBeUndefined()
    expect(await orgB.runtime.store.events.read(ORG_B.id, id, 0)).toHaveLength(0)

    const outcome = unwrapRecovery(await orgB.runtime.recovery.recover(ORG_B, id))

    expect(outcome.from).toBe(ORG_A.did)
    expect(outcome.applied).toBe(3)
    expect(outcome.seq).toBe(3)
    expect(outcome.state).toBe('WEIGHED')
    // The point of the whole exercise: it is the host again. Nothing was
    // re-declared, because hosting is read from the instance's participants and
    // those are inside `genesis`, which every recovered event commits to.
    expect(outcome.home).toBe(true)

    const restored = await orgB.runtime.store.instances.get(ORG_B.id, id)
    expect(restored?.home).toBe(true)
    expect(restored?.state).toBe('WEIGHED')
    expect(restored?.data['truckPlate']).toBe('1-ABC-123')
  })

  it('recovers only what the peer was entitled to see, and says how much that was', async () => {
    const created = await weighedInstance()
    const id = created.instance.id

    await scenario.restore('org-b')
    const orgB = scenario.node('org-b')
    const outcome = unwrapRecovery(await orgB.runtime.recovery.recover(ORG_B, id))

    // `grossMass` is withheld from Org A until payment, so Org A's copy of the
    // `weigh` event carries a redacted payload — and cannot un-redact it on the
    // way back. The chain still verifies, because `payloadHash` commits to the
    // payload rather than containing it.
    expect(outcome.redacted).toBeGreaterThan(0)
    const restored = await orgB.runtime.store.instances.get(ORG_B.id, id)
    expect(restored?.data['grossMass']).toBeUndefined()

    // Stated rather than glossed: this is a real limit of recovering from a
    // replica, and the honest answer is that the host lost that field with its
    // disk. What it did not lose is the ability to prove what happened.
    const rebuilt = unwrapRecovery(await orgB.runtime.recovery.rebuild(ORG_B, id))
    expect(rebuilt.verified).toBe(true)
    expect(rebuilt.state).toBe('WEIGHED')
  })

  it('carries on from where it recovered, and the peer never noticed', async () => {
    const created = await weighedInstance()
    const id = created.instance.id
    const orgA = scenario.node('org-a')

    await scenario.restore('org-b')
    const orgB = scenario.node('org-b')
    unwrapRecovery(await orgB.runtime.recovery.recover(ORG_B, id))
    await scenario.settle()

    // The rebuilt host writes seq 4, chained onto a head it recovered rather
    // than one it remembered, signs it, and replicates it onward.
    const paid = unwrap(
      await orgB.runtime.instances.applyTransition(
        orgB.caller(),
        id,
        {
          transition: 'recordPayment',
          patch: { paymentReference: 'INV-1' },
        },
        3,
      ),
    )
    await scenario.settle()

    expect(paid.instance.state).toBe('PAID')
    expect(paid.instance.seq).toBe(4)

    // And Org A accepted it — which it would not have if the chain the host
    // rebuilt from had not lined up with the one Org A kept.
    const onPeer = await orgA.runtime.store.instances.get(ORG_A.id, id)
    expect(onPeer?.state).toBe('PAID')
    expect(onPeer?.seq).toBe(4)
  })

  it('refuses when there is nobody to recover from', async () => {
    const created = await weighedInstance()

    await scenario.restore('org-b')
    const orgB = scenario.node('org-b')
    await scenario.stop('org-a')

    const outcome = await orgB.runtime.recovery.recover(ORG_B, created.instance.id)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.detail).toContain('no peer returned anything new')
  })

  it('leaves an audit trail of the recovery itself', async () => {
    const created = await weighedInstance()
    await scenario.restore('org-b')
    const orgB = scenario.node('org-b')
    unwrapRecovery(await orgB.runtime.recovery.recover(ORG_B, created.instance.id))

    const entries = await orgB.runtime.store.audit.read(ORG_B.id)
    const recovered = entries.find((entry) => entry.action === 'instance.recover')
    expect(recovered?.outcome).toBe('ok')
    expect(recovered?.detail).toContain('pulled 3 event(s)')
    // The audit log is not replicated, so the *new* machine's log starts here.
    // What it records is that this instance arrived by recovery rather than by
    // anybody doing anything.
    expect(recovered?.subject.instance).toBe(created.instance.id)
  })
})

function unwrapRecovery<T>(result: { ok: true; value: T } | { ok: false; detail: string }): T {
  if (!result.ok) throw new Error(result.detail)
  return result.value
}
