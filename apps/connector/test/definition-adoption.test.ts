/**
 * A process one party authored, run with a party who has never seen it.
 *
 * This is the milestone's claim as a test: **no shared definitions directory,
 * no redeploy, no operator copying a file.** Org A writes a process, publishes
 * it on its own integration surface, and starts an instance with Org B. Org B
 * has never heard of it — so its connector fetches the document from Org A,
 * checks the bytes against the hash the chain commits to, and holds the
 * delivery until an operator here says yes.
 *
 * The three things that have to be true, and are each easy to get wrong:
 *
 * - **The delivery waits rather than fails.** Nothing is broken while a person
 *   is being asked a question, so the connection must stay healthy and the
 *   audit log must not fill with one failure per retry.
 * - **The decision is about the definition, not the instance.** A second
 *   instance under the same ref must not ask again — otherwise "adopt a
 *   process" degrades into "approve every order".
 * - **A rejection stays rejected**, and says why.
 */
import { Problem, type JsonValue } from '@pilots/protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { ParticipantConfig } from '../src/config/config.js'
import { buildScenario, type Scenario, type ScenarioNode } from './helpers/network.js'

const ORG_A: ParticipantConfig = {
  id: 'org-a',
  did: 'did:web:org-a.example',
  displayName: 'Org A',
  baseUrl: 'https://org-a.example',
}
const ORG_B: ParticipantConfig = {
  id: 'org-b',
  did: 'did:web:org-b.example',
  displayName: 'Org B',
  baseUrl: 'https://org-b.example',
}

const REF = 'inspection@1.0.0'
const SELF_HOSTED_REF = 'survey@1.0.0'

/**
 * A process neither connector was shipped with.
 *
 * Deliberately nothing to do with the five committed examples: if this test
 * passed only for a definition already on disk, it would be proving nothing.
 */
function inspection(version = '1.0.0', overrides: Record<string, unknown> = {}): JsonValue {
  return {
    '@context': 'https://pilots.example/process/v1',
    id: 'inspection',
    version,
    kind: 'service' as const,
    title: 'Goods inspection',
    roles: [
      { id: 'requester', title: 'Requester', cardinality: 1, protocolRole: 'requester' },
      { id: 'inspector', title: 'Inspector', cardinality: 1, protocolRole: 'provider' },
    ],
    hostedBy: 'inspector',
    initialState: 'REQUESTED',
    states: [
      { id: 'REQUESTED', title: 'Requested' },
      { id: 'INSPECTED', title: 'Inspected', outcome: 'fulfilled' },
      { id: 'WITHDRAWN', title: 'Withdrawn', outcome: 'abandoned' },
    ],
    data: { type: 'object', properties: { reference: { type: 'string' } } },
    transitions: [
      {
        id: 'inspect',
        title: 'Record the inspection',
        from: ['REQUESTED'],
        to: 'INSPECTED',
        by: ['inspector'],
      },
      {
        id: 'withdraw',
        title: 'Withdraw',
        from: ['*'],
        to: 'WITHDRAWN',
        by: ['requester', 'inspector'],
      },
    ],
    visibility: [],
    links: [],
    ...overrides,
  }
}

/**
 * The same shape, hosted by the party that authored it.
 *
 * Which side hosts decides which path adoption runs through, and the two are
 * genuinely different: when the *peer* hosts, the create is relayed to them and
 * is refused until they accept. When *we* host, the create succeeds locally and
 * it is the delivery to them that waits.
 */
function survey(): JsonValue {
  return {
    ...(inspection() as Record<string, JsonValue>),
    id: 'survey',
    title: 'Site survey',
    hostedBy: 'requester',
  }
}

let scenario: Scenario
let a: ScenarioNode
let b: ScenarioNode

beforeEach(async () => {
  scenario = await buildScenario({
    a: { participants: [ORG_A] },
    b: { participants: [ORG_B] },
  })
  a = scenario.node('a')
  b = scenario.node('b')
  await scenario.connect('a', 'b')
})

afterEach(async () => {
  await scenario.close()
})

async function publishOnA(document: JsonValue): Promise<void> {
  const published = await a.runtime.definitions.publish('org-a', document)
  if (!published.ok) throw new Error(JSON.stringify(published.errors))
}

