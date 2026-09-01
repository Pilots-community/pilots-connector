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

import { Did } from '@pilots/protocol'

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
])
export type StoreConfig = z.infer<typeof StoreConfig>

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
    store: adapter === 'file' ? { adapter, directory } : { adapter },
    participants: readParticipants(env),
    definitionsDir: env['PILOTS_DEFINITIONS_DIR'] ?? './definitions',
    secretsFile: env['PILOTS_SECRETS_FILE'] ?? `${directory}/secrets.json`,
    auditReads: bool(env['PILOTS_AUDIT_READS'], false),
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

  return config
}

/** DI token for the validated configuration. */
export const CONFIG = Symbol('ConnectorConfig')
