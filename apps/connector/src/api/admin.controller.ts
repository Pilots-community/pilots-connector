/**
 * `/api/admin/v1` — for operating your own connector.
 *
 * Everything here is an administrative act and everything here is audited, with
 * the admin session that did it.
 *
 * What this surface deliberately does **not** cover: starting processes,
 * applying transitions, or reading business data. Those are the local API's job,
 * and routing them through here would create exactly the privileged path the
 * design forbids. The admin UI is for managing the connector, not for running
 * processes.
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common'
import type { FastifyReply } from 'fastify'

import { Did, PeerDelivery, Problem, Scope, verifyAuditChain } from '@pilots/protocol'
import { z } from 'zod'

import {
  ADMIN_SESSIONS,
  type AdminSession,
  type AdminSessionService,
} from '../auth/admin-session.service.js'
import { API_KEYS, ApiKeyService } from '../auth/api-key.tokens.js'
import { AdminGuard, auditRequest, type AdminRequest } from '../auth/guards.js'
import { CONFIG, type ConnectorConfig } from '../config/config.js'
import { postureOf } from '../config/posture.js'
import { DEFINITION_REGISTRY, type DefinitionRegistry } from '../definitions/definition-registry.js'
import { ProblemException } from '../http/problem.js'
import { IDENTITY, type Identity } from '../identity/identity.service.js'
import { LOG_SERVICE, type LogService } from '../logging/log.service.js'
import { CONNECTIONS, type ConnectionService } from '../connections/connection.service.js'
import { NOTIFICATIONS, type NotificationService } from '../notifications/notification.service.js'
import { PEER_STREAMS, RECOVERY } from '../runtime.tokens.js'
import type { PeerStreamClient } from '../delivery/peer-stream-client.js'
import { DEFINITIONS, type DefinitionService } from '../definitions/definition.service.js'
import type { RecoveryService } from '../recovery/recovery.service.js'
import { STORE, type Store } from '../store/store.js'

/** Why a peer's definition was refused, so an instance's refusal can say. */
const RejectDefinitionBody = z.object({ reason: z.string().max(1024).optional() })

const RecoverBody = z.strictObject({
  /** Which peer to pull from. Omitted, every connection that carries traffic is tried. */
  from: Did.optional(),
})

const SignInBody = z.strictObject({
  token: z.string().min(1),
  label: z.string().max(64).optional(),
})

const CreateApiKeyBody = z.strictObject({
  label: z.string().min(1).max(255),
  scopes: z.array(Scope).min(1),
  participantId: z.string().min(1).optional(),
  expiresAt: z.iso.datetime().nullish(),
})

const OfferingBody = z.strictObject({
  id: z.string().min(1).max(255),
  title: z.string().min(1),
  description: z.string().optional(),
  quotationDefinition: z.string().min(1),
  serviceDefinition: z.string().min(1),
  conditions: z.record(z.string(), z.json()).optional(),
  price: z
    .strictObject({ value: z.number().min(0), currency: z.string().regex(/^[A-Z]{3}$/) })
    .nullish(),
  participantId: z.string().min(1).optional(),
})

const SubscriptionBody = z.strictObject({
  id: z.string().min(1).max(64).optional(),
  label: z.string().min(1).max(255),
  channel: z.enum(['webhook', 'sse']),
  target: z
    .strictObject({
      url: z.url(),
      headers: z.record(z.string(), z.string()).optional(),
      /** A *reference* to a secret — `env:NAME` — never the secret itself. */
      secretRef: z.string().max(255).nullish(),
    })
    .nullish(),
  notify: z.array(z.enum(['action.required', 'action.cleared', 'state.changed', 'event'])).min(1),
  filter: z
    .strictObject({
      definitions: z.array(z.string()).min(1).optional(),
      kinds: z
        .array(z.enum(['service', 'quotation']))
        .min(1)
        .optional(),
      states: z.array(z.string()).min(1).optional(),
      transitions: z.array(z.string()).min(1).optional(),
      instances: z.array(z.string()).min(1).optional(),
    })
    .optional(),
  status: z.enum(['ACTIVE', 'PAUSED', 'DEGRADED']).optional(),
})

