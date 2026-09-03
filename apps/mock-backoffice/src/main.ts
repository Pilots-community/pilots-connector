/**
 * The mock backoffice, as a container.
 *
 * It exists so that "one side automates, the other clicks" is a **deployment
 * difference** rather than a slide: Van Moer runs this instead of a UI, Acme
 * runs a UI, and the connectors cannot tell the difference. Same image, same
 * API, same key — one is a person clicking and one is a machine reacting.
 *
 * Two ways in, because a real integrator has to choose one:
 *
 * - **Webhook** (`POST /hook`): the connector pushes. What a party with a
 *   reachable endpoint does.
 * - **Catch-up poll**: `GET /notifications?since=` on a timer, which is
 *   authoritative and is how this recovers from having been down. Also the whole
 *   integration for a party that would rather not accept inbound requests at all.
 *
 * It holds one API key and no state that matters. Stop it, start it, and it
 * picks up from its cursor.
 */
import { PilotsClient } from '@pilots/client'
import Fastify from 'fastify'
import { z } from 'zod'

import { Backoffice, type BusinessData } from './backoffice.js'

const Config = z.strictObject({
  port: z.int().min(0).max(65535),
  connectorUrl: z.url(),
  apiKey: z.string().min(1),
  actorRef: z.string().min(1),
  secret: z.union([z.string().min(1), z.null()]),
  /** How often to poll for anything the webhook missed. `0` disables it. */
  pollMs: z.int().min(0),
  data: z.record(z.string(), z.unknown()),
})

function loadConfig(env = process.env): z.infer<typeof Config> {
  const raw = env['PILOTS_BACKOFFICE_DATA']
  let data: unknown = {}
  if (raw !== undefined && raw.trim() !== '') {
    try {
      data = JSON.parse(raw)
    } catch (cause) {
      throw new Error(`PILOTS_BACKOFFICE_DATA is not valid JSON: ${(cause as Error).message}`, {
        cause,
      })
    }
  }

  const parsed = Config.safeParse({
    port: Number(env['PILOTS_BACKOFFICE_PORT'] ?? 5000),
    connectorUrl: env['PILOTS_CONNECTOR_URL'] ?? 'http://localhost:3000',
    apiKey: (env['PILOTS_API_KEY'] ?? '').trim(),
    actorRef: env['PILOTS_BACKOFFICE_ACTOR'] ?? 'backoffice',
    secret: env['PILOTS_BACKOFFICE_SECRET'] ?? null,
    pollMs: Number(env['PILOTS_BACKOFFICE_POLL_MS'] ?? 2000),
    data,
  })
  if (!parsed.success) {
    throw new Error(
      `invalid configuration:\n${parsed.error.issues
        .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('\n')}`,
    )
  }
  if (parsed.data.apiKey === '') {
    throw new Error(
      'PILOTS_API_KEY is required: this is an ordinary integrator with an ordinary key',
    )
  }
  return parsed.data
}

async function main(): Promise<void> {
  const config = loadConfig()
  const fastify = Fastify({
    logger: {
      level: process.env['PILOTS_BACKOFFICE_LOG_LEVEL'] ?? 'info',
      redact: { paths: ['req.headers.authorization'], censor: '[redacted]' },
    },
  })

  const client = new PilotsClient({
    baseUrl: config.connectorUrl,
    apiKey: config.apiKey,
    // An audit hint, so the log says a machine did this rather than a person.
    actorRef: config.actorRef,
  })

  const backoffice = new Backoffice({
    client,
    data: config.data as Record<string, BusinessData>,
    secret: config.secret ?? undefined,
    log: (message, context) => fastify.log.info(context ?? {}, message),
  })

  /*
   * The raw body, so the HMAC covers exactly the bytes that were signed.
   *
   * `application/json` is named explicitly: a catch-all only runs for content
   * types nothing else claimed, and Fastify claims JSON by default. Letting it
   * parse and then re-serialising would compare the signature against different
   * bytes — same data, different whitespace and key order, different hash.
   */
  for (const type of ['application/json', '*']) {
    fastify.addContentTypeParser(type, { parseAs: 'string' }, (_request, body, done) => {
      done(null, body)
    })
  }

  fastify.post('/hook', async (request, reply) => {
    const body = typeof request.body === 'string' ? request.body : ''
    const signature = request.headers['x-pilots-signature']
    if (!backoffice.verify(body, Array.isArray(signature) ? signature[0] : signature)) {
      // A webhook arriving on an internal interface is not thereby trustworthy.
      fastify.log.warn({}, 'refused a delivery with a bad or missing signature')
      return reply.status(401).send({ error: 'signature' })
    }

    const parsed = JSON.parse(body) as { notifications?: unknown[] }
    const handled = await backoffice.receive((parsed.notifications ?? []) as never)
    return reply.send({ handled })
  })

  fastify.get('/healthz', async () => ({ ok: true }))

  await fastify.listen({ port: config.port, host: '0.0.0.0' })
  fastify.log.info(
    {
      port: config.port,
      connector: config.connectorUrl,
      knows: Object.keys(config.data),
      pollMs: config.pollMs,
    },
    'backoffice listening — no UI, no human, no state machine',
  )

  /*
   * The catch-up poll.
   *
   * Not a fallback for a flaky webhook so much as the recovery path: this
   * process can be restarted at any moment, and `?since=` is authoritative, so
   * nothing needs an operator to notice. It also means a party that refuses
   * inbound requests entirely can drop the webhook and change nothing else.
   */
  let cursor: string | undefined
  if (config.pollMs > 0) {
    const timer = setInterval(() => {
      void backoffice
        .catchUp(cursor)
        .then(({ cursor: next }) => {
          if (next !== null) cursor = next
        })
        .catch((cause: unknown) => {
          fastify.log.warn({ err: String(cause) }, 'catch-up failed; will try again')
        })
    }, config.pollMs)
    timer.unref()
  }

  const shutdown = async (signal: string): Promise<void> => {
    fastify.log.info({ signal }, 'shutting down')
    await fastify.close()
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  process.exit(1)
})
