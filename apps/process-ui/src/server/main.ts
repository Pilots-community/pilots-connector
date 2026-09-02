/**
 * The process UI's entry point.
 *
 * One container, and a deliberately dispensable one. **Stop it and the connector
 * carries on**: processes keep running, peers keep delivering, the backoffice
 * keeps receiving notifications. That is the whole argument for the split — this
 * is a client, not part of the runtime, and it holds nothing the connector needs.
 *
 * It talks to its connector over the ordinary local API with an ordinary API
 * key. There is no privileged channel, and there is nothing here a third party
 * could not build.
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'

import fastifyStatic from '@fastify/static'
import Fastify from 'fastify'

import { createAuth } from './auth.js'
import { loadConfig } from './config.js'
import { registerRoutes, toHeaders } from './routes.js'

const here = dirname(fileURLToPath(import.meta.url))

async function main(): Promise<void> {
  const startedAt = process.hrtime.bigint()
  const config = loadConfig()

  const fastify = Fastify({
    logger: {
      level: config.logLevel,
      // The API key must never reach a log line. It is the one credential this
      // process holds, and it is scoped to a whole participant.
      redact: { paths: ['req.headers.authorization', 'apiKey'], censor: '[redacted]' },
    },
  })

  // The SPA and the BFF share an origin, so `baseURL` is what the browser used.
  const baseURL = process.env['PILOTS_UI_BASE_URL'] ?? `http://localhost:${config.port}`
  const auth = createAuth(config, baseURL)
  await auth.seed()

  // Raw bytes for attachment uploads; JSON is untouched, because a catch-all
  // parser only runs for content types nothing else claimed.
  fastify.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) => {
    done(null, body)
  })

  // better-auth speaks the web `Request`/`Response` pair, so the bridge is two
  // conversions and no logic.
  fastify.all('/api/auth/*', async (request, reply) => {
    const url = new URL(request.url, baseURL)
    const response = await auth.handler(
      new Request(url, {
        method: request.method,
        headers: toHeaders(request),
        ...(request.method === 'GET' || request.method === 'HEAD'
          ? {}
          : { body: Buffer.isBuffer(request.body) ? request.body : JSON.stringify(request.body) }),
      }),
    )
    reply.status(response.status)
    response.headers.forEach((value, key) => {
      // `set-cookie` may legitimately repeat; everything else is single-valued.
      if (key.toLowerCase() === 'set-cookie') void reply.header('set-cookie', value)
      else void reply.header(key, value)
    })
    return reply.send(Buffer.from(await response.arrayBuffer()))
  })

  registerRoutes(fastify, config, auth)

  fastify.get('/healthz', async () => ({ ok: true }))

  // The built SPA, when there is one. `pnpm dev:web` serves it from Vite
  // instead, so a missing build is a development state rather than a failure.
  const web = join(here, '..', 'web')
  if (existsSync(join(web, 'index.html'))) {
    await fastify.register(fastifyStatic, { root: web })
    fastify.setNotFoundHandler(async (request, reply) => {
      if (request.url.startsWith('/api/')) return reply.status(404).send({ error: 'no such route' })
      // A single-page app: every other path is its router's business.
      return reply.sendFile('index.html')
    })
  }

  await fastify.listen({ port: config.port, host: config.host })

  fastify.log.info(
    {
      port: config.port,
      connector: config.connectorUrl,
      participant: config.displayName,
      spa: existsSync(join(web, 'index.html')) ? 'built' : 'not built (run `pnpm build:web`)',
      coldStartMs: Math.round(Number(process.hrtime.bigint() - startedAt) / 1e6),
    },
    'process UI listening',
  )

  if (config.seedUser) {
    fastify.log.warn(
      { email: config.seedUser.email },
      'a demo account was created at boot from PILOTS_UI_SEED_EMAIL. Development only.',
    )
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