function parse<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  const result = schema.safeParse(body)
  if (!result.success) {
    throw ProblemException.from(
      result.error.issues.map((issue) => ({
        type: Problem.schemaInvalid,
        detail: issue.message,
        pointer: `/${issue.path.join('/')}`,
      })),
    )
  }
  return result.data
}

/** Sign-in has no session yet, so it sits outside the guarded controller. */
const ConnectionRequestBody = z.strictObject({
  peerDid: Did,
  peerBaseUrl: z.url(),
  displayName: z.string().max(255).optional(),
  /** How **we** want to receive this peer's events. */
  delivery: PeerDelivery.default({ channel: 'stream' }),
  message: z.string().max(1024).optional(),
})

const ConnectionDecisionBody = z.strictObject({
  /** On accept: how we want to receive. Absent means `stream` — no inbound endpoint needed. */
  delivery: PeerDelivery.optional(),
  reason: z.string().max(1024).optional(),
})

const PruneAuditBody = z.strictObject({
  /** The last seq to discard. Exact, so nobody prunes "roughly everything old". */
  through: z.int().min(1),
  /** Where the operator says the discarded entries now live. Recorded, not checked. */
  exported: z.string().min(1).max(1024).optional(),
})

const TrustedPeerBody = z.strictObject({
  did: Did,
  note: z.string().max(255).optional(),
})

@Controller('api/admin/v1/sessions')
export class AdminSessionController {
  constructor(
    @Inject(ADMIN_SESSIONS) private readonly sessions: AdminSessionService,
    @Inject(LOG_SERVICE) private readonly log: LogService,
    @Inject(IDENTITY) private readonly identity: Identity,
  ) {}

  @Post()
  async signIn(@Req() request: AdminRequest, @Body() body: unknown) {
    const parsed = parse(SignInBody, body)
    const session = this.sessions.signIn(parsed.token, parsed.label)
    const participantId = this.identity.all[0]?.id ?? 'unknown'

    if (!session) {
      await this.log.record({
        level: 'warn',
        message: 'admin sign-in refused',
        audit: {
          participantId,
          category: 'admin',
          action: 'session.create',
          actor: { kind: 'adminSession', id: 'none', actorRef: null },
          outcome: 'denied',
          problem: Problem.credentialInvalid,
          request: auditRequest(request),
        },
      })
      throw ProblemException.of(Problem.credentialInvalid, 'invalid admin token')
    }

    await this.log.record({
      level: 'info',
      message: 'admin signed in',
      audit: {
        participantId,
        category: 'admin',
        action: 'session.create',
        actor: { kind: 'adminSession', id: session.id, actorRef: session.label },
        outcome: 'ok',
        request: auditRequest(request),
      },
    })
    return { session: { id: session.id, expiresAt: session.expiresAt, label: session.label } }
  }
}

@Controller('api/admin/v1')
@UseGuards(AdminGuard)
export class AdminController {
  constructor(
    @Inject(STORE) private readonly store: Store,
    @Inject(API_KEYS) private readonly keys: ApiKeyService,
    @Inject(ADMIN_SESSIONS) private readonly sessions: AdminSessionService,
    @Inject(IDENTITY) private readonly identity: Identity,
    @Inject(DEFINITION_REGISTRY) private readonly definitions: DefinitionRegistry,
    @Inject(LOG_SERVICE) private readonly log: LogService,
    @Inject(CONFIG) private readonly config: ConnectorConfig,
    @Inject(CONNECTIONS) private readonly connections: ConnectionService,
    @Inject(NOTIFICATIONS) private readonly notifications: NotificationService,
    @Inject(DEFINITIONS) private readonly definitionService: DefinitionService,
    @Inject(PEER_STREAMS) private readonly streams: PeerStreamClient,
    @Inject(RECOVERY) private readonly recovery: RecoveryService,
  ) {}

  private session(request: AdminRequest): AdminSession {
    if (!request.session) throw ProblemException.of(Problem.credentialInvalid, 'no admin session')
    return request.session
  }

