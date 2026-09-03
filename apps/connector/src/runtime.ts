/**
 * Everything the connector is, assembled once.
 *
 * Built imperatively rather than through Nest's async providers, so the whole
 * runtime can be constructed in a test without an HTTP server, and so the order
 * in which secrets, the store, identity and the peer layer come up is written
 * down in one readable place instead of inferred from a dependency graph.
 *
 * That matters more at M3 than it did at M2: two connectors now stand up inside
 * a single test process, wired to each other by an in-process transport, and
 * that is only cheap because assembly is a function call with an overridable
 * transport rather than a framework lifecycle.
 */
import {
  cachingDidResolver,
  systemClock,
  toInstant,
  ulidGenerator,
  type Clock,
  type DidDocument,
  type DidResolver,
  type IdGenerator,
} from '@pilots/protocol'

import { AdminSessionService } from './auth/admin-session.service.js'
import { ApiKeyService } from './auth/api-key.service.js'
import type { ConnectorConfig } from './config/config.js'
import { ConnectionService } from './connections/connection.service.js'
import { DefinitionRegistry } from './definitions/definition-registry.js'
import { PeerDeliveryService } from './delivery/peer-delivery.service.js'
import { PeerStreamClient } from './delivery/peer-stream-client.js'
import { StreamHub } from './delivery/stream-hub.js'
import { AttachmentService } from './attachments/attachment.service.js'
import { DeadlineService } from './deadlines/deadline.service.js'
import { devDirectoryResolver, firstOf, localDidResolver } from './identity/did-directory.js'
import { LinkService } from './links/link.service.js'
import { Identity } from './identity/identity.service.js'
import { InstanceService, type WriteObserver } from './instances/instance.service.js'
import { LogService } from './logging/log.service.js'
import { SseChannel, WebhookChannel, type NotificationChannel } from './notifications/channel.js'
import { NotificationService, type WriteNotice } from './notifications/notification.service.js'
import { HttpTransport } from './peer/http-transport.js'
import { PeerClient } from './peer/peer-client.js'
import { PeerSurface } from './peer/peer.server.js'
import { Relay } from './peer/relay.js'
import { PeerReplayCache } from './peer/replay-cache.js'
import { RecoveryService } from './recovery/recovery.service.js'
import { NO_TRANSPORT, type PeerTransport } from './peer/transport.js'
import { ReplicationService } from './replication/replication.service.js'
import { FileSecretStore, MemorySecretStore, type SecretStore } from './secrets/secret-store.js'
import { FileStore } from './store/file/file-store.js'
import { MemoryStore } from './store/memory/memory-store.js'
import type { Store } from './store/store.js'

export interface Runtime {
  config: ConnectorConfig
  store: Store
  identity: Identity
  registry: DefinitionRegistry
  log: LogService
  apiKeys: ApiKeyService
  adminSessions: AdminSessionService
  instances: InstanceService
  connections: ConnectionService
  replication: ReplicationService
  notifications: NotificationService
  peerDelivery: PeerDeliveryService
  peerStreams: PeerStreamClient
  recovery: RecoveryService
  links: LinkService
  deadlines: DeadlineService
  attachments: AttachmentService
  relay: Relay
  peers: PeerSurface
  transport: PeerTransport
  resolver: DidResolver
  hub: StreamHub
  clock: Clock
  /** Present only on the boot that generated it. Logged once, never stored. */
  adminToken?: string
  /**
   * Run every delivery scan loop once.
   *
   * Exposed rather than hidden behind a timer because that is what makes
   * delivery testable: a scenario test advances the fake clock and calls this,
   * where a `setInterval` would need a real one. `main.ts` calls it on a plain
   * interval, and that is the only place a wall clock is involved.
   */
  tick(): Promise<void>
  close(): Promise<void>
}

