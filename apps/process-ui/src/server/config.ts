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
   * Namespaces this UI's session cookie.
   *
   * **Cookies ignore the port.** Two process UIs on `localhost:4000` and
   * `localhost:4001` address the same cookie jar, so if both use better-auth's
   * default name, whichever signs in second silently signs the other out — and
   * it presents as "refreshing logs me out". Two UIs on one host **must** differ
   * here. The default is deliberately not unique: one UI needs no ceremony.
   *
   * Constrained to what is legal and unambiguous in a cookie name, because a
   * space or a semicolon here would produce a cookie header nobody can parse.
   */
  cookiePrefix: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/),
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ProcessUiConfig {
  const seedEmail = env['PILOTS_UI_SEED_EMAIL']
  const seedPassword = env['PILOTS_UI_SEED_PASSWORD']

  const candidate = {
    port: Number(env['PILOTS_UI_PORT'] ?? 4000),
    host: env['PILOTS_UI_HOST'] ?? '0.0.0.0',
    environment: env['NODE_ENV'] ?? 'development',
    logLevel: env['PILOTS_UI_LOG_LEVEL'] ?? 'info',
    connectorUrl: env['PILOTS_CONNECTOR_URL'] ?? 'http://localhost:3000',
    apiKey: (env['PILOTS_API_KEY'] ?? '').trim(),
    displayName: env['PILOTS_UI_NAME'] ?? 'Process UI',
    authSecret: env['PILOTS_UI_AUTH_SECRET'] ?? null,
    cookiePrefix: env['PILOTS_UI_COOKIE_PREFIX'] ?? 'pilots',
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
      'PILOTS_API_KEY is required: mint one in the connector’s admin UI, scoped to this ' +
        'participant. It has no default, because a default would be a credential in a committed ' +
        'file. For the demo, `pnpm demo:env` writes a gitignored .env that compose reads.',
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
