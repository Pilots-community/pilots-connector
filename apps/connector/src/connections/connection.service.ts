/**
 * Connections: established once, before any process runs.
 *
 * This is what replaces a callback URL per request, and it is why delivery
 * guarantees are writeable at all — there is a standing relationship to be
 * `DEGRADED`, to accumulate events against, and to recover on. A per-request
 * callback has no state to put any of that in.
 *
 * **One connection, both directions.** There is no supplier connection and no
 * consumer connection: the same record carries A's offerings to B and B's to A.
 * If a second connection ever appears "for the other direction", a participant
 * type has leaked into the design.
 *
 * Note which surface each step sits on. Accepting is an **admin** act, because a
 * human decides who to trust; `accepted` is then a **peer** callback reporting
 * that decision. Collapsing the two would let a peer accept its own request.
 */
import {
  Problem,
  carriesTraffic,
  didWebOrigin,
  protocolError,
  type Connection,
  type DidResolver,
  type PeerDelivery,
  type ProtocolError,
} from '@pilots/protocol'

import type { ParticipantConfig } from '../config/config.js'
import type { LogService } from '../logging/log.service.js'
import { PeerUnreachableError, type PeerClient } from '../peer/peer-client.js'
import type { ConnectionDocument, Store } from '../store/store.js'

export type ConnectionResult<T> = { ok: true; value: T } | { ok: false; errors: ProtocolError[] }

/** Who performed an administrative act, for the audit entry it produces. */
export interface AdminActor {
  kind: 'adminSession' | 'apiKey' | 'peer' | 'runtime'
  id: string
  actorRef?: string | null
}

export interface RequestConnectionInput {
  peerDid: string
  peerBaseUrl: string
  displayName?: string | null
  /** How **we** want to receive the peer's events. */
  delivery: PeerDelivery
  message?: string
}

/**
 * Until the other side answers, we do not know how it wants to be delivered to.
 *
 * `stream` is the safe placeholder rather than an arbitrary one: it means "we
 * push only to a listener that has attached", so a half-open connection cannot
 * cause a delivery to an address nobody agreed to.
 */
const PENDING_DELIVERY: PeerDelivery = { channel: 'stream' }

export class ConnectionService {
  constructor(
    private readonly store: Store,
    private readonly client: PeerClient,
    private readonly resolver: DidResolver,
    private readonly log: LogService,
    private readonly now: () => string,
    private readonly nextId: () => string,
  ) {}

  // ── queries ──────────────────────────────────────────────────────────────

  async list(participantId: string): Promise<ConnectionDocument[]> {
    return this.store.connections.find(participantId, {
      sort: { field: 'createdAt', direction: 'desc' },
    })
  }

  async get(participantId: string, id: string): Promise<ConnectionDocument | undefined> {
    return this.store.connections.get(participantId, id)
  }

  /** The connection with one peer, whatever its state. Ids are shared by both sides. */
  async between(participantId: string, peerDid: string): Promise<ConnectionDocument | undefined> {
    const found = await this.store.connections.find(participantId, { where: { peerDid } })
    // A rejected connection is terminal and a new request starts a new one, so
    // several may exist for one peer. The live one is what callers mean.
    return found.find((connection) => carriesTraffic(connection.status)) ?? found[0]
  }

  /**
   * The gate every instance and transition call passes.
   *
   * `DEGRADED` still carries traffic: peer *delivery* is failing, which is an
   * operational problem, not a business one. Refusing writes because a webhook
   * is down would turn a delivery outage into a process outage.
   */
  async requireActive(
    participantId: string,
    peerDid: string,
  ): Promise<ConnectionResult<ConnectionDocument>> {
    const connection = await this.between(participantId, peerDid)
    if (!connection || !carriesTraffic(connection.status)) {
      return {
        ok: false,
        errors: [
          protocolError(
            Problem.connectionNotActive,
            connection
              ? `the connection with ${peerDid} is ${connection.status}`
              : `there is no connection with ${peerDid}`,
          ),
        ],
      }
    }
    return { ok: true, value: connection }
  }

