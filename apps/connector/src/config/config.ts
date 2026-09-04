/**
 * Configuration, validated at boot.
 *
 * Two rules shape this file:
 *
 * 1. **Configuration holds a *list* of participants**, never one. The demo runs
 *    one participant per connector; the code does not assume it, and that is
 *    what makes the hosted topologies possible without a rewrite.
 * 2. **No secret has a default and no secret is ever committed.** What is not
 *    supplied is *generated* on first boot and written to the secret store, so
 *    "no key in the repository" is structurally true rather than a rule someone
 *    has to remember. See `secrets/`.
 */
import { z } from 'zod'

import {
  Did,
  NotificationChannelName,
  NotificationType,
  PeerDelivery,
  SubscriptionFilter,
  WebhookTarget,
} from '@pilots/protocol'

export const ParticipantConfig = z.strictObject({
  /** Local id, used as `participantId` on every document this participant owns. */
  id: z.string().min(1).max(64),
  did: Did,
  displayName: z.string().min(1).max(255),
  /** Where peers reach this participant. Also what its `did:web` document must resolve to. */
  baseUrl: z.url(),
})
export type ParticipantConfig = z.infer<typeof ParticipantConfig>

export const StoreConfig = z.discriminatedUnion('adapter', [
  z.strictObject({ adapter: z.literal('memory') }),
  z.strictObject({ adapter: z.literal('file'), directory: z.string().min(1) }),
  /** The large-party profile. Needs a replica set; the adapter refuses without one. */
  z.strictObject({
    adapter: z.literal('mongo'),
    uri: z.string().min(1),
    database: z.string().min(1),
  }),
])
export type StoreConfig = z.infer<typeof StoreConfig>

/**
 * A connection seeded from configuration, as the demo may do.
 *
 * A shortcut, never a replacement: the handshake must still work when these are
 * absent, and S0 tests it. Seeding exists so `docker compose up` reaches a first
 * transaction in under a minute, not so the handshake can be skipped.
 */
export const SeededConnection = z.strictObject({
  participantId: z.string().min(1),
  peerDid: Did,
  peerBaseUrl: z.url(),
  displayName: z.string().max(255).optional(),
  /** How the **peer** delivers to us. */
  inbound: PeerDelivery.default({ channel: 'stream' }),
  /** How **we** deliver to the peer. */
  outbound: PeerDelivery.default({ channel: 'stream' }),
})
export type SeededConnection = z.infer<typeof SeededConnection>

/**
 * A notification subscription seeded from configuration.
 *
 * The same shortcut as `PILOTS_CONNECTIONS`, and for the same reason: the demo's
 * backoffice container should be receiving work the moment `up` finishes, rather
 * than after somebody visits the admin UI. Subscriptions remain operator state
 * and the admin surface remains where they are managed.
 */
export const SeededSubscription = z.strictObject({
  id: z.string().min(1).max(64),
  participantId: z.string().min(1),
  label: z.string().min(1).max(255),
  channel: NotificationChannelName,
  target: z.union([WebhookTarget, z.null()]).default(null),
  notify: z.array(NotificationType).min(1),
  filter: SubscriptionFilter.default({}),
})
export type SeededSubscription = z.infer<typeof SeededSubscription>

