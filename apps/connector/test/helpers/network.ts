/**
 * The scenario harness: several whole connectors, in one process.
 *
 * Each node here is a **real** connector — its own store, its own generated
 * keys, its own audit log, its own peer surface. They are wired together by the
 * in-process transport, so a complete two-party run is a function call and S1,
 * S4a and S5 execute in milliseconds with no HTTP, no ports and no containers.
 *
 * What is faked is deliberately only the four ports: the clock, the id
 * generator, the transport, and the notification channel. Nothing about
 * authentication, connection state, signing, verification or visibility is
 * stubbed — if it were, the scenario tier would be proving something weaker than
 * what ships, and S4d (which is entirely about refusals) would be theatre.
 *
 * Test keys are generated at setup. No private key is ever committed, including
 * as a fixture.
 */
import { type DidDocument, type DidResolver, type PeerDelivery } from '@pilots/protocol'
import { FakeClock, deterministicIdGenerator } from '@pilots/protocol/testing'

import type { ParticipantConfig } from '../../src/config/config.js'
import { loadConfig } from '../../src/config/config.js'
import type { CallerContext } from '../../src/instances/instance.service.js'
import { CollectingChannel } from '../../src/notifications/channel.js'
import { InProcessNetwork } from '../../src/peer/in-process-transport.js'
import { MemorySecretStore } from '../../src/secrets/secret-store.js'
import { createRuntime, type Runtime } from '../../src/runtime.js'
import { DEFINITIONS_DIR } from './core.js'

export interface NodeSpec {
  /** The participants this connector holds keys for. Usually one; two is the hosted profile. */
  participants: ParticipantConfig[]
  /**
   * A directory, to run this node on the **file** store instead of memory.
   *
   * Almost never wanted: the scenario tier is hermetic and the memory adapter is
   * the default for that reason. It exists for the one thing memory cannot
   * express — an operator with disk access editing the log — which is exactly
   * what a rebuild has to refuse. A temp dir is still hermetic
   * ([TESTING.md §2](../../../../docs/TESTING.md)).
   */
  storeDir?: string
}

export interface ScenarioNode {
  name: string
  runtime: Runtime
  /** The first participant, which is the only one in every scenario but S5's host. */
  participant: ParticipantConfig
  channel: CollectingChannel
  caller(participantId?: string, actorRef?: string | null): CallerContext
  /** Subscribe a notification target. Returns the subscription id. */
  subscribe(options?: {
    participantId?: string
    notify?: string[]
    filter?: Record<string, unknown>
    label?: string
  }): Promise<string>
}

export interface Scenario {
  network: InProcessNetwork
  clock: FakeClock
  nodes: Record<string, ScenarioNode>
  node(name: string): ScenarioNode
  /**
   * Run the full handshake between two nodes — request, trust checks, admin
   * accept, callback — then attach any streams. The demo may seed connections
   * from configuration; the harness never does, because S0 is the thing being
   * proven.
   */
  connect(
    from: string,
    to: string,
    delivery?: {
      fromWants?: PeerDelivery
      toWants?: PeerDelivery
      /** Which participant on each node. Connections are per participant, not per node. */
      fromParticipant?: string
      toParticipant?: string
    },
  ): Promise<void>
  /** Run every node's scan loops until nothing more moves. */
  settle(rounds?: number): Promise<void>
  /** Take a node off the network: requests to it fail, its streams drop. */
  stop(name: string): Promise<void>
  /** Put it back and let it catch up. */
  start(name: string): Promise<void>
  /**
   * Lose a node's store and bring it back on new infrastructure.
   *
   * The same participant, the same DID, the same signing key — the key was in a
   * secret manager, not on the disk that died — and an empty store. Its
   * connections come back the way a redeployed container's do: seeded from
   * configuration. Its **processes do not**, which is the situation `recover`
   * exists for.
   */
  restore(name: string): Promise<void>
  close(): Promise<void>
}

export const SCENARIO_START = '2026-08-24T09:00:00.000Z'

/**
 * Stand up a network.
 *
 * DID documents are resolved from a registry the nodes populate as they boot,
 * which is the one piece of shared state — a stand-in for `did:web` over HTTPS
 * and nothing more. Every signature is still checked against a published
 * document that the holder of the key actually generated.
 */