  /** Which participant an admin call acts for. Defaults to the only one. */
  private participantId(explicit?: string): string {
    if (explicit !== undefined) {
      if (!this.identity.participant(explicit)) {
        throw ProblemException.badRequest(`unknown participant ${explicit}`)
      }
      return explicit
    }
    const first = this.identity.all[0]
    if (!first) throw ProblemException.badRequest('no participants configured')
    return first.id
  }

  private async audit(
    request: AdminRequest,
    action: string,
    outcome: 'ok' | 'denied' | 'failed',
    participantId: string,
    subject: Record<string, string | null> = {},
    problem?: string,
  ): Promise<void> {
    await this.log.record({
      level: outcome === 'ok' ? 'info' : 'warn',
      message: `${action} ${outcome}`,
      audit: {
        participantId,
        category: 'admin',
        action,
        actor: {
          kind: 'adminSession',
          id: this.session(request).id,
          actorRef: this.session(request).label,
        },
        outcome,
        problem: problem ?? null,
        subject,
        request: auditRequest(request),
      },
    })
  }

  // ── who this connector is ────────────────────────────────────────────────

  @Get('participants')
  async participants() {
    const participants = []
    for (const participant of this.identity.all) {
      participants.push({
        ...participant,
        didDocument: await this.identity.didDocument(participant.id),
      })
    }
    return { participants }
  }

  @Get('status')
  status() {
    return {
      environment: this.config.environment,
      store: this.config.store.adapter,
      definitions: this.definitions.size,
      participants: this.identity.all.length,
      // Never the values, only where they live and whether they will survive.
      secrets: {
        store: this.identity.report.secretStore,
        ephemeral: this.identity.report.ephemeral,
      },
      sessions: this.sessions.sessionCount,
      // The detail behind `/healthz`'s boolean, for somebody who has already
      // proved they operate this connector.
      posture: postureOf(this.config),
    }
  }

  @Delete('sessions/current')
  signOut(@Req() request: AdminRequest) {
    this.sessions.signOut(this.session(request).id)
    return { signedOut: true }
  }

  @Get('definitions')
  listDefinitions() {
    return {
      definitions: this.definitions.list().map((registered) => ({
        ref: registered.ref,
        title: registered.definition.title,
        kind: registered.definition.kind,
        hostedBy: registered.definition.hostedBy,
        roles: registered.definition.roles.map((role) => role.id),
        contentHash: registered.contentHash,
        source: registered.source,
        warnings: registered.warnings,
      })),
    }
  }

  /**
   * Definitions a peer sent that nobody here has decided about yet.
   *
   * The decision is about the **definition**, not the instance that prompted
   * it: accept once and every later instance under the same ref runs without
   * asking. Where a lower version was already accepted, the diff says what is
   * different about this one — which is the question an operator is actually
   * being asked.
   */
  @Get('definitions/pending')
  async pendingDefinitions(@Query('participantId') participantId?: string) {
    const pending = await this.definitionService.pending(this.participantId(participantId))
    return { pending }
  }

  @Post('definitions/:ref/accept')
  async acceptDefinition(
    @Req() request: AdminRequest,
    @Param('ref') ref: string,
    @Query('participantId') participantId?: string,
  ) {
    const owner = this.participantId(participantId)
    const result = await this.definitionService.decide(
      owner,
      ref,
      'accepted',
      this.session(request).label ?? this.session(request).id,
    )
    if (!result.ok) {
      await this.audit(request, 'definition.accept', 'denied', owner, { definition: ref })
      throw ProblemException.from(result.errors)
    }

    // Audited because it produces no event and would otherwise leave no record
    // that anyone agreed to run somebody else's process here.
    await this.audit(request, 'definition.accept', 'ok', owner, { definition: ref })
    return { definition: result.value }
  }

