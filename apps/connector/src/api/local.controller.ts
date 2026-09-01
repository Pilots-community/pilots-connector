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

import { Problem } from '@pilots/protocol'
import { z } from 'zod'

import { ApiKeyGuard, RequireScope, auditRequest, type LocalRequest } from '../auth/guards.js'
import { DEFINITION_REGISTRY, type DefinitionRegistry } from '../definitions/definition-registry.js'
import { ProblemException } from '../http/problem.js'
import { INSTANCE_SERVICE } from '../instances/instance.tokens.js'
import type { CallerContext, InstanceService, WriteOutcome } from '../instances/instance.service.js'
import { LOG_SERVICE, type LogService } from '../logging/log.service.js'
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
  ) {}

  // ── definitions and offerings ────────────────────────────────────────────

  @Get('definitions')
  @RequireScope('definitions.read')
  listDefinitions() {
    return {
      definitions: this.definitions.list().map((registered) => ({
        ref: registered.ref,
        title: registered.definition.title,
        kind: registered.definition.kind,
        contentHash: registered.contentHash,
      })),
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
    if (peer !== undefined) {
      // Browsing a *peer's* offerings is a relayed read, and there is no peer
      // transport before M3. A network fault is not a business error, so it gets
      // its own problem type rather than a rewritten 404.
      throw ProblemException.of(
        Problem.peerUnreachable,
        `no peer transport is configured, so ${peer}'s offerings cannot be browsed`,
      )
    }
    const offerings = await this.store.offerings.find(caller(request).participant.id, {
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
        ? { ...view.instance, home: view.home, available: view.available, redacted: view.redacted }
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
