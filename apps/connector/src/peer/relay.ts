/**
 * The relay: an integrator calls its **own** connector, always.
 *
 * It never addresses a peer and it never learns which node hosts what. The
 * definition names a *role*; only this instance's `participants` map names the
 * participant filling it; and if that participant is not one of ours, the call
 * goes over the wire with the same request shape and the same response shape as
 * if it had been served locally.
 *
 * Two things this file is careful about, and both are load-bearing:
 *
 * 1. **A business error passes through unchanged.** A 409, 422 or 403 from the
 *    home node is the integrator's problem to resolve, and rewriting it would
 *    only obscure it. A peer that did not answer is a different thing entirely
 *    and gets `peer-unreachable`. Collapsing a network fault into a business
 *    conflict makes retry logic on the integrator's side unwriteable.
 *
 * 2. **We adopt the home node's answer by replicating it**, not by trusting it.
 *    The reply is an ordinary delivery and goes through the same verifying path
 *    an unsolicited one would. Our own successful call is not a reason to skip
 *    checking the signature on what came back.
 */
import { Problem, protocolError, type ProtocolError } from '@pilots/protocol'

import type { ParticipantConfig } from '../config/config.js'
import type { ConnectionService } from '../connections/connection.service.js'
import type {
  PeerRelay,
  RelayRequest,
  ServiceResult,
  WriteOutcome,
} from '../instances/instance.service.js'
import type { LogService } from '../logging/log.service.js'
import type { ReplicationService } from '../replication/replication.service.js'
import type { Store } from '../store/store.js'
import { PeerUnreachableError, type PeerClient } from './peer-client.js'

export class Relay implements PeerRelay {
  constructor(
    private readonly store: Store,
    private readonly connections: ConnectionService,
    private readonly client: PeerClient,
    private readonly replication: ReplicationService,
    private readonly log: LogService,
    private readonly enabled: () => boolean,
  ) {}

  available(): boolean {
    return this.enabled()
  }

  async forward(input: RelayRequest): Promise<ServiceResult<WriteOutcome>> {
    const { caller, homeDid, identity, event, creating } = input

    // Every instance and transition call requires a live connection with the
    // home node. This is the gate, and there is no path around it.
    const connection = await this.connections.requireActive(caller.participant.id, homeDid)
    if (!connection.ok) return { ok: false, errors: connection.errors }

    const path = creating
      ? '/api/peer/v1/instances'
      : `/api/peer/v1/instances/${encodeURIComponent(identity.id)}/transitions`

    let response
    try {
      response = await this.client.call(
        caller.participant,
        { did: homeDid, baseUrl: connection.value.peerBaseUrl },
        {
          method: 'POST',
          path,
          body: {
            instance: identity,
            event: {
              header: event.header,
              payload: event.payload,
              redacted: event.redacted,
              sig: event.sig,
            },
          },
        },
      )
    } catch (cause) {
      const detail =
        cause instanceof PeerUnreachableError ? cause.message : `${homeDid}: ${String(cause)}`
      await this.audit(caller.participant, homeDid, identity.id, 'failed', detail)
      return {
        ok: false,
        errors: [protocolError(Problem.peerUnreachable, detail)],
        status: 502,
      }
    }

    if (response.status >= 300) {
      const errors = errorsFrom(response.body)
      await this.audit(
        caller.participant,
        homeDid,
        identity.id,
        'denied',
        `${response.status}: ${errors[0]?.detail ?? 'refused'}`,
      )
      return {
        ok: false,
        errors,
        // The peer's status verbatim. A 409 stays a 409.
        status: response.status,
        ...(seqFrom(response.body) === undefined
          ? {}
          : { conflict: { actualSeq: seqFrom(response.body)! } }),
      }
    }

    const applied = await this.replication.applyBatch(caller.participant, homeDid, response.body)
    if (!applied.ok) {
      // The home node said yes and then sent something that did not verify.
      // That is not retryable and it is not a business error; it is a peer we
      // should stop believing.
      return {
        ok: false,
        errors: [
          protocolError(
            Problem.peerResponseInvalid,
            `${homeDid} accepted the call but its reply did not verify: ${applied.errors[0]?.detail ?? ''}`,
          ),
        ],
        status: 502,
      }
    }

    const stored = await this.store.instances.get(caller.participant.id, identity.id)
    if (!stored) {
      return {
        ok: false,
        errors: [
          protocolError(
            Problem.peerResponseInvalid,
            `${homeDid} accepted the call but returned no events for ${identity.id}`,
          ),
        ],
        status: 502,
      }
    }

    await this.audit(caller.participant, homeDid, identity.id, 'ok', `now at seq ${stored.seq}`)
    const events = await this.store.events.read(
      caller.participant.id,
      identity.id,
      event.header.seq - 1,
    )
    return { ok: true, value: { instance: stored, events } }
  }