  @Post('definitions/:ref/reject')
  async rejectDefinition(
    @Req() request: AdminRequest,
    @Param('ref') ref: string,
    @Body() body: unknown,
    @Query('participantId') participantId?: string,
  ) {
    const owner = this.participantId(participantId)
    const parsed = RejectDefinitionBody.safeParse(body ?? {})
    const reason = parsed.success ? (parsed.data.reason ?? null) : null

    const result = await this.definitionService.decide(
      owner,
      ref,
      'rejected',
      this.session(request).label ?? this.session(request).id,
      reason,
    )
    if (!result.ok) {
      await this.audit(request, 'definition.reject', 'denied', owner, { definition: ref })
      throw ProblemException.from(result.errors)
    }

    await this.audit(request, 'definition.reject', 'ok', owner, { definition: ref })
    return { definition: result.value }
  }

  // ── API keys ─────────────────────────────────────────────────────────────

  @Get('apikeys')
  async listApiKeys(@Query('participantId') participantId?: string) {
    const keys = await this.keys.list(this.participantId(participantId))
    return { apiKeys: keys.map((key) => ApiKeyService.redact(key)) }
  }

  @Post('apikeys')
  async createApiKey(
    @Req() request: AdminRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Body() body: unknown,
  ) {
    const parsed = parse(CreateApiKeyBody, body)
    const participantId = this.participantId(parsed.participantId)
    const minted = await this.keys.mint({
      participantId,
      label: parsed.label,
      scopes: parsed.scopes,
      createdBy: this.session(request).id,
      expiresAt: parsed.expiresAt ?? null,
    })

    await this.audit(request, 'apiKey.create', 'ok', participantId, { apiKey: minted.record.id })
    void reply.status(201)
    // The only time the secret is ever returned.
    return { ...ApiKeyService.redact(minted.record), secret: minted.secret }
  }

  @Delete('apikeys/:id')
  async revokeApiKey(
    @Req() request: AdminRequest,
    @Param('id') id: string,
    @Query('participantId') participantId?: string,
  ) {
    const owner = this.participantId(participantId)
    const revoked = await this.keys.revoke(owner, id)
    if (!revoked) {
      await this.audit(request, 'apiKey.revoke', 'denied', owner, { apiKey: id }, 'about:blank')
      throw ProblemException.notFound(`no active API key ${id}`)
    }
    await this.audit(request, 'apiKey.revoke', 'ok', owner, { apiKey: id })
    return { revoked: true }
  }

  // ── offerings: publishing one is what makes this participant a supplier ──

  @Get('offerings')
  async listOfferings(@Query('participantId') participantId?: string) {
    return { offerings: await this.store.offerings.find(this.participantId(participantId)) }
  }

  @Post('offerings')
  async publishOffering(
    @Req() request: AdminRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Body() body: unknown,
  ) {
    const parsed = parse(OfferingBody, body)
    const participantId = this.participantId(parsed.participantId)

    for (const ref of [parsed.quotationDefinition, parsed.serviceDefinition]) {
      if (!this.definitions.has(ref)) {
        throw ProblemException.of(Problem.definitionInvalid, `unknown definition ${ref}`)
      }
    }

    const at = new Date().toISOString()
    const existing = await this.store.offerings.get(participantId, parsed.id)
    const offering = {
      id: parsed.id,
      participantId,
      title: parsed.title,
      ...(parsed.description === undefined ? {} : { description: parsed.description }),
      quotationDefinition: parsed.quotationDefinition,
      serviceDefinition: parsed.serviceDefinition,
      conditions: parsed.conditions ?? {},
      price: parsed.price ?? null,
      status: 'PUBLISHED' as const,
      createdAt: existing?.createdAt ?? at,
      updatedAt: at,
    }
    await this.store.offerings.upsert(offering)

    await this.audit(request, 'offering.publish', 'ok', participantId, { offering: parsed.id })
    void reply.status(existing ? 200 : 201)
    return offering
  }

