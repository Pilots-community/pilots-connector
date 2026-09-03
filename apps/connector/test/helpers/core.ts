import { staticDidResolver, type DidDocument, type DidResolver } from '@pilots/protocol'
import { FakeClock, deterministicIdGenerator } from '@pilots/protocol/testing'

import type { ParticipantConfig } from '../../src/config/config.js'
import { DefinitionRegistry } from '../../src/definitions/definition-registry.js'
import { Identity } from '../../src/identity/identity.service.js'
import { InstanceService, type CallerContext } from '../../src/instances/instance.service.js'
import { MemorySecretStore } from '../../src/secrets/secret-store.js'
import { MemoryStore } from '../../src/store/memory/memory-store.js'
import type { Store } from '../../src/store/store.js'

/**
 * The five real definitions the scenarios use. Nothing here is a fixture.
 *
 * Supplied by `vitest.config.mts`, so it does not depend on which directory the
 * suite was started from.
 */
export const DEFINITIONS_DIR = process.env['PILOTS_TEST_DEFINITIONS'] ?? '../../docs/definitions'

export const ORG_A: ParticipantConfig = {
  id: 'org-a',
  did: 'did:web:org-a.example',
  displayName: 'Org A',
  baseUrl: 'https://org-a.example',
}

export const ORG_B: ParticipantConfig = {
  id: 'org-b',
  did: 'did:web:org-b.example',
  displayName: 'Org B',
  baseUrl: 'https://org-b.example',
}

export interface TestCore {
  store: Store
  identity: Identity
  registry: DefinitionRegistry
  instances: InstanceService
  clock: FakeClock
  resolver: DidResolver
  participants: ParticipantConfig[]
  caller(participantId: string, actorRef?: string): CallerContext
}

/**
 * A connector's insides without its HTTP layer.
 *
 * Two participants on one connector: that is the hosted topology, and it is what
 * makes `home: false` a real state at M2 rather than a field that is always
 * true. Memory store, fake clock, seeded ids — no network, no container, no real
 * clock.
 */
export async function buildCore(
  participants: ParticipantConfig[] = [ORG_A, ORG_B],
): Promise<TestCore> {
  const store = new MemoryStore()
  const clock = new FakeClock('2026-08-24T09:00:00.000Z')
  const ids = deterministicIdGenerator(7, clock)
  const identity = await Identity.bootstrap(participants, new MemorySecretStore())
  const registry = await DefinitionRegistry.fromDirectory(DEFINITIONS_DIR)

  const documents: Record<string, DidDocument> = {}
  for (const participant of participants) {
    documents[participant.did] = await identity.didDocument(participant.id)
  }

  const resolver = staticDidResolver(documents)
  const instances = new InstanceService(
    store,
    registry,
    identity.asSigner(),
    () => clock.instant(),
    () => ids.next(),
    () => participants,
    resolver,
  )

  return {
    store,
    identity,
    registry,
    instances,
    clock,
    resolver,
    participants,
    caller(participantId, actorRef = `someone@${participantId}.example`) {
      const participant = participants.find((p) => p.id === participantId)
      if (!participant) throw new Error(`no participant ${participantId}`)
      return { participant, actorRef }
    },
  }
}