  /**
   * Browse a peer's offerings — a relayed **read**.
   *
   * Same rules as a relayed write: a live connection is required, a refusal
   * passes through, and a peer that did not answer is `peer-unreachable` rather
   * than an empty list. Reporting "no offerings" for a peer that is down would
   * be a lie an integrator cannot retry against.
   */
  async browseOfferings(
    participant: ParticipantConfig,
    peerDid: string,
  ): Promise<ServiceResult<unknown>> {
    const connection = await this.connections.requireActive(participant.id, peerDid)
    if (!connection.ok) return { ok: false, errors: connection.errors }

    try {
      const response = await this.client.call(
        participant,
        { did: peerDid, baseUrl: connection.value.peerBaseUrl },
        { method: 'GET', path: '/api/peer/v1/offerings' },
      )
      if (response.status >= 300) {
        return { ok: false, errors: errorsFrom(response.body), status: response.status }
      }
      return { ok: true, value: response.body }
    } catch (cause) {
      const detail =
        cause instanceof PeerUnreachableError ? cause.message : `${peerDid}: ${String(cause)}`
      return { ok: false, errors: [protocolError(Problem.peerUnreachable, detail)], status: 502 }
    }
  }

  /** Every relay outcome is audited with the peer DID — success and failure alike. */
  private async audit(
    participant: ParticipantConfig,
    peerDid: string,
    instanceId: string,
    outcome: 'ok' | 'denied' | 'failed',
    detail: string,
  ): Promise<void> {
    await this.log.record({
      level: outcome === 'ok' ? 'debug' : 'warn',
      message: `relay to ${peerDid} ${outcome}`,
      audit: {
        participantId: participant.id,
        category: 'peer',
        action: 'relay.forward',
        actor: { kind: 'peer', id: peerDid, actorRef: null },
        outcome,
        detail: `${peerDid}: ${detail}`,
        subject: { instance: instanceId },
      },
    })
  }
}

/**
 * Read the errors out of an RFC 7807 body so they pass through unchanged.
 *
 * The problem *type* is what survives; the status is carried separately. A body
 * we cannot read at all becomes `peer-response-invalid`, which is honest: we
 * genuinely do not know what the peer meant.
 */
function errorsFrom(body: unknown): ProtocolError[] {
  if (typeof body !== 'object' || body === null) {
    return [protocolError(Problem.peerResponseInvalid, 'the peer sent an unreadable error')]
  }
  const document = body as { type?: unknown; title?: unknown; detail?: unknown; errors?: unknown }

  if (Array.isArray(document.errors) && document.errors.length > 0) {
    return document.errors.map((entry) => {
      const error = entry as { type?: unknown; detail?: unknown; pointer?: unknown }
      return protocolError(
        typeof error.type === 'string'
          ? (error.type as ProtocolError['type'])
          : Problem.peerResponseInvalid,
        typeof error.detail === 'string' ? error.detail : 'the peer refused the call',
        typeof error.pointer === 'string' ? error.pointer : undefined,
      )
    })
  }

  const detail =
    typeof document.detail === 'string'
      ? document.detail
      : typeof document.title === 'string'
        ? document.title
        : 'the peer refused the call'
  return [
    protocolError(
      typeof document.type === 'string'
        ? (document.type as ProtocolError['type'])
        : Problem.peerResponseInvalid,
      detail,
    ),
  ]
}

function seqFrom(body: unknown): number | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const seq = (body as { seq?: unknown }).seq
  return typeof seq === 'number' && Number.isInteger(seq) ? seq : undefined
}