  @Delete('offerings/:id')
  async withdrawOffering(
    @Req() request: AdminRequest,
    @Param('id') id: string,
    @Query('participantId') participantId?: string,
  ) {
    const owner = this.participantId(participantId)
    const existing = await this.store.offerings.get(owner, id)
    if (!existing) throw ProblemException.notFound(`no offering ${id}`)

    // Withdrawn, not deleted: a running process is unaffected, because offerings
    // govern discovery rather than execution.
    await this.store.offerings.replace({
      ...existing,
      status: 'WITHDRAWN',
      updatedAt: new Date().toISOString(),
    })
    await this.audit(request, 'offering.withdraw', 'ok', owner, { offering: id })
    return { withdrawn: true }
  }

  // ── notification subscriptions ───────────────────────────────────────────

  @Get('subscriptions')
  async listSubscriptions(@Query('participantId') participantId?: string) {
    return { subscriptions: await this.store.subscriptions.find(this.participantId(participantId)) }
  }

  @Post('subscriptions')
  async createSubscription(
    @Req() request: AdminRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Body() body: unknown,
    @Query('participantId') participantIdQuery?: string,
  ) {
    const parsed = parse(SubscriptionBody, body)
    const participantId = this.participantId(participantIdQuery)

    if (parsed.channel === 'webhook' && !parsed.target) {
      throw ProblemException.badRequest('a webhook subscription needs a target url')
    }

    const at = new Date().toISOString()
    const id = parsed.id ?? `sub_${Math.random().toString(36).slice(2, 10)}`
    const subscription = {
      id,
      participantId,
      label: parsed.label,
      channel: parsed.channel,
      target: parsed.target
        ? {
            url: parsed.target.url,
            headers: parsed.target.headers ?? {},
            secretRef: parsed.target.secretRef ?? null,
          }
        : null,
      notify: parsed.notify,
      filter: parsed.filter ?? {},
      status: parsed.status ?? ('ACTIVE' as const),
      createdAt: at,
      updatedAt: at,
    }
    await this.store.subscriptions.upsert(subscription)

    await this.audit(request, 'subscription.create', 'ok', participantId, { subscription: id })
    void reply.status(201)
    return subscription
  }

  @Patch('subscriptions/:id')
  async updateSubscription(
    @Req() request: AdminRequest,
    @Param('id') id: string,
    @Body() body: unknown,
    @Query('participantId') participantIdQuery?: string,
  ) {
    const participantId = this.participantId(participantIdQuery)
    const existing = await this.store.subscriptions.get(participantId, id)
    if (!existing) throw ProblemException.notFound(`no subscription ${id}`)

    const parsed = parse(SubscriptionBody.partial(), body)
    const updated = {
      ...existing,
      ...(parsed.label === undefined ? {} : { label: parsed.label }),
      ...(parsed.notify === undefined ? {} : { notify: parsed.notify }),
      ...(parsed.filter === undefined ? {} : { filter: parsed.filter }),
      ...(parsed.status === undefined ? {} : { status: parsed.status }),
      updatedAt: new Date().toISOString(),
    }
    await this.store.subscriptions.replace(updated)
    await this.audit(request, 'subscription.update', 'ok', participantId, { subscription: id })
    return updated
  }

  @Delete('subscriptions/:id')
  async deleteSubscription(
    @Req() request: AdminRequest,
    @Param('id') id: string,
    @Query('participantId') participantIdQuery?: string,
  ) {
    const participantId = this.participantId(participantIdQuery)
    const deleted = await this.store.subscriptions.delete(participantId, id)
    if (!deleted) throw ProblemException.notFound(`no subscription ${id}`)
    await this.audit(request, 'subscription.delete', 'ok', participantId, { subscription: id })
    return { deleted: true }
  }

  // ── the audit log ────────────────────────────────────────────────────────

  // ── connections ──────────────────────────────────────────────────────────
  //
  // Accepting a connection is an administrative act because a **human decides
  // who to trust**. The peer callback that reports the decision lives on the
  // peer surface; collapsing the two would let a peer accept its own request.

  @Get('connections')
  async listConnections(@Query('participantId') participantId?: string) {
    return { connections: await this.connections.list(this.participantId(participantId)) }
  }

