/**
 * Local delivery — how a party with **no UI at all** runs processes.
 *
 * Its internal systems are told when something needs doing, and they answer on
 * the local API. That is the whole of it, and it is why an automated participant
 * is possible without a second product.
 *
 * The type that carries the weight is `action.required`, and it is **computed,
 * not configured**: for the instance's current state, ask the definition which
 * transitions list one of our roles in `by`. Nothing is declared in a definition
 * to support it — it falls out of the state machine that already exists, through
 * the same `availableTransitions()` the UI uses to render its buttons. One rule,
 * three consumers: notifications, the UI, and the permission check.
 *
 * `available` in the envelope is what turns a notification into an instruction.
 * The internal system reads a transition id and posts it straight back. It needs
 * no copy of the definition and no state machine of its own — which is the test
 * of whether this design actually works.
 */
import {
  availableTransitions,
  outcomeOf,
  filterEvent,
  rolesOf,
  type AvailableAction,
  type Clock,
  type NotificationEnvelope,
  type NotificationSubscription,
  type NotificationType,
  type SignedEvent,
  type StoredEvent,
  type StoredInstance,
} from '@pilots/protocol'

import type { ParticipantConfig } from '../config/config.js'
import type {
  DefinitionRegistry,
  RegisteredDefinition,
} from '../definitions/definition-registry.js'
import type { LogService } from '../logging/log.service.js'
import type { NotificationDocument } from '../store/types.js'
import type { Store, SubscriptionDocument } from '../store/store.js'
import type { NotificationChannel } from './channel.js'

/**
 * Exponential, and finite. The last value is where "the backoffice is down for
 * ten minutes" stops being retried at speed and starts being an operator's
 * problem — which is what `DEGRADED` and the dead letter are for.
 */
const BACKOFF_MS = [1_000, 5_000, 30_000, 120_000, 600_000]

/** How many envelopes one delivery attempt carries. */
const BATCH = 32

export interface WriteNotice {
  definition: RegisteredDefinition
  /** The instance before this write, or `null` when this write created it. */
  before: StoredInstance | null
  after: StoredInstance
  events: readonly StoredEvent[]
}

export class NotificationService {
  constructor(
    private readonly store: Store,
    private readonly definitions: DefinitionRegistry,
    private readonly channels: Map<string, NotificationChannel>,
    private readonly log: LogService,
    private readonly clock: Clock,
    private readonly now: () => string,
    private readonly nextId: () => string,
    private readonly localParticipants: () => readonly ParticipantConfig[],
  ) {}

  // ── deciding what to notify ──────────────────────────────────────────────

  /**
   * Called after every committed write — our own and replicated alike.
   *
   * A replica's backoffice needs `action.required` exactly as much as the home
   * node's does. If this only fired for local writes, the automated participant
   * would work in one direction and quietly not in the other.
   */
  async onWrite(notice: WriteNotice): Promise<void> {
    for (const participant of this.localParticipants()) {
      const roles = rolesOf(notice.after.participants, participant.did)
      if (roles.length === 0) continue

      const stored = await this.store.instances.get(participant.id, notice.after.id)
      if (!stored) continue

      /*
       * `ACTIVE` **and** `DEGRADED`.
       *
       * `DEGRADED` means delivery is failing, and the whole point of the state
       * is that events *accumulate* and go out on recovery. Recording only for
       * `ACTIVE` drops them permanently the moment a backoffice has a bad
       * minute — and leaves the replay endpoint, which is specified as
       * authoritative, with nothing to replay. Only `PAUSED` stops the
       * recording, because an operator asked for that explicitly.
       */
      const subscriptions = (await this.store.subscriptions.find(participant.id)).filter(
        (subscription) => subscription.status !== 'PAUSED',
      )
      if (subscriptions.length === 0) continue

      await this.emit(participant, roles, stored, notice, subscriptions)
    }
  }

  private async emit(
    participant: ParticipantConfig,
    roles: string[],
    stored: StoredInstance,
    notice: WriteNotice,
    subscriptions: SubscriptionDocument[],
  ): Promise<void> {
    const definition = notice.definition.definition
    const availableBefore = notice.before
      ? availableTransitions(definition, notice.before, roles)
      : []
    const availableAfter = availableTransitions(definition, stored, roles)

    const types: { type: NotificationType; event: StoredEvent }[] = []
    for (const event of notice.events) {
      types.push({ type: 'event', event })
      if (event.header.to !== null) types.push({ type: 'state.changed', event })
    }

    const last = notice.events.at(-1)
    const changedState = notice.before === null || notice.before.state !== stored.state
    if (last && changedState) {
      /*
       * "The instance **entered a state** where at least one transition is
       * available to one of our roles" — docs/PROTOCOL.md §4.4, and it is meant
       * literally.
       *
       * An earlier version fired only on the edge from nothing-available to
       * something-available, which is tidier and wrong: most definitions carry a
       * `cancel` available from `*`, so something is nearly always available and
       * the notification would fire once at creation and never again. A
       * backoffice would never be told it was time to weigh.
       *
       * Gated on the **state** changing rather than on any write, so a pure data
       * patch does not re-announce a turn that has not moved.
       */
      if (availableAfter.length > 0) {
        types.push({ type: 'action.required', event: last })
      } else if (availableBefore.length > 0) {
        types.push({ type: 'action.cleared', event: last })
      }
    }

    for (const { type, event } of types) {
      for (const subscription of subscriptions) {
        if (!matches(subscription, type, stored, event)) continue
        await this.enqueue(participant, subscription, type, stored, event, roles, availableAfter)
      }
    }
  }

