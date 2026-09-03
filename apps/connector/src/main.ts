/**
 * The connector's entry point.
 *
 * One container, no database. What it prints on first boot matters: a generated
 * admin token is shown exactly once, because it is never stored in the clear and
 * cannot be recovered afterwards.
 */
import 'reflect-metadata'

import { NestFactory } from '@nestjs/core'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'

import { AppModule } from './app.module.js'
import { serveAdminUi } from './http/admin-ui.js'
import { acceptRawBodies } from './http/raw-body.js'
import { ProblemFilter } from './http/problem.filter.js'
import { loadConfig } from './config/config.js'
import { createRuntime } from './runtime.js'

async function main(): Promise<void> {
  const startedAt = process.hrtime.bigint()
  const config = loadConfig()
  const runtime = await createRuntime(config)

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.forRuntime(runtime),
    // The body limit is the attachment limit plus room for the JSON around it,
    // so the two cannot drift into a state where an accepted upload is refused
    // by the transport.
    new FastifyAdapter({ bodyLimit: config.maxAttachmentBytes + 1024 * 1024 }),
    { logger: false },
  )
  acceptRawBodies(app.getHttpAdapter().getInstance())
  app.useGlobalFilters(new ProblemFilter(runtime.log))
  const adminUi = await serveAdminUi(app, runtime.log)
  await app.listen(config.port, config.host)

  /*
   * The delivery scan loop.
   *
   * One interval drives every pump, and each pump compares a stored timestamp
   * against `Clock`. That is the difference the design insists on: there is no
   * `setTimeout` per retry, per deadline or per subscription, so nothing is lost
   * on restart, nothing is unschedulable in the file store, and a test advances
   * a ten-minute backoff with a function call.
   */
  const ticker =
    config.deliveryIntervalMs > 0
      ? setInterval(() => {
          void runtime.tick().catch((error: unknown) => {
            runtime.log.error({ err: String(error) }, 'delivery tick failed')
          })
        }, config.deliveryIntervalMs)
      : undefined
  ticker?.unref()

  // Attach to every peer we hold a line to, before announcing we are ready.
  await runtime.peerStreams.sync()

  const ready = Number(process.hrtime.bigint() - startedAt) / 1e6

  runtime.log.info(
    {
      port: config.port,
      store: config.store.adapter,
      participants: runtime.identity.all.map((p) => p.did),
      definitions: runtime.registry.size,
      adminUi: adminUi ? '/admin/' : 'not built',
      peerStreams: runtime.peerStreams.attached,
      peerTransport: config.peerTransport,
      coldStartMs: Math.round(ready),
      rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    },
    'connector listening',
  )

  if (runtime.identity.report.ephemeral) {
    runtime.log.warn(
      { secretStore: runtime.identity.report.secretStore },
      'signing keys and the API-key pepper were generated but cannot be persisted: they will change on restart, invalidating every API key and moving this participant’s DID document',
    )
  }

  if (runtime.adminToken !== undefined) {
    runtime.log.warn(
      { adminToken: runtime.adminToken },
      runtime.adminTokenSeeded
        ? 'admin bootstrap token set from PILOTS_SEED_ADMIN_TOKEN; development only, and it is already in your configuration.'
        : // Shown once. It is stored only as an HMAC, so there is no way to print
          // it again — which is the point.
          'first boot: this is the admin token for /api/admin/v1. It is shown once and cannot be recovered.',
    )
  }

  if (config.devDidDirectory) {
    runtime.log.warn(
      {},
      'PILOTS_DEV_DID_DIRECTORY is on: peer DIDs are resolved through their configured base URL instead of did:web, which reduces the domain-binding check to "an operator configured it". Development only.',
    )
  }

  const shutdown = async (signal: string): Promise<void> => {
    runtime.log.info({ signal }, 'shutting down')
    if (ticker) clearInterval(ticker)
    await app.close()
    await runtime.close()
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  process.exit(1)
})
