/**
 * `/api/peer/v1` — the node-to-node surface, as a plain function.
 *
 * The Nest controller is a thin adapter over this and the in-process transport
 * calls it directly, so a scenario test and a container run go through the
 * **same** authentication, the same routing and the same handlers. Only the
 * bytes in between differ. If any check lived in the HTTP layer instead, the
 * hermetic tests would be proving something weaker than what ships — and S4d,
 * which is entirely about refusals, would be theatre.
 *
 * Authentication is a bearer JWS, `did:web`-resolved, checked for audience,
 * expiry, lifetime and replay. **Every rejection is audited**, with the peer's
 * DID where one could be read, because a refused request produces no business
 * event and would otherwise leave no trace at all.
 */
import { z } from 'zod'

import {
  InstanceIdentity,
  Problem,
  PeerTokenClaims,
  SignedEvent,
  statusFor,
  verifyPeerToken,
  type Clock,
  type DidResolver,
  type PeerDelivery,
  type ProtocolError,
} from '@pilots/protocol'

import type { ParticipantConfig } from '../config/config.js'
import type { ConnectionService } from '../connections/connection.service.js'
import type { PeerDeliveryService } from '../delivery/peer-delivery.service.js'
import type { DefinitionRegistry } from '../definitions/definition-registry.js'
import type { InstanceService } from '../instances/instance.service.js'
import type { LogService } from '../logging/log.service.js'
import type { ReplicationService } from '../replication/replication.service.js'
import type { Store } from '../store/store.js'
import type { StreamHandlers } from '../delivery/stream-hub.js'
import { titleFor } from '../http/problem-titles.js'
import type { PeerReplayCache } from './replay-cache.js'
import {
  splitPath,
  type PeerRequest,
  type PeerResponse,
  type PeerServer,
  type StreamSubscription,
} from './transport.js'

const PREFIX = '/api/peer/v1'

/** Who is calling, once the bearer token has been verified. */
interface PeerCaller {
  /** The local participant the token was addressed to. */
  participant: ParticipantConfig
  peerDid: string
  jti: string
}

export interface PeerServerDeps {
  store: Store
  instances: InstanceService
  connections: ConnectionService
  replication: ReplicationService
  delivery: PeerDeliveryService
  definitions: DefinitionRegistry
  resolver: DidResolver
  replay: PeerReplayCache
  log: LogService
  clock: Clock
  participants: () => readonly ParticipantConfig[]
  /** Peers whose connection requests are accepted without asking the operator. */
  autoAccept: (participantId: string, peerDid: string) => Promise<boolean>
}

export class PeerSurface implements PeerServer {
  constructor(private readonly deps: PeerServerDeps) {}

  async handle(request: PeerRequest): Promise<PeerResponse> {
    const authenticated = await this.authenticate(request)
    if ('status' in authenticated) return authenticated

    try {
      return await this.route(authenticated, request)
    } catch (cause) {
      this.deps.log.error(
        { err: (cause as Error).message, path: request.path },
        'peer request failed',
      )
      return problem(500, [
        { type: Problem.peerResponseInvalid, detail: 'the peer surface failed to handle the call' },
      ])
    }
  }

  /**
   * `GET /stream` — the channel a party with no inbound endpoint uses.
   *
   * Returns a `PeerResponse` when the call is refused, so a caller can tell "you
   * may not have this stream" from "the connector is unreachable". Collapsing
   * the two would make an auth mistake look like an outage forever.
   */
  async open(
    request: PeerRequest,
    handlers: StreamHandlers,
  ): Promise<StreamSubscription | PeerResponse> {
    const authenticated = await this.authenticate(request)
    if ('status' in authenticated) return authenticated

    const { pathname, query } = splitPath(request.path)
    if (pathname !== `${PREFIX}/stream`) {
      return problem(404, [{ type: Problem.notAParticipant, detail: `no stream at ${pathname}` }])
    }

    const active = await this.deps.connections.requireActive(
      authenticated.participant.id,
      authenticated.peerDid,
    )
    if (!active.ok) return problem(statusFor(active.errors), active.errors)

    const since = header(request, 'last-event-id') ?? query.get('since') ?? undefined
    const attachment = await this.deps.delivery.openStream(
      authenticated.participant,
      authenticated.peerDid,
      since,
      handlers,
    )
    return { close: () => attachment.close() }
  }

  // ── authentication ───────────────────────────────────────────────────────