  @Post('connections')
  async requestConnection(
    @Req() request: AdminRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Body() body: unknown,
    @Query('participantId') participantIdQuery?: string,
  ) {
    const parsed = parse(ConnectionRequestBody, body)
    const owner = this.participantId(participantIdQuery)
    const participant = this.identity.participant(owner)
    if (!participant) throw ProblemException.badRequest(`unknown participant ${owner}`)

    const result = await this.connections.request(
      participant,
      {
        peerDid: parsed.peerDid,
        peerBaseUrl: parsed.peerBaseUrl,
        displayName: parsed.displayName ?? null,
        delivery: parsed.delivery,
        ...(parsed.message === undefined ? {} : { message: parsed.message }),
      },
      { kind: 'adminSession', id: this.session(request).id, actorRef: this.session(request).label },
    )
    if (!result.ok) throw ProblemException.from(result.errors)

    void reply.status(201)
    return { connection: result.value }
  }

  @Post('connections/:id/accept')
  async acceptConnection(
    @Req() request: AdminRequest,
    @Param('id') id: string,
    @Body() body: unknown,
    @Query('participantId') participantIdQuery?: string,
  ) {
    const parsed = parse(ConnectionDecisionBody, body ?? {})
    const owner = this.participantId(participantIdQuery)
    const participant = this.identity.participant(owner)
    if (!participant) throw ProblemException.badRequest(`unknown participant ${owner}`)

    const result = await this.connections.accept(
      participant,
      id,
      parsed.delivery ?? { channel: 'stream' },
      { kind: 'adminSession', id: this.session(request).id, actorRef: this.session(request).label },
    )
    if (!result.ok) throw ProblemException.from(result.errors)
    // Attach immediately if we just chose to hold a line, rather than waiting
    // for the next scan.
    await this.streams.sync()
    return { connection: result.value }
  }

  @Post('connections/:id/reject')
  async rejectConnection(
    @Req() request: AdminRequest,
    @Param('id') id: string,
    @Body() body: unknown,
    @Query('participantId') participantIdQuery?: string,
  ) {
    const parsed = parse(ConnectionDecisionBody, body ?? {})
    const owner = this.participantId(participantIdQuery)
    const participant = this.identity.participant(owner)
    if (!participant) throw ProblemException.badRequest(`unknown participant ${owner}`)

    const result = await this.connections.reject(participant, id, parsed.reason, {
      kind: 'adminSession',
      id: this.session(request).id,
      actorRef: this.session(request).label,
    })
    if (!result.ok) throw ProblemException.from(result.errors)
    return { connection: result.value }
  }

  @Post('connections/:id/revoke')
  async revokeConnection(
    @Req() request: AdminRequest,
    @Param('id') id: string,
    @Query('participantId') participantIdQuery?: string,
  ) {
    const owner = this.participantId(participantIdQuery)
    const participant = this.identity.participant(owner)
    if (!participant) throw ProblemException.badRequest(`unknown participant ${owner}`)

    // Revoked, not deleted. Existing instances become read-only rather than
    // disappearing: history is not deleted, and a process that ran is a fact.
    const result = await this.connections.revoke(participant, id, {
      kind: 'adminSession',
      id: this.session(request).id,
      actorRef: this.session(request).label,
    })
    if (!result.ok) throw ProblemException.from(result.errors)
    return { connection: result.value }
  }

  // ── the auto-accept allowlist ────────────────────────────────────────────

  @Get('trusted-peers')
  async listTrustedPeers(@Query('participantId') participantId?: string) {
    return { trustedPeers: await this.store.trustedPeers.find(this.participantId(participantId)) }
  }

  @Post('trusted-peers')
  async trustPeer(
    @Req() request: AdminRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Body() body: unknown,
    @Query('participantId') participantIdQuery?: string,
  ) {
    const parsed = parse(TrustedPeerBody, body)
    const owner = this.participantId(participantIdQuery)

    // Keyed by DID, so the allowlist cannot hold the same peer twice.
    await this.store.trustedPeers.upsert({
      id: parsed.did,
      participantId: owner,
      did: parsed.did,
      addedAt: new Date().toISOString(),
      note: parsed.note ?? null,
    })
    await this.audit(request, 'trustedPeer.add', 'ok', owner, { connection: null })
    void reply.status(201)
    return { did: parsed.did }
  }