  // ── outbound: we ask ─────────────────────────────────────────────────────

  async request(
    participant: ParticipantConfig,
    input: RequestConnectionInput,
    actor: AdminActor,
  ): Promise<ConnectionResult<ConnectionDocument>> {
    const existing = await this.between(participant.id, input.peerDid)
    if (existing && existing.status !== 'REJECTED' && existing.status !== 'REVOKED') {
      return fail(
        Problem.connectionNotActive,
        `a connection with ${input.peerDid} already exists and is ${existing.status}`,
      )
    }

    const trust = await this.checkDomainBinding(input.peerDid, input.peerBaseUrl)
    if (!trust.ok) return trust

    const now = this.now()
    const connection: ConnectionDocument = {
      id: this.nextId(),
      participantId: participant.id,
      peerDid: input.peerDid,
      peerBaseUrl: input.peerBaseUrl,
      peerDisplayName: input.displayName ?? null,
      status: 'PENDING_OUTBOUND',
      inbound: input.delivery,
      outbound: PENDING_DELIVERY,
      lastError: null,
      waitingOn: null,
      deliveryCursor: null,
      receiveCursor: null,
      createdAt: now,
      updatedAt: now,
    }
    await this.store.connections.insert(connection)

    try {
      const response = await this.client.call(
        participant,
        { did: input.peerDid, baseUrl: input.peerBaseUrl },
        {
          method: 'POST',
          path: '/api/peer/v1/connections/requests',
          body: {
            connectionId: connection.id,
            fromDid: participant.did,
            fromBaseUrl: participant.baseUrl,
            displayName: participant.displayName,
            delivery: input.delivery,
            ...(input.message === undefined ? {} : { message: input.message }),
          },
        },
      )
      if (response.status >= 300) {
        await this.store.connections.delete(participant.id, connection.id)
        await this.audit(participant.id, 'connection.request', 'denied', actor, connection, {
          problem: Problem.peerResponseInvalid,
          detail: `the peer refused the request with ${response.status}`,
        })
        return fail(
          Problem.peerResponseInvalid,
          `${input.peerDid} refused the connection request with ${response.status}`,
        )
      }
    } catch (cause) {
      // The record stays: the operator asked, and a peer that is down now may be
      // up in a minute. Deleting it would lose the intent along with the error.
      const detail = cause instanceof PeerUnreachableError ? cause.message : String(cause)
      await this.patch(connection, { lastError: detail })
      await this.audit(participant.id, 'connection.request', 'failed', actor, connection, {
        problem: Problem.peerUnreachable,
        detail,
      })
      return fail(Problem.peerUnreachable, detail)
    }

    await this.audit(participant.id, 'connection.request', 'ok', actor, connection)
    return { ok: true, value: connection }
  }

  // ── inbound: a peer asks ─────────────────────────────────────────────────