export interface RuntimeOverrides {
  store?: Store
  secrets?: SecretStore
  clock?: Clock
  ids?: IdGenerator
  registry?: DefinitionRegistry
  /** The in-process transport in a scenario test; HTTP in a container. */
  transport?: PeerTransport
  /** A static resolver in tests; `did:web` over HTTPS in production. */
  resolver?: DidResolver
  /** Extra local-delivery channels — the in-memory collector a scenario test uses. */
  channels?: Record<string, NotificationChannel>
  /** Where the application log goes. Tests capture it; production is stdout. */
  logDestination?: NodeJS.WritableStream
}

async function openStore(config: ConnectorConfig): Promise<Store> {
  if (config.store.adapter === 'file') return FileStore.open(config.store.directory)
  if (config.store.adapter === 'mongo') {
    // Imported lazily so the small profile never loads a driver it will not use;
    // the whole point of the file store is zero infrastructure.
    const { MongoStore } = await import('./store/mongo/mongo-store.js')
    return MongoStore.open(config.store.uri, config.store.database)
  }
  return new MemoryStore()
}

/**
 * Which secret store a connector uses — and why it is **not** a function of the
 * document store.
 *
 * The signing key, the API-key pepper and the admin token hash live behind the
 * `SecretStore` port, deliberately independent of where documents go: a large
 * party moving to a managed cluster must not thereby hand it the key.
 *
 * The rule is **durability, not adapter**. Memory only where the whole process
 * is ephemeral by construction — the `memory` store, which is the test default.
 * Anything durable persists, so a restart is a restart rather than a new
 * participant: a regenerated key republishes a new DID document, and every event
 * the connector ever signed stops verifying — silently, while it looks healthy.
 *
 * Exported so that rule is a named thing with a test, rather than a ternary.
 */
export function chooseSecretStore(config: ConnectorConfig): SecretStore {
  return config.store.adapter === 'memory'
    ? new MemorySecretStore()
    : new FileSecretStore(config.secretsFile)
}