  private async authenticate(request: PeerRequest): Promise<PeerCaller | PeerResponse> {
    const authorization = header(request, 'authorization')
    const token = authorization?.startsWith('Bearer ')
      ? authorization.slice('Bearer '.length).trim()
      : undefined

    if (token === undefined || token === '') {
      await this.refused(null, null, request, 'no bearer token was presented')
      return problem(401, [
        { type: Problem.credentialInvalid, detail: 'a peer bearer token is required' },
      ])
    }

    // Which of our participants is this addressed to? Read unverified, then
    // *checked* by the verifier against the audience we pass it — peeking only
    // decides whose inbox to open, never whether to trust anything.
    const claimed = peekAudience(token)
    const participant = this.deps.participants().find((candidate) => candidate.did === claimed)
    if (!participant) {
      await this.refused(null, null, request, `no participant here answers to ${String(claimed)}`)
      return problem(401, [
        { type: Problem.credentialInvalid, detail: 'this token is addressed elsewhere' },
      ])
    }

    const verified = await verifyPeerToken(token, {
      resolver: this.deps.resolver,
      audience: participant.did,
      nowMs: this.deps.clock.now(),
      seenJti: (seen) => this.deps.replay.seen(seen),
    })
    if (!verified.ok) {
      await this.refused(
        participant.id,
        verified.error.iss,
        request,
        `${verified.error.reason}: ${verified.error.detail}`,
        verified.error.jti,
      )
      return problem(401, [
        { type: Problem.credentialInvalid, detail: 'the peer token did not verify' },
      ])
    }

    return { participant, peerDid: verified.value.iss, jti: verified.value.jti }
  }

  private async refused(
    participantId: string | null,
    peerDid: string | null,
    request: PeerRequest,
    detail: string,
    jti: string | null = null,
  ): Promise<void> {
    await this.deps.log.record({
      level: 'warn',
      message: `peer request refused: ${detail}`,
      audit: {
        participantId: participantId ?? this.deps.participants()[0]?.id ?? 'unknown',
        category: 'peer',
        action: 'auth.peer',
        actor: { kind: 'peer', id: peerDid ?? 'unknown', actorRef: null },
        outcome: 'denied',
        problem: Problem.credentialInvalid,
        detail,
        request: {
          method: request.method,
          path: request.path,
          ip: null,
          // So a replay can be traced back to the token that was reused.
          jti,
        },
      },
    })
  }

  // ── routing ──────────────────────────────────────────────────────────────

  private async route(caller: PeerCaller, request: PeerRequest): Promise<PeerResponse> {
    const { pathname, query } = splitPath(request.path)
    if (!pathname.startsWith(`${PREFIX}/`)) {
      return problem(404, [{ type: Problem.notAParticipant, detail: `no route ${pathname}` }])
    }
    const segments = pathname.slice(PREFIX.length + 1).split('/')
    const [head, second, third] = segments

    if (head === 'connections' && request.method === 'POST') {
      if (second === 'requests') return this.connectionRequest(caller, request.body)
      if (second !== undefined && third === 'accepted') {
        return this.connectionAccepted(caller, second, request.body)
      }
      if (second !== undefined && third === 'rejected') {
        return this.connectionRejected(caller, second, request.body)
      }
    }

    // Everything below this line is process traffic, and every bit of it
    // requires a live connection. There is no privileged path around it.
    const active = await this.deps.connections.requireActive(caller.participant.id, caller.peerDid)
    if (!active.ok) {
      // Authenticated and still refused. No event is produced by this, so
      // without an audit entry there would be no record it happened at all.
      await this.deps.log.record({
        level: 'warn',
        message: `peer traffic refused: ${active.errors[0]?.detail ?? 'no connection'}`,
        audit: {
          participantId: caller.participant.id,
          category: 'peer',
          action: 'connection.gate',
          actor: { kind: 'peer', id: caller.peerDid, actorRef: null },
          outcome: 'denied',
          problem: active.errors[0]?.type ?? null,
          detail: active.errors[0]?.detail ?? null,
          request: { method: request.method, path: request.path, ip: null, jti: caller.jti },
        },
      })
      return problem(statusFor(active.errors), active.errors)
    }

    if (head === 'deliveries' && request.method === 'POST') {
      return this.deliveries(caller, request.body)
    }
    if (head === 'offerings' && request.method === 'GET') return this.offerings(caller)
    if (head === 'definitions' && request.method === 'GET' && second !== undefined) {
      return this.definition(decodeURIComponent(second))
    }
    if (head === 'instances') {
      if (request.method === 'POST' && second === undefined) {
        return this.createInstance(caller, request.body)
      }
      if (request.method === 'POST' && second !== undefined && third === 'transitions') {
        return this.transition(caller, second, request.body)
      }
      if (request.method === 'GET' && second !== undefined && third === 'events') {
        return this.events(caller, second, query.get('since'))
      }
      if (request.method === 'GET' && second !== undefined) {
        return this.instance(caller, second)
      }
    }

    return problem(404, [
      { type: Problem.notAParticipant, detail: `no route ${request.method} ${pathname}` },
    ])
  }