  /**
   * A peer requested a connection.
   *
   * The trust checks happen **here**, not at accept: an operator should never be
   * shown a pending request from a caller that could not prove it controls the
   * domain it claims. `did:web` is domain-bound by construction, and comparing
   * the DID's origin against the base URL it asks us to call is what turns that
   * construction into a check.
   */
  async receiveRequest(
    participant: ParticipantConfig,
    peerDid: string,
    body: {
      connectionId: string
      fromDid: string
      fromBaseUrl: string
      displayName?: string
      delivery: PeerDelivery
      message?: string
    },
    autoAccept: boolean,
  ): Promise<ConnectionResult<ConnectionDocument>> {
    if (body.fromDid !== peerDid) {
      // The bearer token proved who is calling. Claiming to be somebody else in
      // the body is the interesting attack, and it is a hard refusal.
      await this.audit(
        participant.id,
        'connection.request.inbound',
        'denied',
        { kind: 'peer', id: peerDid },
        undefined,
        {
          problem: Problem.credentialInvalid,
          detail: `token issued by ${peerDid} claims to come from ${body.fromDid}`,
        },
      )
      return fail(
        Problem.credentialInvalid,
        `this token was issued by ${peerDid}, not ${body.fromDid}`,
      )
    }

    const trust = await this.checkDomainBinding(body.fromDid, body.fromBaseUrl)
    if (!trust.ok) {
      await this.audit(
        participant.id,
        'connection.request.inbound',
        'denied',
        { kind: 'peer', id: peerDid },
        undefined,
        {
          problem: Problem.credentialInvalid,
          detail: trust.errors[0]?.detail ?? 'trust check failed',
        },
      )
      return trust
    }

    const existing = await this.store.connections.get(participant.id, body.connectionId)
    if (existing) return { ok: true, value: existing }

    const now = this.now()
    const connection: ConnectionDocument = {
      id: body.connectionId,
      participantId: participant.id,
      peerDid: body.fromDid,
      peerBaseUrl: body.fromBaseUrl,
      peerDisplayName: body.displayName ?? null,
      status: 'PENDING_INBOUND',
      // They told us how they want to receive; that is how we deliver to them.
      outbound: body.delivery,
      inbound: PENDING_DELIVERY,
      lastError: null,
      waitingOn: null,
      deliveryCursor: null,
      receiveCursor: null,
      createdAt: now,
      updatedAt: now,
    }
    await this.store.connections.insert(connection)
    await this.audit(
      participant.id,
      'connection.request.inbound',
      'ok',
      {
        kind: 'peer',
        id: peerDid,
      },
      connection,
    )

    if (autoAccept) {
      return this.accept(
        participant,
        connection.id,
        { channel: 'stream' },
        { kind: 'runtime', id: 'auto-accept' },
      )
    }
    return { ok: true, value: connection }
  }

  // ── the decision ─────────────────────────────────────────────────────────

  /**
   * Our operator approves. We go `ACTIVE` locally, then tell the peer.
   *
   * The local state changes first on purpose: if the callback fails, we are
   * reachable and the peer can retry or pull, whereas the reverse leaves a peer
   * believing in a connection we have no record of.
   */
  async accept(
    participant: ParticipantConfig,
    connectionId: string,
    delivery: PeerDelivery,
    actor: AdminActor,
  ): Promise<ConnectionResult<ConnectionDocument>> {
    const connection = await this.store.connections.get(participant.id, connectionId)
    if (!connection) return fail(Problem.notAParticipant, `no connection ${connectionId}`)
    if (connection.status !== 'PENDING_INBOUND') {
      return fail(
        Problem.connectionNotActive,
        `only a PENDING_INBOUND connection can be accepted; this one is ${connection.status}`,
      )
    }

    const accepted = await this.patch(connection, { status: 'ACTIVE', inbound: delivery })
    await this.audit(participant.id, 'connection.accept', 'ok', actor, accepted)

    try {
      await this.client.call(
        participant,
        { did: connection.peerDid, baseUrl: connection.peerBaseUrl },
        {
          method: 'POST',
          path: `/api/peer/v1/connections/${connection.id}/accepted`,
          body: { delivery },
        },
      )
    } catch (cause) {
      // Accepted here, unannounced there. `DEGRADED` says exactly that, and the
      // peer's own `?since=` pull is the recovery path.
      const detail = cause instanceof PeerUnreachableError ? cause.message : String(cause)
      return {
        ok: true,
        value: await this.patch(accepted, { status: 'DEGRADED', lastError: detail }),
      }
    }

    return { ok: true, value: accepted }
  }

