/**
 * Connections: established once, before any process runs.
 *
 * This is what replaces a callback URL per request. Two participants complete a
 * handshake, and every process afterwards flows over that one relationship — in
 * **both** directions and for either side's offerings. There is no supplier
 * connection and no consumer connection.
 */
import { z } from 'zod'

import { Did, Instant, Ulid } from './common.js'

export const ConnectionStatus = z.enum([
  /** A peer asked; our operator has not decided yet. */
  'PENDING_INBOUND',
  /** We asked; the peer has not decided yet. */
  'PENDING_OUTBOUND',
  /** Both sides agreed. Processes may flow. */
  'ACTIVE',
  /** Active, but peer delivery is failing. Events accumulate; not a business error. */
  'DEGRADED',
  /** The peer declined. Terminal; a new request starts a new connection. */
  'REJECTED',
  /** Either side ended it. Existing instances become read-only rather than disappearing. */
  'REVOKED',
])
export type ConnectionStatus = z.infer<typeof ConnectionStatus>

/**
 * How signed events reach a peer. Both channels carry the identical signed event
 * object; only the transport differs.
 *
 * `stream` is the one that matters for a small party: the peer holds an SSE
 * connection to us, so it needs no inbound endpoint, no DNS entry and no
 * certificate.
 */
export const PeerDelivery = z.discriminatedUnion('channel', [
  z.strictObject({ channel: z.literal('webhook'), url: z.url() }),
  z.strictObject({ channel: z.literal('stream') }),
])
export type PeerDelivery = z.infer<typeof PeerDelivery>

export const Connection = z.strictObject({
  id: Ulid,
  participantId: z.string().min(1),
  peerDid: Did,
  peerBaseUrl: z.url(),
  peerDisplayName: z.union([z.string().max(255), z.null()]).default(null),
  status: ConnectionStatus,
  /** How **we** deliver events to the peer. Declared by the peer. */
  outbound: PeerDelivery,
  /** How the **peer** delivers events to us. Declared by us. */
  inbound: PeerDelivery,
  /** Set when the connection last failed; cleared on recovery. */
  lastError: z.union([z.string().max(1024), z.null()]).default(null),
  /**
   * How far our **webhook** deliveries to this peer have got.
   *
   * Durable, and on the connection rather than in a queue, because "what has
   * this peer been sent" is a property of the relationship and has to survive a
   * restart. A `stream` peer needs no equivalent: it holds the cursor itself and
   * replays with `Last-Event-ID`, which is the same recovery shape from the
   * other end.
   */
  deliveryCursor: z.union([z.string().max(128), z.null()]).default(null),
  /**
   * How far we have consumed the peer's `stream`, echoed back as
   * `Last-Event-ID` when we reattach.
   *
   * Opaque to us — it is the peer's cursor, and its only meaning is "resume
   * after this". Persisted so a restart resumes rather than replaying an entire
   * history the replica already holds.
   */
  receiveCursor: z.union([z.string().max(128), z.null()]).default(null),
  createdAt: Instant,
  updatedAt: Instant,
})
export type Connection = z.infer<typeof Connection>

/** `POST /api/peer/v1/connections/requests` — the opening move of the handshake. */
export const ConnectionRequest = z.strictObject({
  connectionId: Ulid,
  fromDid: Did,
  fromBaseUrl: z.url(),
  displayName: z.string().max(255).optional(),
  /** How the requester wants to receive our events. */
  delivery: PeerDelivery,
  message: z.string().max(1024).optional(),
})
export type ConnectionRequest = z.infer<typeof ConnectionRequest>

/** `POST /api/peer/v1/connections/{id}/accepted` — the peer reports the outcome. */
export const ConnectionAccepted = z.strictObject({
  /** How the accepting side wants to receive our events. */
  delivery: PeerDelivery,
})
export type ConnectionAccepted = z.infer<typeof ConnectionAccepted>

export const ConnectionRejected = z.strictObject({
  reason: z.string().max(1024).optional(),
})
export type ConnectionRejected = z.infer<typeof ConnectionRejected>

/** Processes may only flow over a connection in one of these states. */
export function carriesTraffic(status: ConnectionStatus): boolean {
  return status === 'ACTIVE' || status === 'DEGRADED'
}
