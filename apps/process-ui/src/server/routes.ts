/**
 * The BFF's API — what the SPA talks to.
 *
 * It is deliberately a thin adapter over `@pilots/client`, and its whole job is
 * one translation: **a signed-in user becomes an API key plus an
 * `X-Actor-Ref`.** The connector authenticates the key and records the actor as
 * an unproven audit hint; it has no idea who "alice" is, and must not.
 *
 * The API key never reaches the browser. That is the reason this tier exists at
 * all — a key in a SPA is a key in everybody's devtools, and this one is scoped
 * to a whole participant.
 *
 * Two things this must *not* become. It must not accumulate business logic: the
 * connector's local API is the contract, and anything this needs that the API
 * cannot give is a gap in the API rather than a job for the BFF. And it must
 * never reach for `apps/connector` — the lint rule enforces it, but the reason
 * is that a shortcut through the back door would make the "bring your own UI"
 * claim false while all the tests still passed.
 */
import { PilotsClient, ProblemError, TransportError } from '@pilots/client'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'

import { participantDids } from '@pilots/protocol'

import type { AuthService, SignedInUser } from './auth.js'
import type { ProcessUiConfig } from './config.js'
import { uiDidResolver, verifyLog } from './verification.js'

/** What the SPA sends for "Us". It holds no DID, and resolving one is the BFF's job. */
const SELF = '__self__'

const CreateInstanceBody = z.strictObject({
  definition: z.string().min(1),
  participants: z.record(z.string(), z.union([z.string(), z.array(z.string()).min(1)])),
  data: z.record(z.string(), z.json()).optional(),
  quotationId: z.string().nullish(),
  offering: z.string().nullish(),
})

/** A candidate definition, as the editor has it. Validated by the connector's linter. */
const DefinitionBody = z.strictObject({ definition: z.record(z.string(), z.unknown()) })

/**
 * Start a process from an offering.
 *
 * The offering names **two** definitions: the quotation a consumer instantiates
 * first, and the service that quotation authorises. Both instances are created
 * here, with the service pointing at the quotation — which is what lets the
 * link fire `startExecution` when the quotation is agreed. Leaving that to the
 * SPA would mean every client had to know the rule.
 */
const StartFromOfferingBody = z.strictObject({
  offering: z.string().min(1),
  quotationDefinition: z.string().min(1),
  serviceDefinition: z.string().min(1),
  participants: z.record(z.string(), z.union([z.string(), z.array(z.string()).min(1)])),
  data: z.record(z.string(), z.json()).optional(),
})

const TransitionBody = z.strictObject({
  transition: z.string().min(1),
  patch: z.union([z.record(z.string(), z.json()), z.null()]).optional(),
  attachments: z
    .array(
      z.strictObject({
        sha256: z.string().regex(/^sha256:[0-9a-f]{64}$/),
        mime: z.string().min(1),
        size: z.int().min(0),
      }),
    )
    .optional(),
  /** The `seq` the SPA read. Mandatory here for the same reason it is downstream. */
  ifMatch: z.int().min(1),
})