  async reject(
    participant: ParticipantConfig,
    connectionId: string,
    reason: string | undefined,
    actor: AdminActor,
  ): Promise<ConnectionResult<ConnectionDocument>> {
    const connection = await this.store.connections.get(participant.id, connectionId)
    if (!connection) return fail(Problem.notAParticipant, `no connection ${connectionId}`)

    const rejected = await this.patch(connection, { status: 'REJECTED' })
    await this.audit(participant.id, 'connection.reject', 'ok', actor, rejected, {
      detail: reason ?? null,
    })

    try {
      await this.client.call(
        participant,
        { did: connection.peerDid, baseUrl: connection.peerBaseUrl },
        {
          method: 'POST',
          path: `/api/peer/v1/connections/${connection.id}/rejected`,
          body: reason === undefined ? {} : { reason },
        },
      )
    } catch {
      // A peer that cannot be told it was rejected is not our problem to solve.
    }
    return { ok: true, value: rejected }
  }

  /**
   * Either side ends it. Existing instances become read-only rather than
   * disappearing — history is not deleted, and a process that ran is a fact.
   */
  async revoke(
    participant: ParticipantConfig,
    connectionId: string,
    actor: AdminActor,
  ): Promise<ConnectionResult<ConnectionDocument>> {
    const connection = await this.store.connections.get(participant.id, connectionId)
    if (!connection) return fail(Problem.notAParticipant, `no connection ${connectionId}`)

    const revoked = await this.patch(connection, { status: 'REVOKED' })
    await this.audit(participant.id, 'connection.revoke', 'ok', actor, revoked)
    return { ok: true, value: revoked }
  }

  // ── the peer reports back ────────────────────────────────────────────────

  async receiveAccepted(
    participant: ParticipantConfig,
    peerDid: string,
    connectionId: string,
    delivery: PeerDelivery,
  ): Promise<ConnectionResult<ConnectionDocument>> {
    const connection = await this.store.connections.get(participant.id, connectionId)
    if (!connection || connection.peerDid !== peerDid) {
      return fail(Problem.notAParticipant, `no connection ${connectionId} with ${peerDid}`)
    }
    if (connection.status !== 'PENDING_OUTBOUND' && connection.status !== 'DEGRADED') {
      return fail(
        Problem.connectionNotActive,
        `this connection is ${connection.status}, not awaiting an answer`,
      )
    }

    const active = await this.patch(connection, {
      status: 'ACTIVE',
      outbound: delivery,
      lastError: null,
      waitingOn: null,
    })
    await this.audit(
      participant.id,
      'connection.accepted',
      'ok',
      { kind: 'peer', id: peerDid },
      active,
    )
    return { ok: true, value: active }
  }

  async receiveRejected(
    participant: ParticipantConfig,
    peerDid: string,
    connectionId: string,
    reason: string | undefined,
  ): Promise<ConnectionResult<ConnectionDocument>> {
    const connection = await this.store.connections.get(participant.id, connectionId)
    if (!connection || connection.peerDid !== peerDid) {
      return fail(Problem.notAParticipant, `no connection ${connectionId} with ${peerDid}`)
    }

    const rejected = await this.patch(connection, {
      status: 'REJECTED',
      lastError: reason ?? null,
    })
    await this.audit(
      participant.id,
      'connection.rejected',
      'ok',
      { kind: 'peer', id: peerDid },
      rejected,
      { detail: reason ?? null },
    )
    return { ok: true, value: rejected }
  }

  // ── delivery health ──────────────────────────────────────────────────────

  /** Peer delivery is failing. Events accumulate; the business process carries on. */
  async markDegraded(connection: ConnectionDocument, error: string): Promise<ConnectionDocument> {
    if (connection.status !== 'ACTIVE' && connection.status !== 'DEGRADED') return connection
    return this.patch(connection, { status: 'DEGRADED', lastError: error })
  }

  async markHealthy(connection: ConnectionDocument): Promise<ConnectionDocument> {
    if (connection.status !== 'DEGRADED') return connection
    return this.patch(connection, { status: 'ACTIVE', lastError: null })
  }