  @Delete('trusted-peers/:did')
  async untrustPeer(
    @Req() request: AdminRequest,
    @Param('did') did: string,
    @Query('participantId') participantId?: string,
  ) {
    const owner = this.participantId(participantId)
    const removed = await this.store.trustedPeers.delete(owner, decodeURIComponent(did))
    if (!removed) throw ProblemException.notFound(`${did} is not on the allowlist`)
    await this.audit(request, 'trustedPeer.remove', 'ok', owner)
    return { removed: true }
  }

  // ── dead letters ─────────────────────────────────────────────────────────

  @Get('notifications/dead-letters')
  async deadLetters(@Query('participantId') participantId?: string) {
    const owner = this.participantId(participantId)
    return { deadLetters: await this.notifications.deadLetters(owner) }
  }

  /** Requeue. An operator's decision, never automatic. */
  @Post('notifications/retry')
  async retryDeadLetters(
    @Req() request: AdminRequest,
    @Query('participantId') participantId?: string,
    @Query('subscriptionId') subscriptionId?: string,
  ) {
    const owner = this.participantId(participantId)
    const requeued = await this.notifications.retryDeadLetters(owner, subscriptionId)
    await this.audit(request, 'notification.retry', 'ok', owner, {
      subscription: subscriptionId ?? null,
    })
    return { requeued }
  }

  @Get('audit')
  async auditLog(
    @Query('since') since?: string,
    @Query('limit') limit?: string,
    @Query('participantId') participantId?: string,
  ) {
    const owner = this.participantId(participantId)
    const sinceSeq = since === undefined ? 0 : Number(since)
    const max = limit === undefined ? 200 : Number(limit)
    if (!Number.isInteger(sinceSeq) || sinceSeq < 0) {
      throw ProblemException.badRequest('since must be a non-negative integer')
    }
    if (!Number.isInteger(max) || max < 1 || max > 1000) {
      throw ProblemException.badRequest('limit must be between 1 and 1000')
    }

    const entries = await this.store.audit.read(owner, sinceSeq, max)
    return { entries, total: await this.store.audit.count(owner) }
  }

  /** Confirms nobody has edited, reordered or removed an entry. */
  @Get('audit/verify')
  async verifyAudit(@Query('participantId') participantId?: string, @Query('from') from?: string) {
    const owner = this.participantId(participantId)
    const start = from === undefined ? 1 : Number(from)
    if (!Number.isInteger(start) || start < 1) {
      throw ProblemException.badRequest('from must be a positive integer')
    }

    const entries = await this.store.audit.read(owner, start - 1, 1_000_000)
    const verification = verifyAuditChain(entries, { from: start })
    return {
      ok: verification.ok,
      entries: entries.length,
      from: start,
      failures: verification.failures,
    }
  }

  /**
   * Export the audit log, or a slice of it.
   *
   * The audit log is **never replicated** — it is nobody else's business — so
   * getting a copy out is an operator act rather than a protocol one. It comes
   * out as newline-delimited JSON because that is what a log pipeline, an
   * auditor's spreadsheet and `grep` all read without help.
   *
   * A slice carries `from`, so a segment that begins at seq 4001 can still be
   * verified: `GET /audit/verify?from=4001`. A chain whose earlier links are
   * elsewhere is not a broken chain.
   */
  @Get('audit/export')
  async exportAudit(
    @Res({ passthrough: true }) reply: FastifyReply,
    @Query('participantId') participantId?: string,
    @Query('since') since?: string,
    @Query('until') until?: string,
  ) {
    const owner = this.participantId(participantId)
    const sinceSeq = since === undefined ? 0 : Number(since)
    const untilSeq = until === undefined ? Number.MAX_SAFE_INTEGER : Number(until)
    if (!Number.isInteger(sinceSeq) || sinceSeq < 0 || !Number.isInteger(untilSeq)) {
      throw ProblemException.badRequest('since and until must be integers')
    }

    const entries = (await this.store.audit.read(owner, sinceSeq, 1_000_000)).filter(
      (entry) => entry.seq <= untilSeq,
    )

    void reply
      .header('content-type', 'application/x-ndjson')
      .header(
        'content-disposition',
        `attachment; filename="audit-${owner}-${sinceSeq + 1}-${entries.at(-1)?.seq ?? sinceSeq}.ndjson"`,
      )
    return entries.map((entry) => JSON.stringify(entry)).join('\n')
  }