  private async enqueue(
    participant: ParticipantConfig,
    subscription: SubscriptionDocument,
    type: NotificationType,
    stored: StoredInstance,
    event: StoredEvent,
    roles: string[],
    available: AvailableAction[],
  ): Promise<void> {
    const id = this.nextId()
    const envelope = this.envelope(
      subscription,
      type,
      id,
      stored,
      event,
      roles,
      type === 'action.cleared' ? [] : available,
    )

    const document: NotificationDocument = {
      id,
      participantId: participant.id,
      subscriptionId: subscription.id,
      notification: type,
      instanceId: stored.id,
      createdAt: this.now(),
      envelope,
      status: 'pending',
      attempts: 0,
      // Due immediately. The pump is a scan loop over this field, never a timer.
      nextAttemptAt: this.now(),
      lastError: null,
    }
    await this.store.notifications.insert(document)
  }

  /**
   * Build the envelope, **visibility-filtered exactly as a read would be**.
   *
   * A notification must never carry a field its recipient could not have read
   * from `GET /instances/{id}`. Sending the event through a different code path
   * than the read is how that guarantee gets lost, so this calls the same
   * filters.
   */
  private envelope(
    subscription: SubscriptionDocument,
    type: NotificationType,
    cursor: string,
    stored: StoredInstance,
    event: StoredEvent,
    roles: string[],
    available: AvailableAction[],
  ): NotificationEnvelope {
    const definition = this.definitions.get(stored.definition)?.definition
    const signed: SignedEvent = {
      header: event.header,
      payload: event.payload,
      redacted: event.redacted,
      sig: event.sig,
    }

    return {
      notification: type,
      subscription: subscription.id,
      cursor,
      at: this.now(),
      instance: {
        id: stored.id,
        definition: stored.definition,
        kind: stored.kind,
        state: stored.state,
        // The generic half of "where is this process". A recipient that does
        // not hold the definition still learns whether it is over and how.
        // `running` when the definition is unknown, which is the same guess
        // `outcomeOf` makes and the safe one.
        outcome: definition ? outcomeOf(definition, stored.state) : 'running',
        seq: stored.seq,
      },
      available,
      // The signed event is carried whole, so an internal system may verify it
      // independently instead of trusting its own connector.
      event: definition ? filterEvent(definition, signed, roles, stored.state) : signed,
    }
  }

  // ── delivering ───────────────────────────────────────────────────────────

  /**
   * Deliver everything due, for every participant. Driven by `Clock`, so a test
   * advances a ten-minute backoff with a function call.
   */
  async pump(): Promise<{ delivered: number; failed: number; dead: number }> {
    let delivered = 0
    let failed = 0
    let dead = 0

    for (const participant of this.localParticipants()) {
      const due = await this.due(participant.id)
      const bySubscription = new Map<string, NotificationDocument[]>()
      for (const notification of due) {
        const batch = bySubscription.get(notification.subscriptionId) ?? []
        if (batch.length < BATCH) batch.push(notification)
        bySubscription.set(notification.subscriptionId, batch)
      }

      for (const [subscriptionId, batch] of bySubscription) {
        const outcome = await this.attempt(participant, subscriptionId, batch)
        delivered += outcome.delivered
        failed += outcome.failed
        dead += outcome.dead
      }
    }

    return { delivered, failed, dead }
  }

  private async due(participantId: string): Promise<NotificationDocument[]> {
    const pending = await this.store.notifications.find(participantId, {
      where: { status: 'pending' },
      sort: { field: 'id', direction: 'asc' },
    })
    const now = this.clock.now()
    return pending.filter(
      (notification) =>
        notification.nextAttemptAt === null || Date.parse(notification.nextAttemptAt) <= now,
    )
  }