  /** Seed a connection from configuration, as the demo may. The handshake still works. */
  async seed(
    participant: ParticipantConfig,
    seedInput: {
      peerDid: string
      peerBaseUrl: string
      displayName?: string | null
      inbound: PeerDelivery
      outbound: PeerDelivery
    },
  ): Promise<ConnectionDocument> {
    const existing = await this.between(participant.id, seedInput.peerDid)
    if (existing) return existing

    const now = this.now()
    const connection: ConnectionDocument = {
      id: this.nextId(),
      participantId: participant.id,
      peerDid: seedInput.peerDid,
      peerBaseUrl: seedInput.peerBaseUrl,
      peerDisplayName: seedInput.displayName ?? null,
      status: 'ACTIVE',
      inbound: seedInput.inbound,
      outbound: seedInput.outbound,
      lastError: null,
      waitingOn: null,
      deliveryCursor: null,
      receiveCursor: null,
      createdAt: now,
      updatedAt: now,
    }
    await this.store.connections.upsert(connection)
    return connection
  }

  // ── plumbing ─────────────────────────────────────────────────────────────

  /**
   * The check that makes `did:web` worth using.
   *
   * A DID document lives at a URL derived from the DID itself, so controlling
   * the DID means controlling the domain. Confirming the base URL a caller wants
   * us to talk to sits on that same origin is what stops a peer from proving one
   * identity and pointing us at another host.
   */
  private async checkDomainBinding(did: string, baseUrl: string): Promise<ConnectionResult<true>> {
    let claimed: string
    try {
      claimed = new URL(baseUrl).origin
    } catch {
      return fail(Problem.credentialInvalid, `${baseUrl} is not a URL`, '/peerBaseUrl')
    }

    let bound: string
    try {
      bound = didWebOrigin(did)
    } catch (cause) {
      return fail(Problem.credentialInvalid, (cause as Error).message, '/peerDid')
    }
    if (bound !== claimed) {
      return fail(
        Problem.credentialInvalid,
        `${did} is bound to ${bound} but claims a base URL at ${claimed}`,
        '/peerBaseUrl',
      )
    }

    const document = await this.resolver.resolve(did)
    if (!document) return fail(Problem.credentialInvalid, `${did} does not resolve`, '/peerDid')
    if (document.id !== did) {
      return fail(
        Problem.credentialInvalid,
        `the document at ${did} identifies itself as ${document.id}`,
        '/peerDid',
      )
    }
    return { ok: true, value: true }
  }

  private async patch(
    connection: ConnectionDocument,
    changes: Partial<Connection>,
  ): Promise<ConnectionDocument> {
    const updated: ConnectionDocument = { ...connection, ...changes, updatedAt: this.now() }
    await this.store.connections.replace(updated)
    return updated
  }

  private async audit(
    participantId: string,
    action: string,
    outcome: 'ok' | 'denied' | 'failed',
    actor: AdminActor,
    connection?: ConnectionDocument,
    extra: { problem?: string; detail?: string | null } = {},
  ): Promise<void> {
    const peer = connection?.peerDid ?? null
    const detail =
      extra.detail === undefined || extra.detail === null
        ? peer && `peer ${peer}`
        : peer
          ? `peer ${peer}: ${extra.detail}`
          : extra.detail
    await this.log.record({
      level: outcome === 'ok' ? 'info' : 'warn',
      message: `${action} ${outcome}`,
      audit: {
        participantId,
        category: 'admin',
        action,
        actor: { kind: actor.kind, id: actor.id, actorRef: actor.actorRef ?? null },
        outcome,
        problem: extra.problem ?? null,
        detail: detail || null,
        // The audit subject names our own records; the peer DID belongs in
        // `detail`, where it is readable without inventing a subject field that
        // only connections would ever use.
        subject: { connection: connection?.id ?? null },
        request: null,
      },
    })
  }
}

function fail(
  type: ProtocolError['type'],
  detail: string,
  pointer?: string,
): ConnectionResult<never> {
  return { ok: false, errors: [protocolError(type, detail, pointer)] }
}

export const CONNECTIONS = Symbol('ConnectionService')