/** Ask A to start an instance of a definition B hosts. */
function startPeerHosted(version = '1.0.0', reference = 'REF-1') {
  return a.runtime.instances.create(a.caller(), {
    definition: `inspection@${version}`,
    participants: { requester: ORG_A.did, inspector: ORG_B.did },
    data: { reference },
  })
}

/**
 * First contact: publish, try to start, and be told to wait.
 *
 * The refusal is the *mechanism*, not a failure of it — asking B to host an
 * instance is what makes B fetch the definition and put it in front of an
 * operator. Only the home node can append seq 1, so there is nothing to create
 * until they agree.
 */
async function firstContact(version = '1.0.0'): Promise<void> {
  await publishOnA(inspection(version))
  const attempted = await startPeerHosted(version)
  expect(attempted.ok).toBe(false)
  if (attempted.ok) return
  expect(attempted.errors[0]?.type).toBe(Problem.definitionPending)
}

describe('a definition the other side has never seen', () => {
  it('is fetched from the peer and held for an operator, not refused outright', async () => {
    await firstContact()

    // B holds the document, unusable until somebody decides.
    const held = await b.runtime.store.definitions.get('org-b', REF)
    expect(held?.origin).toBe('peer')
    expect(held?.adoption?.status).toBe('pending')
    expect(held?.adoption?.peerDid).toBe(ORG_A.did)
  })

  it('checks the bytes it is given against the hash the chain commits to', async () => {
    await firstContact()

    const held = await b.runtime.store.definitions.get('org-b', REF)
    const onA = a.runtime.registry.require(REF)
    // Same document, byte for byte. Anything else and B would be running a
    // process A's instances were not signed against.
    expect(held?.contentHash).toBe(onA.contentHash)
  })

  it('starts the process once an operator accepts, with no republishing', async () => {
    await firstContact()

    const decided = await b.runtime.definitions.decide('org-b', REF, 'accepted', 'operator')
    expect(decided.ok).toBe(true)

    const created = await startPeerHosted()
    expect(created.ok).toBe(true)
    if (!created.ok) return
    await scenario.settle()

    expect(created.value.instance.state).toBe('REQUESTED')
    expect(await b.runtime.store.instances.get('org-b', created.value.instance.id)).toBeDefined()
  })

  it('does not ask again for a second instance under the same definition', async () => {
    await firstContact()
    await b.runtime.definitions.decide('org-b', REF, 'accepted', 'operator')
    await startPeerHosted('1.0.0', 'REF-1')
    await scenario.settle()

    // The decision was about the definition, so nobody is asked anything now.
    const second = await startPeerHosted('1.0.0', 'REF-2')
    expect(second.ok).toBe(true)
    await scenario.settle()

    expect(await b.runtime.definitions.pending('org-b')).toEqual([])
  })

  it('lets the adopted process run to completion, which is the point of adopting it', async () => {
    await firstContact()
    await b.runtime.definitions.decide('org-b', REF, 'accepted', 'operator')
    const created = await startPeerHosted()
    if (!created.ok) throw new Error(JSON.stringify(created.errors))
    await scenario.settle()

    // B is the inspector and the home node, so B fires the transition.
    const inspected = await b.runtime.instances.applyTransition(
      b.caller(),
      created.value.instance.id,
      { transition: 'inspect' },
      1,
    )
    if (!inspected.ok) throw new Error(JSON.stringify(inspected.errors))
    await scenario.settle()

    expect(inspected.value.instance.state).toBe('INSPECTED')
    // And A, who authored it, sees its own process finish on the other side.
    const onA = await a.runtime.store.instances.get('org-a', created.value.instance.id)
    expect(onA?.state).toBe('INSPECTED')
  })

  it('keeps refusing a definition an operator rejected, and says why', async () => {
    await firstContact()
    await b.runtime.definitions.decide(
      'org-b',
      REF,
      'rejected',
      'operator',
      'we do not run inspections for third parties',
    )

    const attempted = await startPeerHosted()
    expect(attempted.ok).toBe(false)
    if (attempted.ok) return
    expect(attempted.errors[0]?.type).toBe(Problem.definitionInvalid)
    expect(attempted.errors[0]?.detail).toContain('we do not run inspections')
  })
})

