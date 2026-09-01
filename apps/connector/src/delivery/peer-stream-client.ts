/**
 * The other end of `stream` delivery: we dial out and hold the line open.
 *
 * This is what makes a one-truck haulier a first-class participant. It needs no
 * inbound endpoint, no DNS entry, no certificate and no firewall change — it
 * holds one outbound connection to each peer, and everything arrives down it.
 *
 * Recovery is the interesting part, and it is deliberately dull: when a line
 * drops we reattach and send `Last-Event-ID`, the peer replays everything after
 * it, and every event goes through the same verification an unsolicited
 * delivery would. There is no resync tool and no operator step, because the
 * cursor and the verified chain between them make one unnecessary. That is S4a.
 */
import { carriesTraffic } from '@pilots/protocol'

import type { ParticipantConfig } from '../config/config.js'
import type { ConnectionService } from '../connections/connection.service.js'
import type { LogService } from '../logging/log.service.js'
import { PeerUnreachableError, type PeerClient } from '../peer/peer-client.js'
import type { StreamSubscription } from '../peer/transport.js'
import type { ReplicationService } from '../replication/replication.service.js'
import type { Store } from '../store/store.js'

interface Held {
  subscription: StreamSubscription
  /** Serialises applies, so two messages cannot be replicated out of order. */
  queue: Promise<void>
}

export class PeerStreamClient {
  private readonly held = new Map<string, Held>()

  constructor(
    private readonly store: Store,
    private readonly connections: ConnectionService,
    private readonly client: PeerClient,
    private readonly replication: ReplicationService,
    private readonly log: LogService,
    private readonly localParticipants: () => readonly ParticipantConfig[],
  ) {}

  /**
   * Attach where we should be attached and are not.
   *
   * Called at boot and on every tick, so a line that dropped comes back without
   * anyone noticing it went. Idempotent by construction: a connection we already
   * hold is skipped.
   */
  async sync(): Promise<void> {
    for (const participant of this.localParticipants()) {
      for (const connection of await this.connections.list(participant.id)) {
        if (connection.inbound.channel !== 'stream') continue
        if (!carriesTraffic(connection.status)) {
          this.drop(connection.id)
          continue
        }
        if (this.held.has(connection.id)) continue
        await this.attach(participant, connection.id)
      }
    }
  }

  private async attach(participant: ParticipantConfig, connectionId: string): Promise<void> {
    const connection = await this.store.connections.get(participant.id, connectionId)
    if (!connection) return

    const state: Held = { subscription: { close: () => {} }, queue: Promise.resolve() }
    // Registered before the call so a message arriving during the handshake has
    // somewhere to queue against.
    this.held.set(connectionId, state)

    try {
      state.subscription = await this.client.open(
        participant,
        { did: connection.peerDid, baseUrl: connection.peerBaseUrl },
        '/api/peer/v1/stream',
        {
          onMessage: (message) => {
            state.queue = state.queue.then(() =>
              this.receive(participant, connection.peerDid, connectionId, message.id, message.data),
            )
          },
          onClose: () => {
            // Just forget it. The next `sync()` reattaches and sends
            // `Last-Event-ID`; treating a dropped line as an error would make an
            // ordinary reconnect look like a fault.
            this.held.delete(connectionId)
          },
        },
        connection.receiveCursor === null ? {} : { 'last-event-id': connection.receiveCursor },
      )
    } catch (cause) {
      this.held.delete(connectionId)
      const detail = cause instanceof PeerUnreachableError ? cause.message : String(cause)
      await this.connections.markDegraded(connection, detail)
      return
    }

    const healthy = await this.store.connections.get(participant.id, connectionId)
    if (healthy) await this.connections.markHealthy(healthy)
  }

  private async receive(
    participant: ParticipantConfig,
    peerDid: string,
    connectionId: string,
    cursor: string,
    data: unknown,
  ): Promise<void> {
    const applied = await this.replication.applyBatch(participant, peerDid, data)
    if (!applied.ok) {
      // A hard stop. A chain that does not verify means the peer rewrote
      // history, and carrying on down the same line would apply whatever came
      // next on top of a record we have just refused.
      await this.log.record({
        level: 'error',
        message: `stream from ${peerDid} rejected: ${applied.errors[0]?.detail ?? ''}`,
        audit: {
          participantId: participant.id,
          category: 'peer',
          action: 'delivery.fail',
          actor: { kind: 'peer', id: peerDid, actorRef: null },
          outcome: 'failed',
          problem: applied.errors[0]?.type ?? null,
          detail: applied.errors[0]?.detail ?? null,
          subject: { connection: connectionId },
        },
      })
      this.drop(connectionId)
      const connection = await this.store.connections.get(participant.id, connectionId)
      if (connection) {
        await this.connections.markDegraded(
          connection,
          applied.errors[0]?.detail ?? 'a delivery did not verify',
        )
      }
      return
    }

    // A gap means the push skipped ahead of us. The pull endpoint is
    // authoritative, so close it by pulling rather than by guessing.
    for (const outcome of applied.value) {
      if (outcome.gapFrom === undefined) continue
      await this.pull(participant, peerDid, outcome.instanceId, outcome.gapFrom)
    }

    const connection = await this.store.connections.get(participant.id, connectionId)
    if (connection) {
      await this.store.connections.replace({ ...connection, receiveCursor: cursor })
    }
  }

  /**
   * `GET /instances/{id}/events?since=` — the authoritative recovery path.
   *
   * Everything else in delivery is best-effort precisely because this exists.
   */
  async pull(
    participant: ParticipantConfig,
    peerDid: string,
    instanceId: string,
    sinceSeq: number,
  ): Promise<void> {
    const connection = await this.connections.between(participant.id, peerDid)
    if (!connection) return

    try {
      const response = await this.client.call(
        participant,
        { did: peerDid, baseUrl: connection.peerBaseUrl },
        {
          method: 'GET',
          path: `/api/peer/v1/instances/${encodeURIComponent(instanceId)}/events?since=${sinceSeq}`,
        },
      )
      if (response.status >= 300) return
      await this.replication.applyBatch(participant, peerDid, response.body)
    } catch {
      // Unreachable now; the next tick tries again. A pull that fails costs
      // nothing, because the events are still on the peer.
    }
  }

  private drop(connectionId: string): void {
    const held = this.held.get(connectionId)
    if (!held) return
    this.held.delete(connectionId)
    held.subscription.close()
  }

  /** Settle every in-flight apply. What a test awaits instead of sleeping. */
  async quiesce(): Promise<void> {
    await Promise.all([...this.held.values()].map((held) => held.queue))
  }

  closeAll(): void {
    for (const id of [...this.held.keys()]) this.drop(id)
  }

  get attached(): number {
    return this.held.size
  }
}
