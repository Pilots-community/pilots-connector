/**
 * API keys for the integration surface.
 *
 * An API key is a 256-bit CSPRNG secret, not a human password, so it is stored
 * as `HMAC-SHA256(pepper, secret)` rather than under a password KDF. Argon2 and
 * bcrypt exist to slow brute force of *low-entropy* input; against a random
 * 256-bit key they buy nothing and you would pay their cost on every API call.
 * See docs/STACK.md §4.1.
 *
 * This schema holds the *record*. The secret itself is shown once, at creation,
 * and never stored.
 */
import { z } from 'zod'

import { Instant } from './common.js'

/** Deliberately few. Per-definition and per-role scoping is a named later refinement. */
export const Scope = z.enum([
  'instances:read',
  'instances:write',
  'events:read',
  'attachments:read',
  'attachments:write',
  'connections:read',
  'definitions:read',
  /**
   * Publish a process definition.
   *
   * Deliberately on the integration surface rather than behind an admin
   * session: anything our own UI can do, a third party's UI or an integrator's
   * build pipeline must be able to do over the same surface. Accepting a
   * *peer's* definition is a different act and stays on the admin surface,
   * because it is a trust decision rather than a process one.
   */
  'definitions:write',
])
export type Scope = z.infer<typeof Scope>

export const ALL_SCOPES: readonly Scope[] = Scope.options

export const ApiKeyRecord = z.strictObject({
  /** The public half of the key, sent in the clear and used to look the record up. */
  id: z.string().regex(/^ak_[0-9A-HJKMNP-TV-Z]{26}$/i),
  participantId: z.string().min(1),
  label: z.string().min(1).max(255),
  /** `HMAC-SHA256(pepper, secret)`, hex. Never the secret itself. */
  secretHash: z.string().regex(/^[0-9a-f]{64}$/),
  scopes: z.array(Scope).min(1),
  /** The admin session that minted it. */
  createdBy: z.string().min(1),
  createdAt: Instant,
  lastUsedAt: z.union([Instant, z.null()]).default(null),
  revokedAt: z.union([Instant, z.null()]).default(null),
  expiresAt: z.union([Instant, z.null()]).default(null),
})
export type ApiKeyRecord = z.infer<typeof ApiKeyRecord>

/** The scope each mutating operation requires. One table, so no route can invent its own rule. */
export const REQUIRED_SCOPES = {
  'instances.read': 'instances:read',
  'instances.create': 'instances:write',
  'transitions.apply': 'instances:write',
  'events.read': 'instances:read',
  'events.subscribe': 'events:read',
  'attachments.read': 'attachments:read',
  'attachments.write': 'attachments:write',
  'connections.read': 'connections:read',
  'definitions.read': 'definitions:read',
  'definitions.lint': 'definitions:write',
  'definitions.publish': 'definitions:write',
  'offerings.read': 'definitions:read',
} as const satisfies Record<string, Scope>

export type ScopedOperation = keyof typeof REQUIRED_SCOPES

export function isUsable(key: ApiKeyRecord, now: string): boolean {
  if (key.revokedAt !== null) return false
  if (key.expiresAt !== null && key.expiresAt <= now) return false
  return true
}

export function hasScope(key: Pick<ApiKeyRecord, 'scopes'>, operation: ScopedOperation): boolean {
  return key.scopes.includes(REQUIRED_SCOPES[operation])
}
