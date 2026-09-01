/**
 * The audit log — the second of the three logs, and the only one that records
 * what did *not* happen.
 *
 * It exists because failed actions produce no event at all. A rejected
 * connection request, a 403 on an unentitled transition, a peer whose JWS did
 * not verify, a chain verification failure — none of these appear in the event
 * log, because no event was ever created.
 *
 * Append-only, locally hash-chained with the same `sha256`-of-JCS primitive as
 * the event chain, unsigned, and **never replicated**. It is nobody else's
 * business.
 */
import { z } from 'zod'

import { Instant, Sha256, Ulid } from './common.js'

export const AuditCategory = z.enum(['admin', 'local', 'peer', 'runtime'])
export type AuditCategory = z.infer<typeof AuditCategory>

export const AuditOutcome = z.enum(['ok', 'denied', 'failed'])
export type AuditOutcome = z.infer<typeof AuditOutcome>

export const AuditActor = z.strictObject({
  kind: z.enum(['adminSession', 'apiKey', 'peer', 'runtime']),
  /** The session id, API key id, or peer DID. */
  id: z.string().min(1),
  /** The asserted, unproven `X-Actor-Ref`. An audit hint, never an identity claim. */
  actorRef: z.union([z.string().max(255), z.null()]).default(null),
})
export type AuditActor = z.infer<typeof AuditActor>

export const AuditSubject = z.strictObject({
  instance: z.union([Ulid, z.null()]).default(null),
  connection: z.union([Ulid, z.null()]).default(null),
  apiKey: z.union([z.string(), z.null()]).default(null),
  subscription: z.union([z.string(), z.null()]).default(null),
  offering: z.union([z.string(), z.null()]).default(null),
  definition: z.union([z.string(), z.null()]).default(null),
})
export type AuditSubject = z.infer<typeof AuditSubject>

export const AuditRequest = z.strictObject({
  method: z.string().max(16),
  path: z.string().max(1024),
  ip: z.union([z.string().max(64), z.null()]).default(null),
  /** The `jti` of the peer's bearer token, so a replay can be traced. */
  jti: z.union([z.string().max(255), z.null()]).default(null),
})
export type AuditRequest = z.infer<typeof AuditRequest>

export const AuditEntry = z.strictObject({
  /** Per participant, starting at 1. */
  seq: z.int().min(1),
  at: Instant,
  participantId: z.string().min(1),
  category: AuditCategory,
  /** `apiKey.create`, `connection.accept`, `transition.apply`, `chain.verify`, `delivery.fail`, … */
  action: z.string().min(1).max(64),
  actor: AuditActor,
  subject: AuditSubject,
  outcome: AuditOutcome,
  /** The problem type when the outcome was not `ok`. */
  problem: z.union([z.string().max(255), z.null()]).default(null),
  detail: z.union([z.string().max(2048), z.null()]).default(null),
  request: z.union([AuditRequest, z.null()]).default(null),
  /** `sha256` of the canonicalised previous entry. `null` only at `seq` 1. */
  prev: z.union([Sha256, z.null()]),
})
export type AuditEntry = z.infer<typeof AuditEntry>

/** The empty subject, so every entry has the same shape and hashes comparably. */
export const EMPTY_AUDIT_SUBJECT: AuditSubject = {
  instance: null,
  connection: null,
  apiKey: null,
  subscription: null,
  offering: null,
  definition: null,
}
