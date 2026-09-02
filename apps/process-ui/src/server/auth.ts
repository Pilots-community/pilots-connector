/**
 * This UI's own user accounts.
 *
 * **This is where an auth library belongs**, and the contrast with the
 * connector's admin is the point. The connector deliberately is not an identity
 * provider: it has one operator, no email, no passwords, no sign-up, and that is
 * what stops a third-party-hosted connector from ending up holding your user
 * accounts. This app is the opposite — it has actual users, with actual
 * passwords — so it uses `better-auth` rather than inventing one.
 *
 * The users live *here*, not in the connector. A connector authenticates the
 * **key**, not the person; `X-Actor-Ref` carries who was driving, as an audit
 * hint that is never part of a signed header and never replicated. Swap this UI
 * for somebody else's and the connector notices nothing, which is the whole
 * argument for the split.
 *
 * The store is in memory. Sessions and accounts do not survive a restart, which
 * is correct for a demo and wrong for anything else — better-auth's own Mongo
 * and Kysely adapters are a configuration change away when it stops being one.
 */
import { randomBytes } from 'node:crypto'

import { betterAuth } from 'better-auth'
import { memoryAdapter } from 'better-auth/adapters/memory'

import type { ProcessUiConfig } from './config.js'

export interface SignedInUser {
  id: string
  email: string
  name: string
}

export interface AuthService {
  /** Handles `/api/auth/*` — sign-up, sign-in, sign-out, session. */
  handler(request: Request): Promise<Response>
  /** The signed-in user, or `undefined`. What every BFF route gates on. */
  userFor(headers: Headers): Promise<SignedInUser | undefined>
  /** Create the demo account, if one was configured. Idempotent. */
  seed(): Promise<void>
}

export function createAuth(config: ProcessUiConfig, baseURL: string): AuthService {
  const auth = betterAuth({
    // Generated when absent so a demo boots without ceremony. A deployment that
    // wants sessions to survive a restart injects one.
    secret: config.authSecret ?? randomBytes(32).toString('base64url'),
    baseURL,
    basePath: '/api/auth',
    // The memory adapter stores each model in an array it is handed, so the
    // four core models have to exist before anything writes to them.
    database: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
    emailAndPassword: {
      enabled: true,
      // No mail server in a demo, and pretending otherwise would leave every
      // account unusable behind a verification link nobody receives.
      requireEmailVerification: false,
      autoSignIn: true,
    },
    advanced: {
      // The BFF and the SPA are the same origin, so a cookie is the right
      // carrier and does not need to be readable by script.
      useSecureCookies: config.environment === 'production',
    },
  })

  return {
    handler: (request) => auth.handler(request),

    async userFor(headers) {
      const session = await auth.api.getSession({ headers })
      if (!session?.user) return undefined
      return {
        id: session.user.id,
        email: session.user.email,
        name: session.user.name || session.user.email,
      }
    },

    async seed() {
      if (!config.seedUser) return
      try {
        await auth.api.signUpEmail({
          body: {
            email: config.seedUser.email,
            password: config.seedUser.password,
            name: config.seedUser.email.split('@')[0] ?? 'demo',
          },
        })
      } catch {
        // Already there. Seeding is idempotent by intent, and better-auth
        // reports a duplicate as an error rather than a no-op.
      }
    },
  }
}
