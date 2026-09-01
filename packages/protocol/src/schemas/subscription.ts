/**
 * Notification subscriptions — how a party with no UI at all runs processes.
 *
 * This is *local* delivery: connector to your own systems. It is configuration,
 * not protocol, and the peer on the other side neither knows nor cares about it.
 * Do not conflate it with peer delivery, which is declared on a connection.
 *
 * The type that matters is `action.required` — "it is our turn". It is
 * **computed** from the definition rather than declared: the connector asks
 * which transitions list one of our roles in `by` for the current state, using
 * the same `availableTransitions()` the UI uses to render its buttons. One rule,
 * three consumers: notifications, the UI, and the permission check.
 */
import { z } from 'zod'

import { DefinitionRef, Instant, Identifier, StateId, Ulid } from './common.js'
import { ProcessKind } from './definition.js'
import { SignedEvent } from './event.js'

export const NotificationType = z.enum([
  /** The instance entered a state where at least one transition is available to one of our roles. */
  'action.required',
  /** We are no longer the party who must act — so a work queue can drain itself. */
  'action.cleared',
  /** Any state change on an instance we participate in. */
  'state.changed',
  /** Every signed event, state change or not. Includes pure data patches. */
  'event',
])
export type NotificationType = z.infer<typeof NotificationType>

/**
 * `channel` is a port. `webhook` and `sse` now; queues (SQS, AMQP, Pub/Sub)
 * later. Adding a queue adapter must not change subscriptions, notification
 * types or the envelope — only the adapter. If it does, this model is wrong.
 */
export const NotificationChannelName = z.enum(['webhook', 'sse'])
export type NotificationChannelName = z.infer<typeof NotificationChannelName>

export const WebhookTarget = z.strictObject({
  url: z.url(),
  headers: z.record(z.string(), z.string()).default({}),
  /**
   * A *reference* to the shared secret, never the secret. `env:NAME` or
   * `secret:NAME`; the connector resolves it at delivery time.
   */
  secretRef: z.union([z.string().max(255), z.null()]).default(null),
})
export type WebhookTarget = z.infer<typeof WebhookTarget>

/** Every key is optional and they AND together; an absent key matches everything. */
export const SubscriptionFilter = z.strictObject({
  definitions: z.array(DefinitionRef).min(1).optional(),
  kinds: z.array(ProcessKind).min(1).optional(),
  states: z.array(StateId).min(1).optional(),
  transitions: z.array(Identifier).min(1).optional(),
  instances: z.array(Ulid).min(1).optional(),
})
export type SubscriptionFilter = z.infer<typeof SubscriptionFilter>

export const SubscriptionStatus = z.enum(['ACTIVE', 'PAUSED', 'DEGRADED'])
export type SubscriptionStatus = z.infer<typeof SubscriptionStatus>

export const NotificationSubscription = z.strictObject({
  id: z.string().min(1).max(64),
  participantId: z.string().min(1),
  label: z.string().min(1).max(255),
  channel: NotificationChannelName,
  /** Present for `webhook`; an `sse` subscriber holds the connection instead. */
  target: z.union([WebhookTarget, z.null()]).default(null),
  notify: z.array(NotificationType).min(1),
  filter: SubscriptionFilter.default({}),
  status: SubscriptionStatus,
  createdAt: Instant,
  updatedAt: Instant,
})
export type NotificationSubscription = z.infer<typeof NotificationSubscription>

/** One transition this participant may fire right now, and the role that permits it. */
export const AvailableAction = z.strictObject({
  transition: Identifier,
  role: Identifier,
})
export type AvailableAction = z.infer<typeof AvailableAction>

export const NotificationEnvelope = z.strictObject({
  notification: NotificationType,
  subscription: z.string().min(1),
  /** Monotonic, per participant. Replay from here with `GET /notifications?since=`. */
  cursor: z.string().min(1),
  at: Instant,
  instance: z.strictObject({
    id: Ulid,
    definition: DefinitionRef,
    kind: ProcessKind,
    state: StateId,
    seq: z.int().min(1),
  }),
  /**
   * What turns a notification into an instruction: the internal system reads a
   * transition id and posts it straight back. It needs no copy of the definition
   * and no state machine of its own.
   */
  available: z.array(AvailableAction),
  /** Carried whole, so an internal system may verify it rather than trust its own connector. */
  event: SignedEvent,
})
export type NotificationEnvelope = z.infer<typeof NotificationEnvelope>
