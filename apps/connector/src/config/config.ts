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

import { Did, PeerDelivery } from '@pilots/protocol'

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

export const ConnectorConfig = z.strictObject({
  port: z.int().min(0).max(65535),
  host: z.string().min(1),
  /** `development` relaxes nothing that matters; it only changes log formatting. */
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
  /** Peers whose connection requests are accepted without asking the operator. */
  autoAccept: z.array(Did),
  /**
   * Resolve peer DIDs through their configured base URL instead of through
   * `did:web`'s own DNS-derived URL.
   *
   * **This weakens the domain-binding check to "an operator configured it"**,
   * which is the one property `did:web` was chosen for. It exists because the
   * demo runs on the reserved `.example` TLD, where nothing resolves publicly.
   * `loadConfig` refuses to return a production config with it on.
   */
  devDidDirectory: z.boolean(),
  /** How often the delivery scan loops run. `0` disables them; tests drive the pumps by hand. */
  deliveryIntervalMs: z.int().min(0),
  /**
   * Mint an integration key on first boot and write it here, for a co-deployed
   * UI to read.
   *
   * **Development only**, and refused under production config. It exists so
   * `docker compose up` reaches a usable process UI without a human visiting the
   * admin UI first — and it writes a *generated* secret to a mounted path rather
   * than reading a committed one, which is the distinction that matters. In any
   * real deployment an operator mints a key in the admin UI and injects it.
   */
  integrationKeyFile: z.union([z.string().min(1), z.null()]),
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
    autoAccept: (env['PILOTS_AUTO_ACCEPT'] ?? '')
      .split(',')
      .map((did) => did.trim())
      .filter((did) => did !== ''),
    devDidDirectory: bool(env['PILOTS_DEV_DID_DIRECTORY'], false),
    deliveryIntervalMs: Number(env['PILOTS_DELIVERY_INTERVAL_MS'] ?? 1000),
    maxAttachmentBytes: Number(env['PILOTS_MAX_ATTACHMENT_BYTES'] ?? 8 * 1024 * 1024),
    integrationKeyFile: env['PILOTS_INTEGRATION_KEY_FILE'] ?? null,
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

  // The one config combination that is refused rather than warned about. A
  // deployment that resolves peer identity from its own configuration has given
  // up the property `did:web` was chosen for, and that must not be reachable by
  // forgetting to unset a variable.
  if (config.integrationKeyFile !== null && config.environment === 'production') {
    throw new ConfigError(
      'PILOTS_INTEGRATION_KEY_FILE mints an API key at boot and writes it to disk for another ' +
        'container to read. It is a demo convenience and cannot be used with NODE_ENV=production; ' +
        'mint a key in the admin UI and inject it instead.',
    )
  }

  if (config.devDidDirectory && config.environment === 'production') {
    throw new ConfigError(
      'PILOTS_DEV_DID_DIRECTORY resolves peer DIDs from configuration instead of did:web, ' +
        'which defeats the domain-binding check. It cannot be used with NODE_ENV=production.',
    )
  }

  return config
}

/** DI token for the validated configuration. */
export const CONFIG = Symbol('ConnectorConfig')
