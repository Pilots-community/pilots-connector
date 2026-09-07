/**
 * Peer delivery — getting our signed events to the other connector.
 *
 * Two channels, declared once per direction on the connection, carrying the
 * **identical** signed event object:
 *
 * - `webhook` — we POST batches to the peer's registered URL, backing off on
 *   failure and parking the connection in `DEGRADED`. Progress is a durable
 *   cursor on the connection, so a restart resumes rather than re-sends.
 * - `stream` — the peer holds an SSE line open to us and we push down it. It
 *   needs no inbound endpoint, no DNS entry and no certificate, which is what
 *   makes a one-truck haulier a first-class participant rather than a special
 *   case.
 *
 * Both are pull-recoverable: `GET /instances/{id}/events?since=` is always
 * authoritative, so nothing here has to be perfect for the system to converge.
 * That is deliberate — a delivery mechanism that *must* succeed is one whose
 * failure mode is a lost process.
 *
 * Only the **home node** delivers. A replica re-broadcasting what it received
 * would put an unverified relay in the middle of a chain whose whole value is
 * that there isn't one.
 */
import {
  filterEvent,
  rolesOf,
  type Clock,
  type EventDelivery,
  type InstanceIdentity,
  type SignedEvent,
} from '@pilots/protocol'

import type { ParticipantConfig } from '../config/config.js'
import type { ConnectionService } from '../connections/connection.service.js'
import type { DefinitionRegistry } from '../definitions/definition-registry.js'
import type { LogService } from '../logging/log.service.js'
import type { WriteNotice } from '../notifications/notification.service.js'
import type { PeerClient } from '../peer/peer-client.js'
import type { StreamMessage } from '../peer/transport.js'
import type { ConnectionDocument, InstanceDocument, Store } from '../store/store.js'
import { type StreamHub, type StreamAttachment, type StreamHandlers } from './stream-hub.js'

const BACKOFF_MS = [1_000, 5_000, 30_000, 120_000, 600_000]

/** How many events one webhook POST carries. */
const BATCH = 64

export class PeerDeliveryService {
  /**
   * Retry timing for webhook connections, in memory.
   *
   * Losing it on restart is harmless and slightly good: a connector that has
   * just come back should try its peers immediately rather than honour a backoff
   * decided before it went away.
   */
  private readonly retryAfter = new Map<string, number>()

  constructor(
    private readonly store: Store,
    private readonly connections: ConnectionService,
    private readonly client: PeerClient,
    private readonly definitions: DefinitionRegistry,
    private readonly hub: StreamHub,
    private readonly log: LogService,
    private readonly clock: Clock,
    private readonly localParticipants: () => readonly ParticipantConfig[],
  ) {}

  // ── the live path ────────────────────────────────────────────────────────

  /**
   * A write just landed. Get it to every peer in the instance.
   *
   * `stream` peers are woken and re-read from their own cursor; one that is not
   * attached picks it up when it comes back. `webhook` peers are delivered
   * inline so the common case is prompt, and a failure simply leaves the
   * connection's cursor where it was for the pump to retry.
   */
  async onWrite(notice: WriteNotice): Promise<void> {
    for (const local of this.localParticipants()) {
      const stored = await this.store.instances.get(local.id, notice.after.id)
      if (!stored || !stored.home) continue

      // Every attached peer re-reads from its own cursor. No cursor arithmetic
      // here, and therefore no way for a live push and a catch-up to disagree.
      await this.hub.wake(local.id)
      await this.pumpParticipant(local)
    }
  }

  // ── the scan loop ────────────────────────────────────────────────────────

  /** Deliver everything outstanding on every webhook connection that is due. */
  async pump(): Promise<{ delivered: number; failed: number }> {
    let delivered = 0
    let failed = 0
    for (const local of this.localParticipants()) {
      const outcome = await this.pumpParticipant(local)
      delivered += outcome.delivered
      failed += outcome.failed
    }
    return { delivered, failed }
  }

  private async pumpParticipant(
    participant: ParticipantConfig,
  ): Promise<{ delivered: number; failed: number }> {
    let delivered = 0
    let failed = 0

    for (const connection of await this.connections.list(participant.id)) {
      if (connection.outbound.channel !== 'webhook') continue
      if (connection.status !== 'ACTIVE' && connection.status !== 'DEGRADED') continue

      const due = this.retryAfter.get(connection.id)
      if (due !== undefined && due > this.clock.now()) continue

      const outcome = await this.deliverWebhook(participant, connection)
      delivered += outcome.delivered
      failed += outcome.failed
    }

    return { delivered, failed }
  }

