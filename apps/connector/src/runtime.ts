/**
 * Everything the connector is, assembled once.
 *
 * Built imperatively rather than through Nest's async providers, so the whole
 * runtime can be constructed in a test without an HTTP server, and so the order
 * in which secrets, the store and the registry come up is written down in one
 * readable place instead of inferred from a dependency graph.
 */
import {
  systemClock,
  toInstant,
  ulidGenerator,
  type Clock,
  type IdGenerator,
} from '@pilots/protocol'

import { AdminSessionService } from './auth/admin-session.service.js'
import { ApiKeyService } from './auth/api-key.service.js'
import type { ConnectorConfig } from './config/config.js'
import { DefinitionRegistry } from './definitions/definition-registry.js'
import { Identity } from './identity/identity.service.js'
import { InstanceService } from './instances/instance.service.js'
import { LogService } from './logging/log.service.js'
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
  clock: Clock
  /** Present only on the boot that generated it. Logged once, never stored. */
  adminToken?: string
  close(): Promise<void>
}

export interface RuntimeOverrides {
  store?: Store
  secrets?: SecretStore
  clock?: Clock
  ids?: IdGenerator
  registry?: DefinitionRegistry
  /** Where the application log goes. Tests capture it; production is stdout. */
  logDestination?: NodeJS.WritableStream
}

async function openStore(config: ConnectorConfig): Promise<Store> {
  return config.store.adapter === 'file'
    ? FileStore.open(config.store.directory)
    : new MemoryStore()
}

export async function createRuntime(
  config: ConnectorConfig,
  overrides: RuntimeOverrides = {},
): Promise<Runtime> {
  const store = overrides.store ?? (await openStore(config))
  const secrets =
    overrides.secrets ??
    (config.store.adapter === 'file'
      ? new FileSecretStore(config.secretsFile)
      : new MemorySecretStore())

  const clock = overrides.clock ?? systemClock
  const now = (): string => toInstant(clock.now())
  const ids = overrides.ids ?? ulidGenerator(clock)

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
  const instances = new InstanceService(
    store,
    registry,
    identity.asSigner(),
    now,
    () => ids.next(),
    () => config.participants,
  )

  return {
    config,
    store,
    identity,
    registry,
    log,
    apiKeys,
    adminSessions: admin.service,
    instances,
    clock,
    ...(admin.service.bootstrap.token === undefined
      ? {}
      : { adminToken: admin.service.bootstrap.token }),
    close: () => store.close(),
  }
}
