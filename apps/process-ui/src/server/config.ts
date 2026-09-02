/**
 * Configuration for the process UI's BFF.
 *
 * The interesting line is `PILOTS_API_KEY`. This container holds **one** API
 * key, scoped to one participant, and every user of this UI acts through it —
 * with `X-Actor-Ref` saying which of them. That is the arrangement the whole
 * design assumes: the connector authenticates the *key*, not the person, and
 * knows nothing about your staff. It is also why this app can be replaced by
 * somebody's own UI without the connector noticing.
 *
 * Nothing here has a secret default. The key is minted in the admin UI and
 * injected; a default would be a credential in a committed file.
 */
import { readFileSync } from 'node:fs'

import { z } from 'zod'

export const ProcessUiConfig = z.strictObject({
  port: z.int().min(0).max(65535),
  host: z.string().min(1),
  environment: z.enum(['development', 'production', 'test']),
  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']),
  /** The connector this UI drives. Always **our own** — never a peer. */
  connectorUrl: z.url(),
  /** One key, one participant. Minted in the admin UI. */
  apiKey: z.string().min(1),
  /** Shown in the header, so a demo with two UIs open is not confusing. */
  displayName: z.string().min(1),
  /** Signs this UI's own sessions. Generated on first boot if absent. */
  authSecret: z.union([z.string().min(32), z.null()]),
  /**
   * A demo account created at boot, so `docker compose up` reaches a usable UI
   * without a sign-up flow. Absent in any deployment that matters.
   */
  seedUser: z.union([z.strictObject({ email: z.email(), password: z.string().min(8) }), z.null()]),
})
export type ProcessUiConfig = z.infer<typeof ProcessUiConfig>

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

/**
 * The key, from the environment or from a file a co-deployed connector wrote.
 *
 * The file form exists for `docker compose up`: the connector mints a key on
 * first boot and writes it to a shared volume, so nothing has to carry a
 * credential through a committed file. In any real deployment an operator mints
 * one in the admin UI and injects the value.
 */
function readApiKey(env: NodeJS.ProcessEnv): string {
  const direct = env['PILOTS_API_KEY']
  if (direct !== undefined && direct.trim() !== '') return direct.trim()

  const file = env['PILOTS_API_KEY_FILE']
  if (file === undefined || file.trim() === '') return ''
  try {
    return readFileSync(file.trim(), 'utf8').trim()
  } catch (cause) {
    throw new ConfigError(
      `PILOTS_API_KEY_FILE points at ${file}, which could not be read: ${(cause as Error).message}. ` +
        'The connector writes it on first boot; if they share a volume, it may simply not be up yet.',
    )
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ProcessUiConfig {
  const seedEmail = env['PILOTS_UI_SEED_EMAIL']
  const seedPassword = env['PILOTS_UI_SEED_PASSWORD']

  const candidate = {
    port: Number(env['PILOTS_UI_PORT'] ?? 4000),
    host: env['PILOTS_UI_HOST'] ?? '0.0.0.0',
    environment: env['NODE_ENV'] ?? 'development',
    logLevel: env['PILOTS_UI_LOG_LEVEL'] ?? 'info',
    connectorUrl: env['PILOTS_CONNECTOR_URL'] ?? 'http://localhost:3000',
    apiKey: readApiKey(env),
    displayName: env['PILOTS_UI_NAME'] ?? 'Process UI',
    authSecret: env['PILOTS_UI_AUTH_SECRET'] ?? null,
    seedUser:
      seedEmail === undefined || seedPassword === undefined
        ? null
        : { email: seedEmail, password: seedPassword },
  }

  const parsed = ProcessUiConfig.safeParse(candidate)
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n')
    throw new ConfigError(`invalid configuration:\n${detail}`)
  }

  if (parsed.data.apiKey === '') {
    throw new ConfigError(
      'PILOTS_API_KEY (or PILOTS_API_KEY_FILE) is required: mint one in the connector’s admin UI, ' +
        'scoped to this participant. It has no default, because a default would be a credential in a ' +
        'committed file.',
    )
  }

  // A seeded account is a demo convenience and a production hazard, so it is
  // refused rather than warned about — the same shape as the connector's
  // dev-DID-directory guard.
  if (parsed.data.seedUser && parsed.data.environment === 'production') {
    throw new ConfigError(
      'PILOTS_UI_SEED_EMAIL creates an account with a known password at boot. ' +
        'It cannot be used with NODE_ENV=production.',
    )
  }

  return parsed.data
}
