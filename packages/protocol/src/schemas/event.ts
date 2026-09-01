/**
 * The signed, chained event — the protocol's record of what happened.
 *
 * Two shape decisions worth stating, because both are load-bearing:
 *
 * 1. **Every header field is always present.** Optionality is expressed as
 *    `null`, never by omitting a key. The header is canonicalised and hashed, so
 *    "did you include the key?" would be a cross-implementation disagreement
 *    waiting to happen.
 *
 * 2. **The signature covers the header only**, and the header commits to the
 *    payload by `payloadHash`. That is what lets a peer verify a complete,
 *    unbroken history including events whose payload it was never allowed to
 *    see. Redaction and tamper evidence coexist only because of this split.
 */
import { z } from 'zod'

import {
  AttachmentRef,
  Did,
  Instant,
  JsonObjectSchema,
  Sha256,
  StateId,
  Identifier,
  Ulid,
} from './common.js'

export const EventHeader = z.strictObject({
  instance: Ulid,
  /** Starts at 1 and increases by exactly 1. Assigned by the home node. */
  seq: z.int().min(1),
  /** The transition that was fired. `create` for `seq` 1. */
  transition: Identifier,
  /** The **participant's** DID. Never an individual: see docs/PROTOCOL.md §2.2. */
  actor: Did,
  /** The state before. `null` only at `seq` 1, where there was no before. */
  from: z.union([StateId, z.null()]),
  /** The state after. `null` for a pure data patch, which changes no state. */
  to: z.union([StateId, z.null()]),
  at: Instant,
  /** `sha256` of the canonicalised header at `seq - 1`. `null` only at `seq` 1. */
  prev: z.union([Sha256, z.null()]),
  /** `sha256` of the canonicalised payload, or of `{}` when there is none. */
  payloadHash: Sha256,
  /**
   * `sha256` of the canonicalised `InstanceGenesis` — the definition, the kind,
   * and the participants map.
   *
   * On **every** event, not only the first. It is what binds an event to the
   * instance identity that authority is judged against, so a peer verifying an
   * incremental batch never has to take the sender's word for who the
   * counterparty is. The value is identical across an instance's whole log,
   * because none of what it covers can change.
   */
  genesis: Sha256,
  attachments: z.array(AttachmentRef),
})
export type EventHeader = z.infer<typeof EventHeader>

export const SignedEvent = z.strictObject({
  header: EventHeader,
  /** Absent as `null`; partial when visibility withheld fields, and then `redacted` is true. */
  payload: z.union([JsonObjectSchema, z.null()]),
  /**
   * The payload has had fields withheld by the visibility filter, so it no
   * longer hashes to `payloadHash`. Outside the signed header on purpose: it is
   * a statement about *this copy*, not about what happened.
   */
  redacted: z.boolean().default(false),
  /** Detached compact JWS over the canonicalised header: `<protected>..<signature>`. */
  sig: z.string().min(1),
})
export type SignedEvent = z.infer<typeof SignedEvent>

/**
 * An event as held in a connector's own store: the replicated artefact plus the
 * local metadata that is deliberately never replicated.
 */
export const StoredEvent = SignedEvent.extend({
  participantId: z.string().min(1),
  /**
   * The `X-Actor-Ref` of whoever caused this, asserted and unproven. Local
   * metadata: never in the signed header, never sent to a peer. A replicated
   * chain cannot be retracted, and peers do not need your employees' names.
   */
  actorRef: z.union([z.string().max(255), z.null()]).default(null),
  /** When this connector recorded it, which for a replica is not `header.at`. */
  recordedAt: Instant,
})
export type StoredEvent = z.infer<typeof StoredEvent>
