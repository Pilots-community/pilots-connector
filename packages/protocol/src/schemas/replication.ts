/**
 * What one connector sends another when it replicates an instance.
 *
 * The shape exists because an event log alone cannot reconstruct the instance it
 * describes: a header names a transition and two states, but not which
 * definition governs or who fills which role. Those are exactly the facts
 * authority is judged against, so they travel alongside the events — and every
 * header commits to their hash (`genesis`), which is what stops the sender from
 * being believed about them.
 *
 * Both peer delivery channels carry this identical object. `webhook` POSTs it
 * and `stream` pushes it down an SSE line; only the transport differs, which is
 * the whole point of declaring the channel once on the connection.
 */
import { z } from 'zod'

import { DefinitionRef, Instant, Ulid } from './common.js'
import { ProcessKind } from './definition.js'
import { SignedEvent } from './event.js'
import { ParticipantMap } from './instance.js'

/**
 * Everything about an instance that is fixed at creation.
 *
 * `id` and `createdAt` are already committed to by the log — the first header
 * carries both — so this adds exactly the fields `InstanceGenesis` covers, and a
 * receiver can check all of it.
 */
export const InstanceIdentity = z.strictObject({
  id: Ulid,
  kind: ProcessKind,
  definition: DefinitionRef,
  participants: ParticipantMap,
  quotationId: z.union([Ulid, z.null()]).default(null),
  offering: z.union([z.string().max(255), z.null()]).default(null),
  createdAt: Instant,
})
export type InstanceIdentity = z.infer<typeof InstanceIdentity>

/** One instance's events. Ordered, contiguous, and starting wherever the peer asked. */
export const EventDelivery = z.strictObject({
  instance: InstanceIdentity,
  events: z.array(SignedEvent).min(1),
})
export type EventDelivery = z.infer<typeof EventDelivery>

export const DeliveryBatch = z.strictObject({
  deliveries: z.array(EventDelivery).min(1),
  /**
   * The sender's cursor for this batch, echoed by a `stream` peer as
   * `Last-Event-ID`. Absent on a pull, which is addressed by `seq` instead.
   */
  cursor: z.union([z.string().max(128), z.null()]).default(null),
})
export type DeliveryBatch = z.infer<typeof DeliveryBatch>