  private async attempt(
    participant: ParticipantConfig,
    subscriptionId: string,
    batch: NotificationDocument[],
  ): Promise<{ delivered: number; failed: number; dead: number }> {
    const subscription = await this.store.subscriptions.get(participant.id, subscriptionId)
    if (!subscription) {
      // The operator deleted it. The notifications stay readable through the
      // replay endpoint; nothing is going to deliver them.
      for (const notification of batch) {
        await this.store.notifications.replace({
          ...notification,
          status: 'dead',
          lastError: 'the subscription no longer exists',
        })
      }
      return { delivered: 0, failed: 0, dead: batch.length }
    }

    const channel = this.channels.get(subscription.channel)
    if (!channel) {
      return this.failBatch(participant, subscription, batch, `no ${subscription.channel} channel`)
    }

    try {
      await channel.deliver(
        subscription,
        batch.map((notification) => notification.envelope as NotificationEnvelope),
      )
    } catch (cause) {
      return this.failBatch(participant, subscription, batch, (cause as Error).message)
    }

    const at = this.now()
    for (const notification of batch) {
      await this.store.notifications.replace({
        ...notification,
        status: 'delivered',
        attempts: notification.attempts + 1,
        nextAttemptAt: null,
        lastError: null,
      })
    }
    if (subscription.status === 'DEGRADED') {
      await this.store.subscriptions.replace({ ...subscription, status: 'ACTIVE', updatedAt: at })
    }
    return { delivered: batch.length, failed: 0, dead: 0 }
  }

  /**
   * A failed delivery: back off, and eventually stop.
   *
   * The business process is deliberately unaffected. A backoffice that cannot be
   * reached is an operational fault; refusing to advance a process because of it
   * would make one party's infrastructure everybody's problem.
   */
  private async failBatch(
    participant: ParticipantConfig,
    subscription: SubscriptionDocument,
    batch: NotificationDocument[],
    error: string,
  ): Promise<{ delivered: number; failed: number; dead: number }> {
    let failed = 0
    let dead = 0

    for (const notification of batch) {
      const attempts = notification.attempts + 1
      const backoff = BACKOFF_MS[attempts - 1]
      if (backoff === undefined) {
        await this.store.notifications.replace({
          ...notification,
          status: 'dead',
          attempts,
          nextAttemptAt: null,
          lastError: error,
        })
        dead += 1
      } else {
        await this.store.notifications.replace({
          ...notification,
          attempts,
          nextAttemptAt: new Date(this.clock.now() + backoff).toISOString(),
          lastError: error,
        })
        failed += 1
      }
    }

    if (subscription.status !== 'DEGRADED') {
      await this.store.subscriptions.replace({
        ...subscription,
        status: 'DEGRADED',
        updatedAt: this.now(),
      })
    }

    await this.log.record({
      level: 'warn',
      message: `local delivery to ${subscription.label} failed`,
      audit: {
        participantId: participant.id,
        category: 'runtime',
        action: 'delivery.fail',
        actor: { kind: 'runtime', id: 'notifications', actorRef: null },
        outcome: 'failed',
        detail: `${error}${dead > 0 ? `; ${dead} dead-lettered` : ''}`,
        subject: { subscription: subscription.id },
      },
    })

    return { delivered: 0, failed, dead }
  }

  // ── replay ───────────────────────────────────────────────────────────────

  /**
   * `GET /notifications?since=<cursor>` — authoritative, by design.
   *
   * A backoffice that was down catches up here without operator involvement, and
   * without anyone having to decide whether a delivery "really" happened. It
   * reads everything, delivered or not: the recipient deduplicates on the cursor,
   * which it must be able to do anyway because delivery is at-least-once.
   */
  async replay(
    participantId: string,
    sinceCursor?: string,
    limit = 200,
  ): Promise<NotificationDocument[]> {
    return this.store.notifications.find(participantId, {
      sort: { field: 'id', direction: 'asc' },
      ...(sinceCursor === undefined ? {} : { after: sinceCursor }),
      limit,
    })
  }

  /** Dead letters, for the admin UI. Nothing retries them automatically. */
  async deadLetters(participantId: string): Promise<NotificationDocument[]> {
    return this.store.notifications.find(participantId, {
      where: { status: 'dead' },
      sort: { field: 'id', direction: 'asc' },
    })
  }

  /** Put dead letters back in the queue. An operator's decision, never automatic. */
  async retryDeadLetters(participantId: string, subscriptionId?: string): Promise<number> {
    const dead = await this.deadLetters(participantId)
    let requeued = 0
    for (const notification of dead) {
      if (subscriptionId !== undefined && notification.subscriptionId !== subscriptionId) continue
      await this.store.notifications.replace({
        ...notification,
        status: 'pending',
        attempts: 0,
        nextAttemptAt: this.now(),
      })
      requeued += 1
    }
    return requeued
  }
}

/**
 * Every `filter` key is optional and they AND together; an absent key matches
 * everything. An empty filter with `notify: ["event"]` is the firehose, and that
 * is a legitimate thing to ask for.
 */
export function matches(
  subscription: NotificationSubscription,
  type: NotificationType,
  instance: StoredInstance,
  event: StoredEvent,
): boolean {
  if (!subscription.notify.includes(type)) return false

  const filter = subscription.filter
  if (filter.definitions && !filter.definitions.includes(instance.definition)) return false
  if (filter.kinds && !filter.kinds.includes(instance.kind)) return false
  if (filter.instances && !filter.instances.includes(instance.id)) return false
  if (filter.states && !filter.states.includes(instance.state)) return false
  if (filter.transitions && !filter.transitions.includes(event.header.transition)) return false
  return true
}

export const NOTIFICATIONS = Symbol('NotificationService')