export const ConnectorConfig = z.strictObject({
  port: z.int().min(0).max(65535),
  host: z.string().min(1),
  /**
   * How the process runs, **not** who the audience is.
   *
   * It changes log formatting and framework behaviour, and nothing else. It is
   * deliberately not a feature gate: every affordance has its own environment
   * variable with a production-ready default, because a deployed demo node runs
   * `production` and still needs its affordances. See `posture.ts`.
   */
  environment: z.enum(['development', 'production', 'test']),
  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']),
  store: StoreConfig,
  participants: z.array(ParticipantConfig).min(1),
  /** Directory of process definition JSON files, loaded and content-hashed at boot. */
  definitionsDir: z.string().min(1),
  /** Where generated secrets live. Never inside the repository. */
  secretsFile: z.string().min(1),
  /** Audit every read, not only mutations and denials. Off by default, or the log drowns in GETs. */
  auditReads: z.boolean(),

  /** `none` disables outbound peer calls entirely; tests supply their own transport. */
  peerTransport: z.enum(['http', 'none']),
  /** Connections established at boot instead of by handshake. A demo shortcut. */
  connections: z.array(SeededConnection),
  /** Notification subscriptions registered at boot. The same demo shortcut. */
  subscriptions: z.array(SeededSubscription),
  /** Peers whose connection requests are accepted without asking the operator. */
  autoAccept: z.array(Did),
  /**
   * Resolve peer DIDs through their configured base URL instead of through
   * `did:web`'s own DNS-derived URL.
   *
   * **This weakens the domain-binding check to "an operator configured it"**,
   * which is the one property `did:web` was chosen for. It exists because the
   * demo runs on the reserved `.example` TLD, where nothing resolves publicly.
   *
   * Defaults to **off**, so an unset environment is a safe one, and it is
   * reported by `postureOf` whenever it is on.
   */
  devDidDirectory: z.boolean(),
  /** How often the delivery scan loops run. `0` disables them; tests drive the pumps by hand. */
  deliveryIntervalMs: z.int().min(0),
  /**
   * An API key whose value was decided outside the connector, registered at boot.
   *
   * A demo convenience: the same value reaches a connector and its UI from one
   * gitignored `.env`, so `docker compose up` finds a working screen without a
   * human minting anything first. In a real deployment an operator mints a key
   * in the admin UI and the value arrives from a secret manager.
   *
   * **Used when supplied, never refused** — a deployed demo node needs it — and
   * reported by `postureOf` so an operator can alert on it.
   */
  seedApiKey: z.union([z.string().min(1), z.null()]),
  /**
   * The admin bootstrap token, decided outside the connector.
   *
   * The same shape as `seedApiKey`, for the same reason: `/api/admin/v1` is
   * meant to sit behind network-level access control rather than be its own
   * perimeter (see ARCHITECTURE.md §4). Without it the connector generates one
   * at first boot and prints it once; with it, a demo signs in without reading
   * a container log.
   *
   * **Used when supplied, never refused**, and reported by `postureOf`.
   */
  seedAdminToken: z.union([z.string().min(1), z.null()]),
  /**
   * The largest attachment this connector will accept.
   *
   * A ceiling, not a target. It also bounds the HTTP body limit, and the Mongo
   * adapter stores attachment bytes inline — raising this past ~15 MB means
   * moving that adapter to GridFS, which is why the number lives in one place.
   */
  maxAttachmentBytes: z.int().min(1),
})
export type ConnectorConfig = z.infer<typeof ConnectorConfig>

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase())
}

/**
 * Read the participant list.
 *
 * `PILOTS_PARTICIPANTS` is the general form — a JSON array. The four
 * `PILOTS_PARTICIPANT_*` variables are the one-participant shorthand the demo
 * uses, and they build a single-element list, so there is one code path.
 */
function readJsonList(value: string | undefined, name: string): unknown {
  if (value === undefined || value.trim() === '') return []
  try {
    return JSON.parse(value)
  } catch (cause) {
    throw new ConfigError(`${name} is not valid JSON: ${(cause as Error).message}`)
  }
}

