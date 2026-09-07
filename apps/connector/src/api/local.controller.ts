/**
 * `/api/local/v1` — the surface an integrator actually writes against.
 *
 * **No privileged path.** Our own demo UI is an ordinary API-key client here.
 * Every capability it has is available to any third-party UI or backoffice on
 * the same terms — if a feature ever needs a route only our UI can use, that is
 * a design failure, not a shortcut.
 *
 * Three separate mechanisms for three separate problems, all visible in this
 * file: `If-Match` for concurrency, `Idempotency-Key` for safe retries, and the
 * signed hash chain (elsewhere) for tamper evidence. They are not alternatives.
 */
import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common'
import type { FastifyReply } from 'fastify'

import { Problem, analyseReachability } from '@pilots/protocol'
import { z } from 'zod'

import { ApiKeyGuard, RequireScope, auditRequest, type LocalRequest } from '../auth/guards.js'
import { DEFINITION_REGISTRY, type DefinitionRegistry } from '../definitions/definition-registry.js'
import { ProblemException } from '../http/problem.js'
import { INSTANCE_SERVICE } from '../instances/instance.tokens.js'
import type { CallerContext, InstanceService, WriteOutcome } from '../instances/instance.service.js'
import { LOG_SERVICE, type LogService } from '../logging/log.service.js'
import { ATTACHMENTS, type AttachmentService } from '../attachments/attachment.service.js'
import { NOTIFICATIONS, type NotificationService } from '../notifications/notification.service.js'
import { LOCAL_HUB, RELAY } from '../runtime.tokens.js'
import type { Relay } from '../peer/relay.js'
import { toSseFrame } from '../peer/http-transport.js'
import { StreamHub } from '../delivery/stream-hub.js'
import { STORE, type Store } from '../store/store.js'

const CreateInstanceBody = z.strictObject({
  definition: z.string().min(1),
  participants: z.record(z.string(), z.union([z.string(), z.array(z.string()).min(1)])),
  data: z.record(z.string(), z.json()).optional(),
  quotationId: z.string().nullish(),
  offering: z.string().nullish(),
})