export async function createRuntime(
  config: ConnectorConfig,
  overrides: RuntimeOverrides = {},
): Promise<Runtime> {
  const store = overrides.store ?? (await openStore(config))
  const secrets = overrides.secrets ?? chooseSecretStore(config)

  const clock = overrides.clock ?? systemClock
  const now = (): string => toInstant(clock.now())
  const ids = overrides.ids ?? ulidGenerator(clock)
  const participants = (): readonly ConnectorConfig['participants'][number][] => config.participants

  // ── secrets: load what exists, generate the rest, persist what is new ──
  // The signer writes its half; the admin token is decided afterwards, because
  // it is peppered with the pepper the signer may just have generated.
  const stored = await secrets.load()
  const identity = await Identity.bootstrap(config.participants, secrets)
  const admin = AdminSessionService.create({
    storedHash: stored.adminTokenHash,
    pepper: identity.pepper,
    now,
  })
  if (admin.service.bootstrap.generated && secrets.persistable) {
    await secrets.save({ adminTokenHash: admin.tokenHash })
  }

  const registry =
    overrides.registry ?? (await DefinitionRegistry.fromDirectory(config.definitionsDir))

  const log = LogService.create({
    level: config.logLevel,
    pretty: config.environment === 'development',
    auditLog: store.audit,
    now,
    ...(overrides.logDestination === undefined ? {} : { destination: overrides.logDestination }),
  })

  const apiKeys = new ApiKeyService(store, identity.pepper, now, () => ids.next())

  // ── identity resolution ──
  const resolver = overrides.resolver ?? (await buildResolver(config, identity, store))

  // ── the peer layer ──
  const transport =
    overrides.transport ?? (config.peerTransport === 'http' ? new HttpTransport() : NO_TRANSPORT)
  const client = new PeerClient(transport, identity.asSigner(), clock, () => ids.next())
  const replay = new PeerReplayCache(clock)
  const hub = new StreamHub()

  const connections = new ConnectionService(store, client, resolver, log, now, () => ids.next())

  // ── delivery, both kinds ──
  // Two independent notions with one trigger. Peer delivery moves signed events
  // between connectors; local delivery tells our own systems something needs
  // doing. Conflating them is the single most common way this design gets
  // misread, so they are separate services that share nothing but a hook.
  const channels = new Map<string, NotificationChannel>([
    ['webhook', new WebhookChannel()],
    [
      'sse',
      new SseChannel((subscription, envelope) => {
        void hub.wake(subscription.participantId, subscription.id)
        void envelope
      }),
    ],
  ])
  for (const [name, channel] of Object.entries(overrides.channels ?? {})) {
    channels.set(name, channel)
  }

  const notifications = new NotificationService(
    store,
    registry,
    channels,
    log,
    clock,
    now,
    () => ids.next(),
    participants,
  )
  const peerDelivery = new PeerDeliveryService(
    store,
    connections,
    client,
    registry,
    hub,
    log,
    clock,
    participants,
  )

  /*
   * Assembled before `instances` because the service takes them, and `links`
   * needs `instances` back — so the observer holds a late-bound reference rather
   * than the service itself. One knot, tied here where it is visible, instead of
   * a lazy provider graph nobody can read.
   */
  const links: { service?: LinkService } = {}
  const observers: WriteObserver[] = [
    { onWrite: (notice: WriteNotice) => notifications.onWrite(notice) },
    { onWrite: (notice: WriteNotice) => peerDelivery.onWrite(notice) },
    { onWrite: async (notice: WriteNotice) => links.service?.onWrite(notice) },
  ]

  const replication = new ReplicationService(
    store,
    registry,
    resolver,
    log,
    now,
    participants,
    async (notice) => {
      for (const observer of observers) await observer.onWrite(notice)
    },
  )

  const peerStreams = new PeerStreamClient(
    store,
    connections,
    client,
    replication,
    log,
    participants,
  )

  const recovery = new RecoveryService(
    store,
    registry,
    connections,
    peerStreams,
    resolver,
    log,
    now,
  )

  const relay = new Relay(
    store,
    connections,
    client,
    replication,
    log,
    () => transport !== NO_TRANSPORT,
  )

  const instances = new InstanceService(
    store,
    registry,
    identity.asSigner(),
    now,
    () => ids.next(),
    participants,
    resolver,
    relay,
    observers,
  )

  const attachments = new AttachmentService(
    store,
    registry,
    connections,
    client,
    log,
    now,
    config.maxAttachmentBytes,
    participants,
  )

  links.service = new LinkService(store, registry, instances, log, participants)
  const deadlines = new DeadlineService(store, registry, instances, log, clock, participants)

  const peers = new PeerSurface({
    store,
    instances,
    connections,
    replication,
    delivery: peerDelivery,
    attachments,
    definitions: registry,
    resolver,
    replay,
    log,
    clock,
    participants,
    autoAccept: async (participantId, peerDid) => {
      if (config.autoAccept.includes(peerDid)) return true
      return (await store.trustedPeers.get(participantId, peerDid)) !== undefined
    },
  })

  /*
   * An API key whose value came from configuration.
   *
   * Development only — `loadConfig` refuses it under production config. The demo
   * gives a connector and its UI the same value from one gitignored `.env`, so
   * nothing is committed and `docker compose up` reaches a working screen. It is
   * audited like any other key: a credential that appears with no record of
   * where it came from is exactly what the audit log exists to prevent, and
   * "configuration did it at boot" is an answer rather than an exemption.
   */
  if (config.seedApiKey !== null) {
    const participant = config.participants[0]
    if (participant) {
      const before = await store.apiKeys.find(participant.id)
      const seeded = await apiKeys.seed(config.seedApiKey, {
        participantId: participant.id,
        label: 'co-deployed process UI',
        scopes: [
          'instances:read',
          'instances:write',
          'events:read',
          'definitions:read',
          'connections:read',
          'attachments:read',
          'attachments:write',
        ],
      })

      if (!seeded) {
        log.warn(
          {},
          'PILOTS_SEED_API_KEY is not a well-formed key (expected `ak_<26 chars>.<secret>`); ignoring it',
        )
      } else if (!before.some((key) => key.id === seeded.id)) {
        await log.record({
          level: 'warn',
          message: 'registered an API key from configuration',
          audit: {
            participantId: participant.id,
            category: 'admin',
            action: 'apiKey.create',
            actor: { kind: 'runtime', id: 'seed', actorRef: null },
            outcome: 'ok',
            subject: { apiKey: seeded.id },
            detail: 'from PILOTS_SEED_API_KEY; development only',
          },
        })
      }
    }
  }

  // ── seeded connections: a demo shortcut, never a replacement ──
  for (const seeded of config.connections) {
    const participant = config.participants.find((one) => one.id === seeded.participantId)
    if (!participant) continue
    await connections.seed(participant, {
      peerDid: seeded.peerDid,
      peerBaseUrl: seeded.peerBaseUrl,
      displayName: seeded.displayName ?? null,
      inbound: seeded.inbound,
      outbound: seeded.outbound,
    })
  }

  // ── seeded subscriptions: the same demo shortcut as connections ──
  for (const seeded of config.subscriptions) {
    const existing = await store.subscriptions.get(seeded.participantId, seeded.id)
    if (existing) continue
    await store.subscriptions.insert({
      ...seeded,
      status: 'ACTIVE',
      createdAt: now(),
      updatedAt: now(),
    })
  }

  return {
    config,
    store,
    identity,
    registry,
    log,
    apiKeys,
    adminSessions: admin.service,
    instances,
    connections,
    replication,
    notifications,
    peerDelivery,
    peerStreams,
    recovery,
    links: links.service,
    deadlines,
    attachments,
    relay,
    peers,
    transport,
    resolver,
    hub,
    clock,
    ...(admin.service.bootstrap.token === undefined
      ? {}
      : { adminToken: admin.service.bootstrap.token }),
    tick: async () => {
      // Attach first: a line that dropped since the last tick should be back up
      // before we decide anything is undelivered.
      await peerStreams.sync()
      // Deadlines before delivery, so an expiry produced this tick goes out in
      // the same tick rather than waiting for the next one.
      await deadlines.pump()
      await peerDelivery.pump()
      await notifications.pump()
      await peerStreams.quiesce()
    },
    close: async () => {
      peerStreams.closeAll()
      hub.closeAll()
      await store.close()
    },
  }
}

