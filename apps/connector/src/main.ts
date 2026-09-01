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
import { ProblemFilter } from './http/problem.filter.js'
import { loadConfig } from './config/config.js'
import { createRuntime } from './runtime.js'

async function main(): Promise<void> {
  const startedAt = process.hrtime.bigint()
  const config = loadConfig()
  const runtime = await createRuntime(config)

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.forRuntime(runtime),
    new FastifyAdapter({ bodyLimit: 2 * 1024 * 1024 }),
    { logger: false },
  )
  app.useGlobalFilters(new ProblemFilter(runtime.log))
  const adminUi = await serveAdminUi(app, runtime.log)
  await app.listen(config.port, config.host)

  const ready = Number(process.hrtime.bigint() - startedAt) / 1e6

  runtime.log.info(
    {
      port: config.port,
      store: config.store.adapter,
      participants: runtime.identity.all.map((p) => p.did),
      definitions: runtime.registry.size,
      adminUi: adminUi ? '/admin/' : 'not built',
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
    // Shown once. It is stored only as an HMAC, so there is no way to print it
    // again — which is the point.
    runtime.log.warn(
      { adminToken: runtime.adminToken },
      'first boot: this is the admin token for /api/admin/v1. It is shown once and cannot be recovered.',
    )
  }

  const shutdown = async (signal: string): Promise<void> => {
    runtime.log.info({ signal }, 'shutting down')
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
