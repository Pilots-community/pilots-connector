/**
 * Admin sessions, for the admin surface only.
 *
 * Never accepted on `/api/local/v1` or `/api/peer/v1`, and never a substitute
 * for a DID signature. The connector is not an identity provider for anything
 * except its own admin UI — which is what keeps a third-party-hosted connector
 * from ending up holding your user accounts.
 *
 * **Why this is not `better-auth`, which docs/STACK.md §6 names.** Not because
 * better-auth would not fit — it ships memory, mongodb, kysely, drizzle and
 * prisma adapters, and the Mongo one arrives with the Mongo store in M3. The
 * reason is the line above: this admin has **no users**. No email, no passwords,
 * no sign-up, one operator per connector. Adopting an auth library here would
 * mean inventing an admin account with a password to give the library something
 * to manage — more surface, not less, and a human password is the one case where
 * the argument against a password KDF (docs/STACK.md §4.1) would flip.
 *
 * So this is the primitive that actually fits a single operator's first run, the
 * same one Grafana, Vault and Jupyter use: a 256-bit token, generated, printed
 * once, stored only as an HMAC, exchanged for a session. There is nothing for an
 * operator to choose badly, and no cryptography is hand-rolled — `createHmac`,
 * `randomBytes` and `timingSafeEqual` do the work.
 *
 * `seedToken` is the one deliberate exception, and it is still not a password:
 * it lets a deployment that already keeps `/api/admin/v1` off the public
 * internet (the intended posture — see docs/ARCHITECTURE.md §4) fix the token's
 * value in configuration instead of reading it from a log line, the same
 * demo-convenience shape as `PILOTS_SEED_API_KEY`.
 *
 * **This file must not grow into an auth library.** If a second operator, a
 * password login, account recovery, or sessions that outlive a restart is ever
 * wanted, adopt `better-auth` behind this same interface instead of extending
 * this. By then the Mongo store exists and its adapter is off the shelf.
 * better-auth's real home in this project is the process UI's BFF, which owns
 * actual user accounts.
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
  /**
   * Present only when this boot decided a *new* value for the token —
   * generated, or freshly adopted from configuration. Absent when the stored
   * hash (or a seed value already matching it) is what is in effect, because
   * there is nothing new to show or persist.
   */
  token?: string
  generated: boolean
  /** True when `token`'s value came from configuration rather than being generated here. */
  seeded: boolean
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
   * Load the admin token: from a seed value, from what was already stored, or
   * generate one on first boot — in that order.
   *
   * A token whose value is new this boot (generated, or freshly adopted from
   * configuration) is returned to the caller exactly once so it can be logged
   * for the operator. It is never stored in the clear and never retrievable
   * afterwards — except by an operator who set `seedToken`, who already has it.
   */
  static create(options: {
    storedHash: string | undefined
    pepper: string
    now: () => string
    /**
     * A token whose value was decided outside the connector.
     *
     * Mirrors `PILOTS_SEED_API_KEY`: a demo convenience, refused under
     * production config by `loadConfig`. It exists because `/api/admin/v1` is
     * meant to sit behind network-level access control rather than be its own
     * perimeter — a real deployment does not put this port on the public
     * internet, so a fixed, `.env`-visible admin credential costs it nothing.
     * Idempotent the same way a seeded API key is: a seed value that already
     * matches what is stored changes nothing and reports nothing new.
     */
    seedToken?: string | null
  }): {
    service: AdminSessionService
    tokenHash: string
  } {
    const hash = (token: string): string =>
      createHmac('sha256', options.pepper).update(token).digest('hex')

    if (options.seedToken) {
      const tokenHash = hash(options.seedToken)
      const changed = tokenHash !== options.storedHash
      return {
        service: new AdminSessionService(tokenHash, options.pepper, options.now, {
          ...(changed ? { token: options.seedToken } : {}),
          generated: false,
          seeded: true,
        }),
        tokenHash,
      }
    }

    if (options.storedHash !== undefined) {
      return {
        service: new AdminSessionService(options.storedHash, options.pepper, options.now, {
          generated: false,
          seeded: false,
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
        seeded: false,
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
