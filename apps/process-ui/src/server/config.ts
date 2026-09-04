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
   * Show the demo affordances: today, the "fill with sample data" button.
   *
   * **A flag of its own, deliberately not keyed on `NODE_ENV`.** A deployed
   * demo node runs `NODE_ENV=production` because it is a deployment, and would
   * still want these; reading the build mode as "is this a real customer" is a
   * conflation that gets more wrong the moment the demo leaves a laptop.
   *
   * Off unless asked for, like every other affordance here that would be a
   * liability in front of the wrong audience.
   */
  demoTools: z.boolean(),
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
    demoTools: ['1', 'true', 'yes', 'on'].includes(
      (env['PILOTS_UI_DEMO_TOOLS'] ?? '').toLowerCase(),
    ),
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

  return parsed.data
}

export interface PostureWarning {
  setting: string
  detail: string
}

export interface Posture {
  productionReady: boolean
  warnings: PostureWarning[]
}

/**
 * Whether this UI is configured the way a production one should be.
 *
 * The seeded account used to be **refused** under `NODE_ENV=production`, which
 * conflated how the code was built with who is looking at it — and made a
 * deployed demo node impossible to start. It is now used and reported: `/healthz`
 * carries the boolean for an alert to watch, and the boot log carries the detail.
 */
export function postureOf(config: ProcessUiConfig): Posture {
  const warnings: PostureWarning[] = []

  if (config.seedUser) {
    warnings.push({
      setting: 'PILOTS_UI_SEED_EMAIL',
      detail: `an account (${config.seedUser.email}) is created at boot with a password taken from configuration, so anyone who can read the environment can sign in`,
    })
  }
  if (config.demoTools) {
    warnings.push({
      setting: 'PILOTS_UI_DEMO_TOOLS',
      detail:
        'demo affordances are shown, including a button that fills any form with generated sample data',
    })
  }
  if (config.cookiePrefix === 'pilots') {
    // Not a weakening on its own, but two UIs on one host that share a cookie
    // name sign each other out — the bug this default exists to make visible.
    warnings.push({
      setting: 'PILOTS_UI_COOKIE_PREFIX',
      detail:
        'left at the default, so a second process UI on the same host would share this one’s session cookie and sign its users out',
    })
  }

  return { productionReady: warnings.length === 0, warnings }
}