export async function buildScenario(specs: Record<string, NodeSpec>): Promise<Scenario> {
  const clock = new FakeClock(SCENARIO_START)
  const network = new InProcessNetwork()
  const documents: Record<string, DidDocument> = {}
  const resolver: DidResolver = { resolve: async (did) => documents[did] ?? null }

  const nodes: Record<string, ScenarioNode> = {}
  let seed = 7

  /** What a restore needs: the same keys, a fresh store, the same seat on the network. */
  const rebuildable: Record<
    string,
    { spec: NodeSpec; secrets: MemorySecretStore; channel: CollectingChannel; seed: number }
  > = {}

  for (const [name, spec] of Object.entries(specs)) {
    const channel = new CollectingChannel('webhook')
    const secrets = new MemorySecretStore()
    rebuildable[name] = { spec, secrets, channel, seed: (seed += 13) }
    const runtime = await createRuntime(
      loadConfig({
        PILOTS_PORT: '0',
        ...(spec.storeDir === undefined
          ? { PILOTS_STORE: 'memory' }
          : { PILOTS_STORE: 'file', PILOTS_STORE_DIR: spec.storeDir }),
        PILOTS_DEFINITIONS_DIR: DEFINITIONS_DIR,
        NODE_ENV: 'test',
        PILOTS_LOG_LEVEL: 'silent',
        PILOTS_PARTICIPANTS: JSON.stringify(spec.participants),
        // The scan loops are driven by `settle()`, never by a timer.
        PILOTS_DELIVERY_INTERVAL_MS: '0',
      }),
      {
        clock,
        // A distinct seed per node: two connectors must not mint the same ids,
        // or a collision would look like idempotency working.
        ids: deterministicIdGenerator(rebuildable[name].seed, clock),
        secrets,
        transport: network,
        resolver,
        channels: { webhook: channel },
        logDestination: quiet(),
      },
    )

    for (const participant of spec.participants) {
      documents[participant.did] = await runtime.identity.didDocument(participant.id)
      network.register(participant.baseUrl, runtime.peers)
    }

    const first = spec.participants[0]
    if (!first) throw new Error(`node ${name} has no participants`)

    nodes[name] = {
      name,
      runtime,
      participant: first,
      channel,
      caller(participantId = first.id, actorRef = `someone@${participantId}.example`) {
        const participant = spec.participants.find((one) => one.id === participantId)
        if (!participant) throw new Error(`node ${name} has no participant ${participantId}`)
        return { participant, actorRef }
      },
      async subscribe(options = {}) {
        const participantId = options.participantId ?? first.id
        const id = `sub-${participantId}-${await counter(runtime)}`
        await runtime.store.subscriptions.insert({
          id,
          participantId,
          label: options.label ?? `${participantId}-backoffice`,
          channel: 'webhook',
          target: { url: 'https://backoffice.example/hook', headers: {}, secretRef: null },
          notify: (options.notify ?? [
            'action.required',
            'action.cleared',
            'state.changed',
            'event',
          ]) as never,
          filter: options.filter ?? {},
          status: 'ACTIVE',
          createdAt: clock.instant(),
          updatedAt: clock.instant(),
        })
        return id
      },
    }
  }

  const scenario: Scenario = {
    network,
    clock,
    nodes,
    node(name) {
      const found = nodes[name]
      if (!found) throw new Error(`no node ${name}`)
      return found
    },

    async connect(from, to, delivery = {}) {
      const a = scenario.node(from)
      const b = scenario.node(to)
      const fromWants: PeerDelivery = delivery.fromWants ?? { channel: 'stream' }
      const toWants: PeerDelivery = delivery.toWants ?? { channel: 'stream' }

      // A connection belongs to a *participant*, not to a connector. On a
      // hosted node each tenant needs its own — one customer must not be able
      // to ride on another's trust relationship just by sharing a process.
      const aParticipant = delivery.fromParticipant
        ? a.caller(delivery.fromParticipant).participant
        : a.participant
      const bParticipant = delivery.toParticipant
        ? b.caller(delivery.toParticipant).participant
        : b.participant

      const requested = await a.runtime.connections.request(
        aParticipant,
        {
          peerDid: bParticipant.did,
          peerBaseUrl: bParticipant.baseUrl,
          displayName: bParticipant.displayName,
          delivery: fromWants,
        },
        { kind: 'adminSession', id: `${from}-operator` },
      )
      if (!requested.ok) {
        throw new Error(`connection request failed: ${requested.errors[0]?.detail}`)
      }

      // B's operator decides. Nothing is auto-accepted in the harness: the
      // handshake is what S0 proves, and seeding it would prove nothing.
      const pending = await b.runtime.connections.between(bParticipant.id, aParticipant.did)
      if (!pending) throw new Error(`${to} never received the request`)
      const accepted = await b.runtime.connections.accept(bParticipant, pending.id, toWants, {
        kind: 'adminSession',
        id: `${to}-operator`,
      })
      if (!accepted.ok) throw new Error(`accept failed: ${accepted.errors[0]?.detail}`)

      await scenario.settle()
    },

    async settle(rounds = 6) {
      // A few rounds, because one node's delivery is another's write, which can
      // produce a notification, which can produce another delivery. Bounded so a
      // loop that never converges fails the test rather than hanging it.
      for (let round = 0; round < rounds; round += 1) {
        for (const node of Object.values(nodes)) await node.runtime.tick()
      }
    },

    async stop(name) {
      const node = scenario.node(name)
      for (const participant of node.runtime.config.participants) {
        network.partition(participant.baseUrl)
      }
      // Its own outbound lines go too: a stopped process holds nothing open.
      node.runtime.peerStreams.closeAll()
      node.runtime.hub.closeAll()
    },

    async start(name) {
      const node = scenario.node(name)
      for (const participant of node.runtime.config.participants) {
        network.heal(participant.baseUrl)
      }
      await scenario.settle()
    },

    async restore(name) {
      const node = scenario.node(name)
      const parts = rebuildable[name]
      if (!parts) throw new Error(`no node ${name}`)

      // What an operator would still have after losing the store: the peers this
      // connector talks to. In the demo these come from `PILOTS_CONNECTIONS`;
      // here they are read off the dying node so the test does not have to
      // restate them. Note what is *not* carried over: instances, events, the
      // audit log.
      const seeded = (
        await Promise.all(
          parts.spec.participants.map(async (participant) =>
            (await node.runtime.connections.list(participant.id)).map((connection) => ({
              participantId: participant.id,
              peerDid: connection.peerDid,
              peerBaseUrl: connection.peerBaseUrl,
              inbound: connection.inbound,
              outbound: connection.outbound,
            })),
          ),
        )
      ).flat()

      await node.runtime.close()

      const runtime = await createRuntime(
        loadConfig({
          PILOTS_PORT: '0',
          // A restore is new infrastructure, so a new directory would be the
          // honest default; the harness keeps the spec's so a caller can choose.
          ...(parts.spec.storeDir === undefined
            ? { PILOTS_STORE: 'memory' }
            : { PILOTS_STORE: 'file', PILOTS_STORE_DIR: parts.spec.storeDir }),
          PILOTS_DEFINITIONS_DIR: DEFINITIONS_DIR,
          NODE_ENV: 'test',
          PILOTS_LOG_LEVEL: 'silent',
          PILOTS_PARTICIPANTS: JSON.stringify(parts.spec.participants),
          PILOTS_CONNECTIONS: JSON.stringify(seeded),
          PILOTS_DELIVERY_INTERVAL_MS: '0',
        }),
        {
          clock,
          ids: deterministicIdGenerator(parts.seed + 1, clock),
          // The same secret store, so the same keys: this is a new machine, not
          // a new participant. A fresh key would be a different party wearing
          // the same name, and every past signature would rightly fail.
          secrets: parts.secrets,
          transport: network,
          resolver,
          channels: { webhook: parts.channel },
          logDestination: quiet(),
        },
      )

      for (const participant of parts.spec.participants) {
        documents[participant.did] = await runtime.identity.didDocument(participant.id)
        network.register(participant.baseUrl, runtime.peers)
      }
      node.runtime = runtime
    },

    async close() {
      for (const node of Object.values(nodes)) await node.runtime.close()
    },
  }

  return scenario
}

let subscriptionCounter = 0
async function counter(_runtime: Runtime): Promise<number> {
  return (subscriptionCounter += 1)
}

/** A test run should be quiet; the application log is still produced, just not printed. */
function quiet(): NodeJS.WritableStream {
  return { write: () => true } as unknown as NodeJS.WritableStream
}