  // ── the handshake ────────────────────────────────────────────────────────

  private async connectionRequest(caller: PeerCaller, body: unknown): Promise<PeerResponse> {
    const parsed = body as {
      connectionId: string
      fromDid: string
      fromBaseUrl: string
      displayName?: string
      delivery: PeerDelivery
      message?: string
    }
    const auto = await this.deps.autoAccept(caller.participant.id, caller.peerDid)
    const result = await this.deps.connections.receiveRequest(
      caller.participant,
      caller.peerDid,
      parsed,
      auto,
    )
    if (!result.ok) return problem(statusFor(result.errors), result.errors)
    // 202: we have it, a human has not decided yet. That distinction is the
    // point of the handshake existing.
    return json(result.value.status === 'ACTIVE' ? 200 : 202, {
      connection: { id: result.value.id, status: result.value.status },
    })
  }

  private async connectionAccepted(
    caller: PeerCaller,
    connectionId: string,
    body: unknown,
  ): Promise<PeerResponse> {
    const delivery = (body as { delivery: PeerDelivery }).delivery
    const result = await this.deps.connections.receiveAccepted(
      caller.participant,
      caller.peerDid,
      connectionId,
      delivery,
    )
    if (!result.ok) return problem(statusFor(result.errors), result.errors)
    return json(200, { connection: { id: result.value.id, status: result.value.status } })
  }

  private async connectionRejected(
    caller: PeerCaller,
    connectionId: string,
    body: unknown,
  ): Promise<PeerResponse> {
    const reason = (body as { reason?: string } | undefined)?.reason
    const result = await this.deps.connections.receiveRejected(
      caller.participant,
      caller.peerDid,
      connectionId,
      reason,
    )
    if (!result.ok) return problem(statusFor(result.errors), result.errors)
    return json(200, { connection: { id: result.value.id, status: result.value.status } })
  }

  // ── process traffic ──────────────────────────────────────────────────────

  private async createInstance(caller: PeerCaller, body: unknown): Promise<PeerResponse> {
    const parsed = InstanceWrite.safeParse(body)
    if (!parsed.success) return schemaProblem(parsed.error.issues)

    const result = await this.deps.instances.applySigned({
      home: caller.participant,
      actorDid: caller.peerDid,
      identity: parsed.data.instance,
      event: parsed.data.event,
      creating: true,
    })
    if (!result.ok) return this.writeFailed(caller, result)

    return {
      status: 201,
      headers: {
        etag: `"${result.value.instance.seq}"`,
        location: `${PREFIX}/instances/${result.value.instance.id}`,
      },
      body: await this.writeBody(caller, result.value.instance.id, 0),
    }
  }

  private async transition(
    caller: PeerCaller,
    instanceId: string,
    body: unknown,
  ): Promise<PeerResponse> {
    const parsed = InstanceWrite.safeParse(body)
    if (!parsed.success) return schemaProblem(parsed.error.issues)
    if (parsed.data.instance.id !== instanceId) {
      return problem(422, [
        { type: Problem.chainBroken, detail: 'the event does not belong to that instance' },
      ])
    }

    const submitted = parsed.data.event.header.seq
    const result = await this.deps.instances.applySigned({
      home: caller.participant,
      actorDid: caller.peerDid,
      identity: parsed.data.instance,
      event: parsed.data.event,
      creating: false,
    })
    if (!result.ok) return this.writeFailed(caller, result)

    return {
      status: 200,
      headers: { etag: `"${result.value.instance.seq}"` },
      body: await this.writeBody(caller, instanceId, submitted - 1),
    }
  }

  /**
   * What the caller gets back: the events **as it may see them**, in the same
   * shape a delivery uses, so it converges by replicating its own reply.
   *
   * Filtered through the peer's read path rather than answered from what we just
   * wrote. A write must never become a way to read a field a read would
   * withhold, and answering from the home node's copy is exactly how that leaks.
   *
   * It carries the events the write produced *and* any that followed, because an
   * `auto` transition fires here and the caller would otherwise be a step behind
   * its own successful call.
   */
  private async writeBody(
    caller: PeerCaller,
    instanceId: string,
    sinceSeq: number,
  ): Promise<unknown> {
    const delivery = await this.deps.delivery.eventsFor(
      caller.participant,
      caller.peerDid,
      instanceId,
      sinceSeq,
    )
    return { deliveries: delivery ? [delivery] : [], cursor: null }
  }

