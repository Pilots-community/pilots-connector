/**
 * Admin sessions, for the admin surface only.
 *
 * Never accepted on `/api/local/v1` or `/api/peer/v1`, and never a substitute
 * for a DID signature. The connector is not an identity provider for anything
 * except its own admin UI — which is what keeps a third-party-hosted connector
 * from ending up holding your user accounts.
 *
 * **Deviation from docs/STACK.md, stated rather than hidden.** The stack names
 * `better-auth` here. That library wants to own a user table and a database
 * adapter, and this connector's store is a document store behind a port with no
 * SQL anywhere; wiring the two together is an afternoon that buys nothing M2
 * needs, since the admin is one operator per connector. So this is the same
 * shape as an API key: a high-entropy bootstrap token, HMAC-stored, exchanged
 * for a session. `better-auth` — with real user accounts, passwords and MFA —
 * drops in behind this same interface when there is a reason to want it.
 *
 * Deliberately **not** a password: a 256-bit random token needs no KDF, and
 * there is nothing for an operator to choose badly.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

export interface AdminSession {
  id: string
  createdAt: string
  expiresAt: string
  /** What the audit log records as the actor for every administrative act. */
  label: string
}

export interface AdminBootstrap {
  /** Present only on the boot that generated it. Shown once, never stored. */
  token?: string
  generated: boolean
}

const SESSION_TTL_MS = 12 * 60 * 60 * 1000

export class AdminSessionService {
  private readonly sessions = new Map<string, AdminSession>()

  private constructor(
    private readonly tokenHash: string,
    private readonly pepper: string,
    private readonly now: () => string,
    readonly bootstrap: AdminBootstrap,
  ) {}

  /**
   * Load the admin token, generating one on first boot.
   *
   * A generated token is returned to the caller exactly once so it can be logged
   * for the operator. It is never stored in the clear and never retrievable.
   */
  static create(options: { storedHash: string | undefined; pepper: string; now: () => string }): {
    service: AdminSessionService
    tokenHash: string
  } {
    const hash = (token: string): string =>
      createHmac('sha256', options.pepper).update(token).digest('hex')

    if (options.storedHash !== undefined) {
      return {
        service: new AdminSessionService(options.storedHash, options.pepper, options.now, {
          generated: false,
        }),
        tokenHash: options.storedHash,
      }
    }

    const token = `adm_${randomBytes(32).toString('base64url')}`
    const tokenHash = hash(token)
    return {
      service: new AdminSessionService(tokenHash, options.pepper, options.now, {
        token,
        generated: true,
      }),
      tokenHash,
    }
  }

  private hash(value: string): string {
    return createHmac('sha256', this.pepper).update(value).digest('hex')
  }

  /** Exchange the bootstrap token for a session. Constant-time comparison. */
  signIn(token: string | undefined, label = 'operator'): AdminSession | undefined {
    if (token === undefined || token === '') return undefined
    const expected = Buffer.from(this.tokenHash, 'hex')
    const actual = Buffer.from(this.hash(token), 'hex')
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return undefined

    const createdAt = this.now()
    const session: AdminSession = {
      id: `sess_${randomBytes(24).toString('base64url')}`,
      createdAt,
      expiresAt: new Date(Date.parse(createdAt) + SESSION_TTL_MS).toISOString(),
      label,
    }
    this.sessions.set(session.id, session)
    return session
  }

  verify(sessionId: string | undefined): AdminSession | undefined {
    if (sessionId === undefined) return undefined
    const session = this.sessions.get(sessionId)
    if (!session) return undefined
    if (session.expiresAt <= this.now()) {
      this.sessions.delete(sessionId)
      return undefined
    }
    return session
  }

  signOut(sessionId: string): boolean {
    return this.sessions.delete(sessionId)
  }

  /**
   * Sessions live in memory, so a restart signs the operator out. That is
   * correct for a single-operator admin tool and one less thing in the store;
   * it is not correct for a multi-user admin, which is when better-auth earns
   * its place.
   */
  get sessionCount(): number {
    return this.sessions.size
  }
}

export const ADMIN_SESSIONS = Symbol('AdminSessionService')