describe('when the author hosts the process, it is the delivery that waits', () => {
  /** A's own process, so the create succeeds here and B is only a replica. */
  async function startSelfHosted() {
    await publishOnA(survey())
    const created = await a.runtime.instances.create(a.caller(), {
      definition: SELF_HOSTED_REF,
      participants: { requester: ORG_A.did, inspector: ORG_B.did },
      data: { reference: 'SURVEY-1' },
    })
    if (!created.ok) throw new Error(JSON.stringify(created.errors))
    return created.value.instance.id
  }

  it('leaves the connection healthy and writes no failure to the audit log', async () => {
    const before = await a.runtime.store.audit.count('org-a')
    await startSelfHosted()
    await scenario.settle()

    /*
     * Which side records the wait depends on the channel, and that asymmetry is
     * real rather than a defect: on `stream` the receiver dialled out and is the
     * one that applies, so B learns and A is told nothing. On `webhook` the
     * sender POSTs and reads the 409, so A learns. Either way the connection
     * must stay healthy and nobody may log a failure.
     */
    const onA = (await a.runtime.store.connections.find('org-a'))[0]
    const onB = (await b.runtime.store.connections.find('org-b'))[0]
    expect(onA?.status).toBe('ACTIVE')
    expect(onB?.status).toBe('ACTIVE')
    expect([onA?.waitingOn, onB?.waitingOn]).toContain(SELF_HOSTED_REF)

    for (const [participant, since] of [
      ['org-a', before],
      ['org-b', 0],
    ] as const) {
      const node = participant === 'org-a' ? a : b
      const entries = await node.runtime.store.audit.read(participant, since, 500)
      expect(entries.filter((one) => one.action === 'delivery.fail')).toEqual([])
    }
  })

  it('delivers the replica once the peer accepts, and stops saying it is waiting', async () => {
    const instanceId = await startSelfHosted()
    await scenario.settle()
    expect(await b.runtime.store.instances.get('org-b', instanceId)).toBeUndefined()

    await b.runtime.definitions.decide('org-b', SELF_HOSTED_REF, 'accepted', 'operator')
    await scenario.settle()

    expect((await b.runtime.store.instances.get('org-b', instanceId))?.state).toBe('REQUESTED')
    expect((await b.runtime.store.connections.find('org-b'))[0]?.waitingOn).toBeNull()
  })
})

describe('a new version of a definition already accepted', () => {
  it('is diffed against the version the operator agreed to', async () => {
    await firstContact('1.0.0')
    await b.runtime.definitions.decide('org-b', REF, 'accepted', 'operator')
    await startPeerHosted('1.0.0')
    await scenario.settle()

    // 1.1.0 gives the requester the right to fire the inspection too.
    await publishOnA(
      inspection('1.1.0', {
        transitions: [
          {
            id: 'inspect',
            title: 'Record the inspection',
            from: ['REQUESTED'],
            to: 'INSPECTED',
            by: ['inspector', 'requester'],
          },
          {
            id: 'withdraw',
            title: 'Withdraw',
            from: ['*'],
            to: 'WITHDRAWN',
            by: ['requester', 'inspector'],
          },
        ],
      }),
    )
    await startPeerHosted('1.1.0', 'REF-3')
    await scenario.settle()

    const pending = await b.runtime.definitions.pending('org-b')
    expect(pending).toHaveLength(1)
    expect(pending[0]?.document.ref).toBe('inspection@1.1.0')
    // The operator is answering "what changed since the one I agreed to".
    expect(pending[0]?.diffAgainst).toBe(REF)
    expect(pending[0]?.changes.find((one) => one.id === 'inspect')?.detail).toContain('by')
  })

  it('has nothing to diff against the first time, and says so', async () => {
    await firstContact('1.0.0')

    const pending = await b.runtime.definitions.pending('org-b')
    expect(pending[0]?.diffAgainst).toBeNull()
    expect(pending[0]?.changes).toEqual([])
  })

  it('refuses the same version with different bytes, rather than diffing it', async () => {
    await publishOnA(inspection('1.0.0'))
    const again = await a.runtime.definitions.publish(
      'org-a',
      inspection('1.0.0', { title: 'Renamed' }),
    )

    // A version is an identity. Instances are pinned to it and peers adopt it
    // by hash, so changing it under the same name is never an update.
    expect(again.ok).toBe(false)
    if (again.ok) return
    expect(again.errors[0]?.type).toBe(Problem.definitionConflict)
  })
})