export function registerRoutes(
  fastify: FastifyInstance,
  config: ProcessUiConfig,
  auth: AuthService,
): void {
  const client = new PilotsClient({ baseUrl: config.connectorUrl, apiKey: config.apiKey })

  /** Who is driving, or `undefined`. Every route below gates on this. */
  async function userOf(request: FastifyRequest): Promise<SignedInUser | undefined> {
    return auth.userFor(toHeaders(request))
  }

  /**
   * The signed-in user's client.
   *
   * One key for the whole participant, `X-Actor-Ref` for the person. The
   * connector records the reference beside the event as local metadata and in
   * the audit log — never in the signed header, because peers do not need your
   * employees' names and a replicated chain cannot be retracted.
   */
  async function actingClient(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<PilotsClient | undefined> {
    const user = await userOf(request)
    if (!user) {
      void reply.status(401).send({ error: 'sign in first' })
      return undefined
    }
    return client.as(user.email)
  }

  /**
   * Pass a connector refusal through as it was given.
   *
   * The SPA has to be able to tell a `409` from a `502 peer-unreachable` — one
   * needs a re-read and a fresh decision, the other is worth retrying unchanged.
   * Flattening them into "something went wrong" here would throw away exactly
   * the distinction the problem types exist to carry.
   */
  async function relay<T>(reply: FastifyReply, work: () => Promise<T>): Promise<T | undefined> {
    try {
      return await work()
    } catch (cause) {
      if (cause instanceof ProblemError) {
        void reply.status(cause.status).send(cause.problem)
        return undefined
      }
      if (cause instanceof TransportError) {
        // Our own connector is down. Distinct from a *peer* being unreachable,
        // which arrives as an ordinary problem document above.
        void reply.status(503).send({
          type: 'urn:pilots:ui:connector-unreachable',
          title: 'The connector is not answering',
          status: 503,
          detail: cause.message,
        })
        return undefined
      }
      throw cause
    }
  }

  // ── who am I ─────────────────────────────────────────────────────────────

  fastify.get('/api/ui/session', async (request, reply) => {
    const user = await userOf(request)
    /*
     * Whose connector this is, asked rather than configured twice — and asked
     * before anybody signs in, because "which organisation is this screen?" is a
     * question the sign-in page has to answer too. A participant's DID is public
     * by construction: it is what peers resolve to check its signatures.
     */
    const me = await client.me().catch(() => undefined)
    return reply.send({
      user: user ?? null,
      participant: config.displayName,
      did: me?.did ?? null,
      // So a demo with two UIs side by side is never ambiguous about which is
      // which, and so a support question has an answer.
      connector: config.connectorUrl,
      // Whether to offer the demo affordances. Configuration, not a build mode.
      demoTools: config.demoTools,
    })
  })

  // ── discovery ────────────────────────────────────────────────────────────

  fastify.get('/api/ui/definitions', async (request, reply) => {
    const acting = await actingClient(request, reply)
    if (!acting) return
    const definitions = await relay(reply, () => acting.definitions())
    if (definitions) return reply.send({ definitions })
  })

  fastify.get('/api/ui/definitions/:ref', async (request, reply) => {
    const acting = await actingClient(request, reply)
    if (!acting) return
    const { ref } = request.params as { ref: string }
    const found = await relay(reply, () => acting.definition(ref))
    if (found) return reply.send(found)
  })

  fastify.post('/api/ui/definitions/lint', async (request, reply) => {
    const acting = await actingClient(request, reply)
    if (!acting) return

    const parsed = DefinitionBody.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid body' })
    }
    const result = await relay(reply, () => acting.lintDefinition(parsed.data.definition))
    if (result) return reply.send(result)
  })

  fastify.post('/api/ui/definitions', async (request, reply) => {
    const acting = await actingClient(request, reply)
    if (!acting) return

    const parsed = DefinitionBody.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid body' })
    }
    const published = await relay(reply, () => acting.publishDefinition(parsed.data.definition))
    if (published) return reply.status(201).send(published)
  })

  fastify.get('/api/ui/offerings', async (request, reply) => {
    const acting = await actingClient(request, reply)
    if (!acting) return
    const { peer } = request.query as { peer?: string }
    const offerings = await relay(reply, () => acting.offerings(peer))
    if (offerings) return reply.send({ offerings })
  })

  fastify.get('/api/ui/connections', async (request, reply) => {
    const acting = await actingClient(request, reply)
    if (!acting) return
    const connections = await relay(reply, () => acting.connections())
    if (connections) return reply.send({ connections })
  })

  // ── instances ────────────────────────────────────────────────────────────

  fastify.get('/api/ui/instances', async (request, reply) => {
    const acting = await actingClient(request, reply)
    if (!acting) return
    const instances = await relay(reply, () => acting.instances())
    if (instances) return reply.send({ instances })
  })

  fastify.get('/api/ui/instances/:id', async (request, reply) => {
    const acting = await actingClient(request, reply)
    if (!acting) return
    const { id } = request.params as { id: string }
    const instance = await relay(reply, () => acting.instance(id))
    if (instance) return reply.send(instance)
  })

  /**
   * The event log, with each event's verification status.
   *
   * Verified **here**, in the BFF, against the participants' published DID
   * documents — not taken from the connector's word for it. That is the point of
   * the log being signed: a UI that displayed a connector's own "all fine" would
   * be proving nothing at all.
   */
  fastify.get('/api/ui/instances/:id/events', async (request, reply) => {
    const acting = await actingClient(request, reply)
    if (!acting) return
    const { id } = request.params as { id: string }

    const events = await relay(reply, () => acting.events(id))
    if (!events) return
    const instance = await relay(reply, () => acting.instance(id))
    if (!instance) return
    const definition = await relay(reply, () => acting.definition(instance.definition))
    if (!definition) return

    // Where to fetch each participant's published document. Our own connector's
    // base URL for ourselves, and the peer base URLs its connection records
    // give for everybody else — fetched by us, not vouched for by it.
    const directory = new Map<string, string>()
    const connections = await relay(reply, () => acting.connections())
    for (const connection of connections ?? []) {
      directory.set(connection.peerDid, connection.peerBaseUrl)
    }
    for (const did of participantDids(instance.participants)) {
      if (!directory.has(did)) directory.set(did, config.connectorUrl)
    }

    const verification = await verifyLog(events, {
      resolver: uiDidResolver(directory),
      definition: definition.definition,
      participants: instance.participants,
      instanceId: instance.id,
    })

    return reply.send({ events, instance, verification })
  })

  /**
   * Start a process from an offering: the quotation, and the execution it
   * authorises, in one call.
   *
   * This is the piece that was missing. An offering names both definitions, and
   * the service instance has to be created **with `quotationId` set** — the
   * relation lives in the immutable genesis, so it cannot be added later, and
   * without it the link that fires `startExecution` has nothing to fire from.
   * The result was a process that reached agreement and then sat forever with
   * cancel as the only option.
   *
   * Both instances are created here rather than in the SPA so that no client
   * has to know the rule, and so a client that only wanted the quotation
   * cannot accidentally produce an execution that can never start.
   */
  fastify.post('/api/ui/offerings/start', async (request, reply) => {
    const acting = await actingClient(request, reply)
    if (!acting) return

    const parsed = StartFromOfferingBody.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid body' })
    }

    const me = await relay(reply, () => acting.me())
    if (!me) return
    const participants = Object.fromEntries(
      Object.entries(parsed.data.participants).map(([role, who]) => [
        role,
        who === SELF ? me.did : who,
      ]),
    )

    const quotation = await relay(reply, () =>
      acting.createInstance({
        definition: parsed.data.quotationDefinition,
        participants,
        ...(parsed.data.data === undefined ? {} : { data: parsed.data.data }),
        offering: parsed.data.offering,
      }),
    )
    if (!quotation) return

    /*
     * The execution, anchored to the quotation. Its own `data` starts empty:
     * the quotation's schema and the service's are different documents, and
     * copying one into the other would fail validation as often as not.
     */
    const service = await relay(reply, () =>
      acting.createInstance({
        definition: parsed.data.serviceDefinition,
        participants,
        quotationId: quotation.instance.id,
        offering: parsed.data.offering,
      }),
    )
    if (!service) return

    return reply.status(201).send({ quotation: quotation.instance, service: service.instance })
  })

  fastify.post('/api/ui/instances', async (request, reply) => {
    const acting = await actingClient(request, reply)
    if (!acting) return

    const parsed = CreateInstanceBody.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid body' })
    }

    // The SPA sends `__self__` for "Us" — it has no DID and should not. Resolve
    // it here, from the connector's own answer about whose key this is.
    const me = await relay(reply, () => acting.me())
    if (!me) return
    const participants = Object.fromEntries(
      Object.entries(parsed.data.participants).map(([role, who]) => [
        role,
        who === SELF ? me.did : who,
      ]),
    )

    const created = await relay(reply, () =>
      acting.createInstance({
        definition: parsed.data.definition,
        participants,
        ...(parsed.data.data === undefined ? {} : { data: parsed.data.data }),
        ...(parsed.data.quotationId ? { quotationId: parsed.data.quotationId } : {}),
        ...(parsed.data.offering ? { offering: parsed.data.offering } : {}),
      }),
    )
    if (created) return reply.status(201).send(created)
  })

  fastify.post('/api/ui/instances/:id/transitions', async (request, reply) => {
    const acting = await actingClient(request, reply)
    if (!acting) return

    const { id } = request.params as { id: string }
    const parsed = TransitionBody.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid body' })
    }

    const applied = await relay(reply, () =>
      acting.applyTransition(
        id,
        {
          transition: parsed.data.transition,
          ...(parsed.data.patch === undefined ? {} : { patch: parsed.data.patch }),
          ...(parsed.data.attachments === undefined
            ? {}
            : { attachments: parsed.data.attachments }),
        },
        parsed.data.ifMatch,
      ),
    )
    if (applied) return reply.send(applied)
  })

  // ── attachments ──────────────────────────────────────────────────────────

  fastify.post('/api/ui/attachments', async (request, reply) => {
    const acting = await actingClient(request, reply)
    if (!acting) return
    if (!Buffer.isBuffer(request.body)) {
      return reply.status(400).send({ error: 'send the raw bytes with their own content type' })
    }

    const mime = (request.headers['content-type'] ?? 'application/octet-stream').split(';')[0]!
    const ref = await relay(reply, () =>
      acting.uploadAttachment(new Uint8Array(request.body as Buffer), mime),
    )
    if (ref) return reply.status(201).send(ref)
  })

  fastify.get('/api/ui/attachments/:sha256', async (request, reply) => {
    const acting = await actingClient(request, reply)
    if (!acting) return
    const { sha256 } = request.params as { sha256: string }

    const blob = await relay(reply, () => acting.attachment(sha256))
    if (!blob) return
    return reply
      .header('content-type', blob.type || 'application/octet-stream')
      .send(Buffer.from(await blob.arrayBuffer()))
  })
}

/** Fastify's headers as the `Headers` better-auth expects. */
function toHeaders(request: FastifyRequest): Headers {
  const headers = new Headers()
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue
    headers.set(name, Array.isArray(value) ? (value[0] ?? '') : String(value))
  }
  return headers
}

export { toHeaders }