  /**
   * Discard audit entries older than a point, once they have been exported.
   *
   * **Deliberately awkward.** It takes the exact `through` seq and refuses
   * anything that would leave the remaining log unverifiable, because an audit
   * log you can quietly truncate is not an audit log. The act of pruning is
   * itself audited, in the log that remains, so the gap is never silent.
   *
   * Retention is an operator's decision about storage, not a way to make
   * something go away: what is kept still chains, and the first kept entry names
   * the seq it continues from.
   */
  @Post('audit/prune')
  async pruneAudit(
    @Req() request: AdminRequest,
    @Body() body: unknown,
    @Query('participantId') participantIdQuery?: string,
  ) {
    const parsed = parse(PruneAuditBody, body)
    const owner = this.participantId(participantIdQuery)

    const total = await this.store.audit.count(owner)
    if (parsed.through >= total) {
      throw ProblemException.badRequest(
        `refusing to prune through ${parsed.through} of ${total} entries: that would leave nothing to verify`,
      )
    }

    const removed = await this.store.audit.prune(owner, parsed.through)

    // Recorded in the log that survives, so the gap is explained rather than
    // merely present.
    await this.audit(request, 'audit.prune', 'ok', owner)
    return { removed, remainingFrom: parsed.through + 1, exported: parsed.exported }
  }

  // ── recovery: the log is the record, so prove it ─────────────────────────

  /**
   * Refold one instance from its own event log.
   *
   * §5.2 says the materialised instance is a cache the log rebuilds. This is
   * that sentence as an operation: it verifies the chain, refolds, and reports
   * what — if anything — the document had got wrong. It touches no peer.
   */
  @Post('instances/:id/rebuild')
  async rebuildInstance(
    @Req() request: AdminRequest,
    @Param('id') id: string,
    @Query('participantId') participantIdQuery?: string,
  ) {
    const owner = this.participantId(participantIdQuery)
    const participant = this.identity.participant(owner)
    if (!participant) throw ProblemException.badRequest(`unknown participant ${owner}`)

    const outcome = await this.recovery.rebuild(participant, id)
    if (!outcome.ok) {
      await this.audit(request, 'instance.rebuild', 'failed', owner, { instance: id })
      throw ProblemException.badRequest(outcome.detail)
    }
    return outcome.value
  }

  /**
   * Pull an instance back from a participant who kept a copy.
   *
   * The re-hosting path: a connector whose store is gone gets its state back
   * from the replicas of the peers it was hosting for, verifying every
   * signature — including its own — on the way in. It adds no protocol; it is
   * the delivery layer's own `?since=` recovery call, made deliberately.
   *
   * A peer can only return what it was allowed to see, so a recovered log may
   * carry redacted payloads. The response counts them rather than hiding it.
   */
  @Post('instances/:id/recover')
  async recoverInstance(
    @Req() request: AdminRequest,
    @Param('id') id: string,
    @Body() body: unknown,
    @Query('participantId') participantIdQuery?: string,
  ) {
    const parsed = parse(RecoverBody, body ?? {})
    const owner = this.participantId(participantIdQuery)
    const participant = this.identity.participant(owner)
    if (!participant) throw ProblemException.badRequest(`unknown participant ${owner}`)

    const outcome = await this.recovery.recover(participant, id, parsed.from)
    if (!outcome.ok) {
      await this.audit(request, 'instance.recover', 'failed', owner, { instance: id })
      throw ProblemException.badRequest(outcome.detail)
    }
    return outcome.value
  }
}