/**
 * Our own documents first, then whatever the deployment is configured to trust.
 *
 * Ours are served locally because they are documents we publish ourselves; a
 * connector should not fail to check its own signature because DNS is down.
 */
async function buildResolver(
  config: ConnectorConfig,
  identity: Identity,
  store: Store,
): Promise<DidResolver> {
  const local = localDidResolver(async () => {
    const documents: Record<string, DidDocument> = {}
    for (const participant of config.participants) {
      documents[participant.did] = await identity.didDocument(participant.id)
    }
    return documents
  })

  if (config.devDidDirectory) {
    // Configuration-derived identity. `loadConfig` has already refused this
    // combination under production config; see identity/did-directory.ts for
    // exactly what it gives up.
    return firstOf(
      local,
      devDirectoryResolver(async () => {
        const directory = new Map<string, string>()
        for (const seeded of config.connections) directory.set(seeded.peerDid, seeded.peerBaseUrl)
        for (const participant of config.participants) {
          for (const connection of await store.connections.find(participant.id)) {
            directory.set(connection.peerDid, connection.peerBaseUrl)
          }
        }
        return directory
      }),
    )
  }

  if (config.peerTransport === 'none') return local

  // Imported lazily so that a connector with no peers never pulls an HTTP
  // resolver stack in behind it, and so no test can reach one by accident.
  const { webDidResolver } = await import('@pilots/protocol/did-web')
  return cachingDidResolver(firstOf(local, webDidResolver({ cache: false })))
}