  private async deliverWebhook(
    participant: ParticipantConfig,
    connection: ConnectionDocument,
  ): Promise<{ delivered: number; failed: number }> {
    if (connection.outbound.channel !== 'webhook') return { delivered: 0, failed: 0 }

    const batch = await this.since(participant, connection.peerDid, connection.deliveryCursor)
    if (batch.deliveries.length === 0) {
      // Nothing owed. Advancing the cursor past events this peer may not see
      // keeps the next scan from re-reading them forever.
      if (batch.cursor !== null && batch.cursor !== connection.deliveryCursor) {
        await this.store.connections.replace({ ...connection, deliveryCursor: batch.cursor })
      }
      return { delivered: 0, failed: 0 }
    }

    try {
      const response = await this.client.call(
        participant,
        { did: connection.peerDid, baseUrl: connection.peerBaseUrl },
        {
          method: 'POST',
          path: '/api/peer/v1/deliveries',
          body: { deliveries: batch.deliveries, cursor: batch.cursor },
        },
      )
      if (response.status >= 300) throw new Error(`the peer answered ${response.status}`)
    } catch (cause) {
      const attempt = (this.attempts.get(connection.id) ?? 0) + 1
      this.attempts.set(connection.id, attempt)
      this.retryAfter.set(
        connection.id,
        this.clock.now() + (BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length) - 1] ?? 600_000),
      )
      const current = await this.store.connections.get(participant.id, connection.id)
      await this.connections.markDegraded(current ?? connection, (cause as Error).message)
      await this.log.record({
        level: 'warn',
        message: `peer delivery to ${connection.peerDid} failed`,
        audit: {
          participantId: participant.id,
          category: 'peer',
          action: 'delivery.fail',
          actor: { kind: 'runtime', id: 'peer-delivery', actorRef: null },
          outcome: 'failed',
          detail: `${connection.peerDid}: ${(cause as Error).message}`,
          subject: { connection: connection.id },
        },
      })
      return { delivered: 0, failed: 1 }
    }

    this.attempts.delete(connection.id)
    this.retryAfter.delete(connection.id)

    // Cursor and health in **one** write. Advancing the cursor and then calling
    // `markHealthy` on the copy read before it would write the old cursor back.
    const current = await this.store.connections.get(participant.id, connection.id)
    if (current) {
      await this.store.connections.replace({
        ...current,
        deliveryCursor: batch.cursor,
        ...(current.status === 'DEGRADED' ? { status: 'ACTIVE' as const, lastError: null } : {}),
      })
    }

    const count = batch.deliveries.reduce((total, one) => total + one.events.length, 0)
    return { delivered: count, failed: 0 }
  }

  private readonly attempts = new Map<string, number>()

  // ── serving a peer's stream ──────────────────────────────────────────────

  /**
   * A peer attached. Replay what it missed, then keep pushing.
   *
   * This is S4a in one method: the peer reports where it got to, receives
   * everything since, verifies, and converges. No operator action, no resync
   * tool, no lost process.
   */
  async openStream(
    participant: ParticipantConfig,
    peerDid: string,
    sinceCursor: string | undefined,
    handlers: StreamHandlers,
  ): Promise<StreamAttachment> {
    return this.hub.attach({
      participantId: participant.id,
      audience: peerDid,
      handlers,
      since: sinceCursor ?? null,
      pull: async (since) => (await this.since(participant, peerDid, since)).messages,
    })
  }

  // ── what one peer may see ────────────────────────────────────────────────

  /**
   * One instance's events after `sinceSeq`, as this peer may see them.
   *
   * The `?since=` pull and every push go through this same filter. A pull and a
   * push handing a peer different bytes for one event is the kind of bug that
   * only shows up as a chain that verifies on one path and not the other.
   */
  async eventsFor(
    participant: ParticipantConfig,
    peerDid: string,
    instanceId: string,
    sinceSeq: number,
  ): Promise<EventDelivery | undefined> {
    const stored = await this.store.instances.get(participant.id, instanceId)
    if (!stored) return undefined
    const roles = rolesOf(stored.participants, peerDid)
    if (roles.length === 0) return undefined

    const definition = this.definitions.get(stored.definition)?.definition
    const events = (await this.store.events.read(participant.id, instanceId, sinceSeq)).map(
      (event) => {
        const signed: SignedEvent = {
          header: event.header,
          payload: event.payload,
          redacted: event.redacted,
          sig: event.sig,
        }
        return definition ? filterEvent(definition, signed, roles, stored.state) : signed
      },
    )
    return { instance: identityOf(stored), events }
  }

  /**
   * Everything after `sinceCursor` that this peer is entitled to, **filtered
   * exactly as a read would be**.
   *
   * The visibility filter runs here, on the way out, rather than being trusted
   * to the recipient. That is the whole of S1 step 6: `grossMass` is withheld
   * from the shipper before payment and released after, and the peer's copy of
   * the event still verifies because the header commits to the payload by hash
   * rather than containing it.
   */
  async since(
    participant: ParticipantConfig,
    peerDid: string,
    sinceCursor: string | null,
    limit = BATCH,
  ): Promise<{ deliveries: EventDelivery[]; messages: StreamMessage[]; cursor: string | null }> {
    const cursored = await this.store.events.readAll(
      participant.id,
      sinceCursor ?? undefined,
      limit,
    )

    const deliveries: EventDelivery[] = []
    const messages: StreamMessage[] = []
    const byInstance = new Map<string, EventDelivery>()
    let cursor: string | null = sinceCursor

    for (const entry of cursored) {
      cursor = entry.cursor
      const instanceId = entry.event.header.instance
      const stored = await this.store.instances.get(participant.id, instanceId)
      // Only the home node replicates outward, and only to participants.
      if (!stored || !stored.home) continue

      const roles = rolesOf(stored.participants, peerDid)
      if (roles.length === 0) continue

      const definition = this.definitions.get(stored.definition)?.definition
      const signed: SignedEvent = {
        header: entry.event.header,
        payload: entry.event.payload,
        redacted: entry.event.redacted,
        sig: entry.event.sig,
      }
      const visible = definition ? filterEvent(definition, signed, roles, stored.state) : signed
      const identity = identityOf(stored)

      /*
       * A state change can *release* a field that was withheld from an event we
       * already sent — `grossMass` becomes visible to the shipper at `PAID`.
       *
       * A replica cannot re-filter its way to a value it was never sent, so
       * entitlement beginning has to put the bytes on the wire. Carried in the
       * same message as the event that caused it, so a peer that applies the
       * state change has the payload in the same breath.
       */
      const released =
        definition && entry.event.header.to !== null
          ? await this.released(participant, instanceId, entry.event.header, roles, stored.state)
          : []

      const events = [...released, visible]
      const existing = byInstance.get(instanceId)
      if (existing) existing.events.push(...events)
      else {
        const delivery: EventDelivery = { instance: identity, events }
        byInstance.set(instanceId, delivery)
        deliveries.push(delivery)
      }

      messages.push({
        id: entry.cursor,
        event: 'delivery',
        data: { deliveries: [{ instance: identity, events }], cursor: entry.cursor },
      })
    }

    return { deliveries, messages, cursor }
  }

  /**
   * Earlier events of this instance whose visible payload just changed.
   *
   * Compared at the state *before* this event against the state after, so only
   * what actually became visible is re-sent — a long-running instance does not
   * retransmit its history on every move.
   */
  private async released(
    participant: ParticipantConfig,
    instanceId: string,
    header: { seq: number; from: string | null },
    roles: readonly string[],
    currentState: string,
  ): Promise<SignedEvent[]> {
    if (header.from === null) return []
    const stored = await this.store.instances.get(participant.id, instanceId)
    const definition = stored ? this.definitions.get(stored.definition)?.definition : undefined
    if (!definition) return []

    const earlier = await this.store.events.read(participant.id, instanceId, 0, header.seq - 1)
    const released: SignedEvent[] = []
    for (const event of earlier) {
      if (event.payload === null) continue
      const signed: SignedEvent = {
        header: event.header,
        payload: event.payload,
        redacted: event.redacted,
        sig: event.sig,
      }
      const before = filterEvent(definition, signed, roles, header.from)
      const after = filterEvent(definition, signed, roles, currentState)
      if (JSON.stringify(before.payload) !== JSON.stringify(after.payload)) released.push(after)
    }
    return released
  }
}

export function identityOf(instance: InstanceDocument): InstanceIdentity {
  return {
    id: instance.id,
    kind: instance.kind,
    definition: instance.definition,
    definitionHash: instance.definitionHash,
    participants: instance.participants,
    quotationId: instance.quotationId,
    offering: instance.offering,
    createdAt: instance.createdAt,
  }
}

export const PEER_DELIVERY = Symbol('PeerDeliveryService')