  private async writeFailed(
    caller: PeerCaller,
    result: { errors: ProtocolError[]; conflict?: { actualSeq: number } },
  ): Promise<PeerResponse> {
    const status = statusFor(result.errors)
    await this.deps.log.record({
      level: 'warn',
      message: 'peer write refused',
      audit: {
        participantId: caller.participant.id,
        category: 'peer',
        action: 'transition.apply',
        actor: { kind: 'peer', id: caller.peerDid, actorRef: null },
        outcome: 'denied',
        problem: result.errors[0]?.type ?? null,
        detail: result.errors[0]?.detail ?? null,
      },
    })
    return problem(status, result.errors, result.conflict)
  }

  private async deliveries(caller: PeerCaller, body: unknown): Promise<PeerResponse> {
    const result = await this.deps.replication.applyBatch(caller.participant, caller.peerDid, body)
    if (!result.ok) return problem(statusFor(result.errors), result.errors)
    return json(200, { applied: result.value })
  }

  private async instance(caller: PeerCaller, instanceId: string): Promise<PeerResponse> {
    const view = await this.deps.instances.readForPeer(
      caller.participant,
      caller.peerDid,
      instanceId,
    )
    // A 404 covers both "no such instance" and "one you may not see". Telling
    // the two apart is an enumeration oracle.
    if (!view) return problem(404, [{ type: Problem.notAParticipant, detail: 'no such instance' }])
    return {
      status: 200,
      headers: { etag: `"${view.instance.seq}"` },
      body: { ...view.instance, redacted: view.redacted },
    }
  }

  private async events(
    caller: PeerCaller,
    instanceId: string,
    since: string | null,
  ): Promise<PeerResponse> {
    const sinceSeq = since === null ? 0 : Number(since)
    if (!Number.isInteger(sinceSeq) || sinceSeq < 0) {
      return problem(400, [
        { type: Problem.schemaInvalid, detail: 'since must be a non-negative integer' },
      ])
    }

    // The authoritative recovery path. Filtered for the caller exactly as a
    // delivery would be, through the same code, so a pull and a push can never
    // hand a peer different bytes for one event.
    const batch = await this.deps.delivery.eventsFor(
      caller.participant,
      caller.peerDid,
      instanceId,
      sinceSeq,
    )
    if (!batch) {
      return problem(404, [{ type: Problem.notAParticipant, detail: 'no such instance' }])
    }
    return json(200, { deliveries: [batch], cursor: null })
  }

  private async offerings(caller: PeerCaller): Promise<PeerResponse> {
    const offerings = await this.deps.store.offerings.find(caller.participant.id, {
      where: { status: 'PUBLISHED' },
    })
    return json(200, { offerings })
  }

  private definition(ref: string): PeerResponse {
    const registered = this.deps.definitions.get(ref)
    if (!registered) {
      return problem(404, [{ type: Problem.definitionInvalid, detail: `no definition ${ref}` }])
    }
    return json(200, {
      ref: registered.ref,
      contentHash: registered.contentHash,
      definition: registered.raw,
    })
  }
}

/** The one write shape the peer surface accepts: an identity plus a signed event. */
const InstanceWrite = z.strictObject({
  instance: InstanceIdentity,
  event: SignedEvent,
})

// ── helpers ────────────────────────────────────────────────────────────────

function header(request: PeerRequest, name: string): string | undefined {
  for (const [key, value] of Object.entries(request.headers)) {
    if (key.toLowerCase() === name) return value
  }
  return undefined
}

/** Read `aud` without trusting it: it only decides whose key checks the rest. */
function peekAudience(token: string): string | undefined {
  const payload = token.split('.')[1]
  if (payload === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    const claims = PeerTokenClaims.partial().safeParse(parsed)
    return claims.success ? claims.data.aud : undefined
  } catch {
    return undefined
  }
}

function schemaProblem(issues: readonly { message: string; path: PropertyKey[] }[]): PeerResponse {
  return problem(
    422,
    issues.map((issue) => ({
      type: Problem.schemaInvalid,
      detail: issue.message,
      pointer: `/${issue.path.join('/')}`,
    })),
  )
}

function json(status: number, body: unknown): PeerResponse {
  return { status, headers: { 'content-type': 'application/json' }, body }
}

/** RFC 7807, on this surface exactly as on the other two. */
function problem(
  status: number,
  errors: readonly { type: string; detail: string; pointer?: string }[],
  conflict?: { actualSeq: number },
): PeerResponse {
  const first = errors[0]
  const type = first?.type ?? Problem.peerResponseInvalid
  return {
    status,
    headers: { 'content-type': 'application/problem+json' },
    body: {
      type,
      title: titleFor(type),
      status,
      ...(first?.detail === undefined ? {} : { detail: first.detail }),
      ...(errors.length > 1 ? { errors: errors.map((error) => ({ ...error })) } : {}),
      ...(conflict === undefined ? {} : { seq: conflict.actualSeq }),
    },
  }
}

export const PEER_SERVER = Symbol('PeerServer')