function readParticipants(env: NodeJS.ProcessEnv): unknown {
  const list = env['PILOTS_PARTICIPANTS']
  if (list !== undefined && list.trim() !== '') {
    try {
      return JSON.parse(list)
    } catch (cause) {
      throw new ConfigError(`PILOTS_PARTICIPANTS is not valid JSON: ${(cause as Error).message}`)
    }
  }

  const did = env['PILOTS_PARTICIPANT_DID']
  if (did === undefined) return []
  return [
    {
      id: env['PILOTS_PARTICIPANT_ID'] ?? 'default',
      did,
      displayName: env['PILOTS_PARTICIPANT_NAME'] ?? did,
      baseUrl: env['PILOTS_BASE_URL'] ?? `http://localhost:${env['PILOTS_PORT'] ?? '3000'}`,
    },
  ]
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ConnectorConfig {
  const adapter = env['PILOTS_STORE'] ?? 'memory'
  const directory = env['PILOTS_STORE_DIR'] ?? './data'

  const candidate = {
    port: Number(env['PILOTS_PORT'] ?? 3000),
    host: env['PILOTS_HOST'] ?? '0.0.0.0',
    environment: env['NODE_ENV'] ?? 'development',
    logLevel: env['PILOTS_LOG_LEVEL'] ?? 'info',
    store:
      adapter === 'file'
        ? { adapter, directory }
        : adapter === 'mongo'
          ? {
              adapter,
              // No default: a connection string is a secret in every deployment
              // that matters, and a default would invite one into a committed file.
              uri: env['PILOTS_MONGO_URI'] ?? '',
              database: env['PILOTS_MONGO_DB'] ?? 'pilots',
            }
          : { adapter },
    participants: readParticipants(env),
    definitionsDir: env['PILOTS_DEFINITIONS_DIR'] ?? './definitions',
    secretsFile: env['PILOTS_SECRETS_FILE'] ?? `${directory}/secrets.json`,
    auditReads: bool(env['PILOTS_AUDIT_READS'], false),
    peerTransport: env['PILOTS_PEER_TRANSPORT'] ?? 'http',
    connections: readJsonList(env['PILOTS_CONNECTIONS'], 'PILOTS_CONNECTIONS'),
    subscriptions: readJsonList(env['PILOTS_SUBSCRIPTIONS'], 'PILOTS_SUBSCRIPTIONS'),
    autoAccept: (env['PILOTS_AUTO_ACCEPT'] ?? '')
      .split(',')
      .map((did) => did.trim())
      .filter((did) => did !== ''),
    devDidDirectory: bool(env['PILOTS_DEV_DID_DIRECTORY'], false),
    deliveryIntervalMs: Number(env['PILOTS_DELIVERY_INTERVAL_MS'] ?? 1000),
    maxAttachmentBytes: Number(env['PILOTS_MAX_ATTACHMENT_BYTES'] ?? 8 * 1024 * 1024),
    seedApiKey: env['PILOTS_SEED_API_KEY'] ?? null,
    seedAdminToken: env['PILOTS_SEED_ADMIN_TOKEN'] ?? null,
  }

  const parsed = ConnectorConfig.safeParse(candidate)
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n')
    throw new ConfigError(`invalid configuration:\n${detail}`)
  }

  const config = parsed.data
  const ids = new Set<string>()
  const dids = new Set<string>()
  for (const participant of config.participants) {
    if (ids.has(participant.id)) {
      throw new ConfigError(`duplicate participant id ${participant.id}`)
    }
    if (dids.has(participant.did)) {
      throw new ConfigError(`duplicate participant DID ${participant.did}`)
    }
    ids.add(participant.id)
    dids.add(participant.did)
  }

  for (const seeded of config.connections) {
    if (!ids.has(seeded.participantId)) {
      throw new ConfigError(
        `PILOTS_CONNECTIONS names participant ${seeded.participantId}, which is not configured`,
      )
    }
  }

  for (const seeded of config.subscriptions) {
    if (!ids.has(seeded.participantId)) {
      throw new ConfigError(
        `PILOTS_SUBSCRIPTIONS names participant ${seeded.participantId}, which is not configured`,
      )
    }
    if (seeded.channel === 'webhook' && seeded.target === null) {
      throw new ConfigError(`subscription ${seeded.id} is a webhook with nowhere to deliver`)
    }
  }

  /*
   * Nothing here is refused for being a demo convenience.
   *
   * These settings used to throw under `NODE_ENV=production`, which conflated
   * "how the code was built" with "who the audience is" and made a deployed
   * demo node impossible to start. A value supplied by configuration is now
   * used and reported instead — see `posture.ts`, which is logged at boot and
   * exposed for monitoring.
   */

  return config
}

/** DI token for the validated configuration. */
export const CONFIG = Symbol('ConnectorConfig')