const TransitionBody = z.strictObject({
  transition: z.string().min(1),
  patch: z.union([z.record(z.string(), z.json()), z.null()]).optional(),
  attachments: z
    .array(
      z.strictObject({
        sha256: z.string().regex(/^sha256:[0-9a-f]{64}$/),
        mime: z.string().min(1).max(255),
        size: z.int().min(0),
        filename: z.string().max(255).optional(),
      }),
    )
    .optional(),
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

/** `If-Match: "3"` or `If-Match: 3`. Absent is a `428`, not a silent overwrite. */
function requireIfMatch(value: string | undefined): number {
  if (value === undefined || value.trim() === '') {
    throw ProblemException.of(
      Problem.preconditionRequired,
      'If-Match is required on a mutating call: send the instance’s current seq',
    )
  }
  const seq = Number(value.trim().replace(/^W\//, '').replace(/"/g, ''))
  if (!Number.isInteger(seq) || seq < 1) {
    throw ProblemException.badRequest(`If-Match must be an instance seq, got ${value}`)
  }
  return seq
}

/** Every local subscriber listens on one stream; the subscription filters it. */
const LOCAL_STREAM = 'local'

function clampLimit(value: string | undefined): number {
  const parsed = Number(value ?? 200)
  if (!Number.isInteger(parsed) || parsed < 1) return 200
  return Math.min(parsed, 500)
}

function caller(request: LocalRequest): CallerContext {
  if (!request.caller) throw ProblemException.of(Problem.credentialInvalid, 'unauthenticated')
  return request.caller
}

@Controller('api/local/v1')
@UseGuards(ApiKeyGuard)
export class LocalController {
  constructor(
    @Inject(INSTANCE_SERVICE) private readonly instances: InstanceService,
    @Inject(DEFINITION_REGISTRY) private readonly definitions: DefinitionRegistry,
    @Inject(STORE) private readonly store: Store,
    @Inject(LOG_SERVICE) private readonly log: LogService,
    @Inject(NOTIFICATIONS) private readonly notifications: NotificationService,
    @Inject(RELAY) private readonly relay: Relay,
    @Inject(LOCAL_HUB) private readonly hub: StreamHub,
    @Inject(ATTACHMENTS) private readonly attachments: AttachmentService,
  ) {}

  // ── who this key acts for ────────────────────────────────────────────────

  /**
   * Which participant this key belongs to.
   *
   * A client needs its own DID to fill a `participants` map — a definition names
   * a *role*, and only an instance names the participant filling it, so there is
   * no way to start anything without knowing who you are. Nothing else on this
   * surface answered that, and a UI guessing from configuration would be a UI
   * that could be pointed at the wrong connector and not notice.
   *
   * No scope beyond a valid key: asking who a credential belongs to is not a
   * privilege, and refusing it would only push integrators into hardcoding it.
   */
  @Get('me')
  me(@Req() request: LocalRequest) {
    const { participant } = caller(request)
    return {
      participant: {
        id: participant.id,
        did: participant.did,
        displayName: participant.displayName,
      },
    }
  }

  // ── definitions and offerings ────────────────────────────────────────────

  @Get('definitions')
  @RequireScope('definitions.read')
  listDefinitions() {
    return {
      definitions: this.definitions.list().map((registered) => {
        /*
         * Whether an instance under this definition can succeed with no
         * relation anchored. A client uses it to avoid offering a process that
         * would be refused at creation — computed from the graph, so a
         * definition this connector has never seen answers the same way.
         */
        const standalone = analyseReachability(registered.definition)
        return {
          ref: registered.ref,
          title: registered.definition.title,
          kind: registered.definition.kind,
          contentHash: registered.contentHash,
          startableStandalone: standalone.fulfilmentReachable,
          requiresRelations: standalone.fulfilmentReachable ? [] : standalone.unlockingRelations,
        }
      }),
    }
  }

  @Get('definitions/:ref')
  @RequireScope('definitions.read')
  getDefinition(@Param('ref') ref: string) {
    const registered = this.definitions.get(ref)
    if (!registered) throw ProblemException.notFound(`unknown definition ${ref}`)
    return { ref: registered.ref, contentHash: registered.contentHash, definition: registered.raw }
  }

  @Get('offerings')
  @RequireScope('offerings.read')
  async listOfferings(@Req() request: LocalRequest, @Query('peer') peer?: string) {
    const context = caller(request)
    if (peer !== undefined) {
      // A relayed read. The integrator addresses its own connector and names a
      // peer; it never learns where the answer came from.
      const browsed = await this.relay.browseOfferings(context.participant, peer)
      if (!browsed.ok) {
        throw ProblemException.from(browsed.errors, {
          ...(browsed.status === undefined ? {} : { status: browsed.status }),
        })
      }
      return browsed.value
    }
    const offerings = await this.store.offerings.find(context.participant.id, {
      where: { status: 'PUBLISHED' },
    })
    return { offerings }
  }

  @Get('connections')
  @RequireScope('connections.read')
  async listConnections(@Req() request: LocalRequest) {
    // Read-only to an integrator by design: connections are operator state.
    return { connections: await this.store.connections.find(caller(request).participant.id) }
  }

  // ── attachments ──────────────────────────────────────────────────────────

  /**
   * Upload document bytes and get back the reference a transition will carry.
   *
   * The connector computes the hash; the caller does not supply it. A
   * content-addressed store whose content and address can disagree is not
   * content-addressed.
   */
  @Post('attachments')
  @RequireScope('attachments.write')
  async uploadAttachment(
    @Req() request: LocalRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const context = caller(request)
    const body = request.body
    if (!Buffer.isBuffer(body)) {
      throw ProblemException.badRequest(
        'send the raw document bytes with a content-type of its own, not JSON',
      )
    }

    const mime = (request.headers['content-type'] ?? 'application/octet-stream').split(';')[0]!
    const stored = await this.attachments.put(context.participant, new Uint8Array(body), mime)
    if (!stored.ok) throw ProblemException.from(stored.errors)

    void reply.status(201)
    return stored.value
  }

  /**
   * Fetch document bytes, subject to the same visibility rules as a read.
   *
   * A replica does not necessarily hold them — bytes follow the reference to the
   * home node — so if we are entitled but empty-handed, we pull from the host
   * and serve. The integrator sees one endpoint either way, exactly as it sees
   * one endpoint for a local and a relayed transition.
   */
  @Get('attachments/:sha256')
  @RequireScope('attachments.read')
  async getAttachment(
    @Req() request: LocalRequest,
    @Res() reply: FastifyReply,
    @Param('sha256') sha256: string,
  ): Promise<void> {
    const context = caller(request)
    const digest = decodeURIComponent(sha256)

    // Ours, or a co-hosted participant's on this same connector.
    let found = await this.attachments.readLocally(context.participant, digest)
    if (!found) {
      const host = await this.hostHolding(context.participant.id, digest)
      if (host !== undefined) {
        await this.attachments.pull(context.participant, host, [
          { sha256: digest, mime: 'application/octet-stream', size: 0 },
        ])
        found = await this.attachments.read(context.participant, context.participant.did, digest)
      }
    }

    // A 404 covers both "no such attachment" and "one you may not read".
    if (!found) throw ProblemException.notFound(`no attachment ${digest}`)

    void reply
      .status(200)
      .header('content-type', found.mime)
      .header('content-length', String(found.size))
      // Content-addressed: the bytes for a hash never change, so this is one of
      // the few things in the system that is genuinely immutable.
      .header('cache-control', 'public, max-age=31536000, immutable')
      .header('etag', `"${found.sha256}"`)
      .send(Buffer.from(found.bytes))
  }

  /** The peer hosting an instance of ours that references this document. */
  private async hostHolding(participantId: string, sha256: string): Promise<string | undefined> {
    for (const instance of await this.store.instances.find(participantId)) {
      if (instance.home) continue
      const events = await this.store.events.read(participantId, instance.id, 0)
      if (!events.some((event) => event.header.attachments.some((ref) => ref.sha256 === sha256))) {
        continue
      }
      const host = this.attachments.hostOf(instance)
      if (host !== undefined) return host
    }
    return undefined
  }

  // ── local delivery ───────────────────────────────────────────────────────

  /**
   * `GET /notifications?since=<cursor>` — the authoritative replay.
   *
   * A backoffice that was down catches up here without operator involvement and
   * without anyone deciding whether a delivery "really" happened. It returns
   * everything, delivered or not: the recipient deduplicates on the cursor,
   * which it must be able to do anyway because delivery is at-least-once.
   */
  @Get('notifications')
  @RequireScope('events.subscribe')
  async listNotifications(
    @Req() request: LocalRequest,
    @Query('since') since?: string,
    @Query('limit') limit?: string,
  ) {
    const context = caller(request)
    const notifications = await this.notifications.replay(
      context.participant.id,
      since === undefined || since === '' ? undefined : since,
      clampLimit(limit),
    )
    return {
      notifications: notifications.map((notification) => notification.envelope),
      cursor: notifications.at(-1)?.id ?? since ?? null,
    }
  }

  /**
   * `GET /events?since=<cursor>` — the SSE half of local delivery.
   *
   * For an internal system that cannot accept inbound connections either. It is
   * the same subscription model as a webhook target; only the direction of the
   * connection differs.
   */
  @Get('events')
  @RequireScope('events.subscribe')
  async streamEvents(
    @Req() request: LocalRequest,
    @Res() reply: FastifyReply,
    @Query('since') since?: string,
  ): Promise<void> {
    const context = caller(request)
    const raw = reply.raw
    let open = true

    const attachment = await this.hub.attach({
      participantId: context.participant.id,
      // Local subscribers share one audience: they are all "our own systems",
      // and what each is entitled to is decided by the filter, not the stream.
      audience: LOCAL_STREAM,
      since: since === undefined || since === '' ? null : since,
      handlers: {
        onMessage: (message) => {
          if (open) raw.write(toSseFrame(message))
        },
        onClose: () => {
          if (open) {
            open = false
            raw.end()
          }
        },
      },
      pull: async (cursor) => {
        const batch = await this.notifications.replay(
          context.participant.id,
          cursor ?? undefined,
          64,
        )
        return batch.map((notification) => ({
          id: notification.id,
          event: notification.notification,
          data: notification.envelope,
        }))
      },
    })

    reply.hijack()
    raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    raw.write(': attached\n\n')

    const shutdown = (): void => {
      if (!open) return
      open = false
      attachment.close()
    }
    raw.on('close', shutdown)
    raw.on('error', shutdown)
  }

  // ── instances ────────────────────────────────────────────────────────────

  @Get('instances')
  @RequireScope('instances.read')
  async listInstances(@Req() request: LocalRequest) {
    const views = await this.instances.list(caller(request))
    return {
      instances: views.map((view) => ({
        ...view.instance,
        home: view.home,
        available: view.available,
        redacted: view.redacted,
        outcome: view.outcome,
      })),
    }
  }

  @Get('instances/:id')
  @RequireScope('instances.read')
  async getInstance(
    @Req() request: LocalRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Param('id') id: string,
  ) {
    const view = await this.instances.read(caller(request), id)
    // A 404 covers both "no such instance" and "one you may not see". Telling
    // the two apart is an enumeration oracle.
    if (!view) throw ProblemException.notFound(`no instance ${id}`)
    void reply.header('ETag', `"${view.instance.seq}"`)
    return {
      ...view.instance,
      home: view.home,
      available: view.available,
      redacted: view.redacted,
      outcome: view.outcome,
    }
  }

  @Get('instances/:id/events')
  @RequireScope('instances.read')
  async getEvents(
    @Req() request: LocalRequest,
    @Param('id') id: string,
    @Query('since') since?: string,
  ) {
    const sinceSeq = since === undefined ? 0 : Number(since)
    if (!Number.isInteger(sinceSeq) || sinceSeq < 0) {
      throw ProblemException.badRequest('since must be a non-negative integer')
    }
    const events = await this.instances.events(caller(request), id, sinceSeq)
    if (!events) throw ProblemException.notFound(`no instance ${id}`)
    return { events }
  }

  @Post('instances')
  @RequireScope('instances.create')
  async createInstance(
    @Req() request: LocalRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const context = caller(request)
    const parsed = parse(CreateInstanceBody, body)

    return this.idempotent(context, idempotencyKey, 'instance.create', async () => {
      const result = await this.instances.create(context, {
        definition: parsed.definition,
        participants: parsed.participants,
        data: parsed.data ?? {},
        quotationId: parsed.quotationId ?? null,
        offering: parsed.offering ?? null,
      })

      if (!result.ok) {
        await this.audit(
          request,
          context,
          'instance.create',
          'denied',
          result.errors[0]?.type,
          null,
        )
        throw ProblemException.from(result.errors, { seq: result.conflict?.actualSeq })
      }

      await this.audit(request, context, 'instance.create', 'ok', null, result.value.instance.id)
      void reply
        .status(201)
        .header('ETag', `"${result.value.instance.seq}"`)
        .header('Location', `/api/local/v1/instances/${result.value.instance.id}`)
      return await this.present(context, result.value)
    })
  }

  /** The one mutating call. */
  @Post('instances/:id/transitions')
  @RequireScope('transitions.apply')
  async applyTransition(
    @Req() request: LocalRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('if-match') ifMatch?: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const context = caller(request)
    const parsed = parse(TransitionBody, body)
    const expectedSeq = requireIfMatch(ifMatch)

    // Set before the idempotency wrapper, so a *replayed* response is identical
    // to the original — including its status. A retry that came back 201 where
    // the first call was 200 would be a difference a client can see.
    void reply.status(200)

    return this.idempotent(context, idempotencyKey, 'transition.apply', async () => {
      const result = await this.instances.applyTransition(
        context,
        id,
        {
          transition: parsed.transition,
          patch: parsed.patch ?? null,
          attachments: parsed.attachments ?? [],
        },
        expectedSeq,
      )

      if (!result.ok) {
        await this.audit(request, context, 'transition.apply', 'denied', result.errors[0]?.type, id)
        throw ProblemException.from(result.errors, { seq: result.conflict?.actualSeq })
      }

      await this.audit(request, context, 'transition.apply', 'ok', null, id)
      // 200, not Nest's default 201 for a POST: a transition advances an
      // instance, it does not create a resource. docs/PROTOCOL.md §9.2.
      void reply.header('ETag', `"${result.value.instance.seq}"`)
      return await this.present(context, result.value)
    })
  }

  // ── plumbing ─────────────────────────────────────────────────────────────

  /**
   * A retry after a timeout must not apply the transition twice.
   *
   * The claim is insert-if-absent; the loser of a race replays the original
   * result rather than doing the work again. A claim whose work failed is
   * released, or one bad request would block that key forever.
   */
  private async idempotent<T>(
    context: CallerContext,
    key: string | undefined,
    scope: string,
    work: () => Promise<T>,
  ): Promise<T> {
    if (key === undefined || key.trim() === '') return work()

    const existing = await this.store.idempotency.claim(
      context.participant.id,
      key,
      scope,
      new Date().toISOString(),
    )
    if (existing?.status === 'complete') return existing.result as T
    if (existing?.status === 'pending') {
      throw ProblemException.of(
        Problem.seqConflict,
        'a request with this Idempotency-Key is still in flight',
      )
    }

    try {
      const result = await work()
      await this.store.idempotency.complete(
        context.participant.id,
        key,
        result,
        new Date().toISOString(),
      )
      return result
    } catch (error) {
      await this.store.idempotency.release(context.participant.id, key)
      throw error
    }
  }

  /**
   * Report the instance as the **caller** may see it, not as the home node holds
   * it. A write must never become a way to read a field a read would withhold,
   * so this goes back through the same filtered read path `GET` uses.
   */
  private async present(context: CallerContext, outcome: WriteOutcome) {
    const view = await this.instances.read(context, outcome.instance.id)
    return {
      instance: view
        ? {
            ...view.instance,
            home: view.home,
            available: view.available,
            redacted: view.redacted,
            outcome: view.outcome,
          }
        : undefined,
      events: outcome.events.map((event) => ({
        header: event.header,
        payload: event.payload,
        redacted: event.redacted,
        sig: event.sig,
      })),
    }
  }

  private async audit(
    request: LocalRequest,
    context: CallerContext,
    action: string,
    outcome: 'ok' | 'denied',
    problem: string | null | undefined,
    instance: string | null,
  ): Promise<void> {
    await this.log.record({
      level: outcome === 'ok' ? 'info' : 'warn',
      message: outcome === 'ok' ? `${action} applied` : `${action} refused`,
      audit: {
        participantId: context.participant.id,
        category: 'local',
        action,
        actor: {
          kind: 'apiKey',
          id: request.apiKeyId ?? 'unknown',
          actorRef: context.actorRef,
        },
        outcome,
        problem: problem ?? null,
        subject: { instance },
        request: auditRequest(request),
      },
    })
  }
}
