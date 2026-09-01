/**
 * Serve the admin UI from the connector itself.
 *
 * The "minimal admin UI, built in and served by it" is what keeps the headless
 * integrator's container count at **one**: an operator needs somewhere to mint a
 * key and read the audit log, and a second container for that would undo the
 * whole cost argument.
 *
 * If the UI has not been built, the connector still runs — it simply says so.
 * A missing static bundle must never stop a node from serving its APIs.
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { NestFastifyApplication } from '@nestjs/platform-fastify'

import type { LogService } from '../logging/log.service.js'

/** `dist/http/` at runtime, `src/http/` under ts-node; the UI sits beside both. */
function adminUiRoot(): string {
  const here = dirname(__filename)
  for (const candidate of [join(here, '../admin-ui/dist'), join(here, '../../src/admin-ui/dist')]) {
    if (existsSync(join(candidate, 'index.html'))) return candidate
  }
  return join(here, '../admin-ui/dist')
}

export async function serveAdminUi(app: NestFastifyApplication, log: LogService): Promise<boolean> {
  const root = adminUiRoot()
  if (!existsSync(join(root, 'index.html'))) {
    log.warn({ root }, 'admin UI is not built; run `pnpm build:ui`. The APIs are unaffected.')
    return false
  }

  const fastifyStatic = (await import('@fastify/static')).default
  await app.register(fastifyStatic, { root, prefix: '/admin/', decorateReply: false })

  const instance = app.getHttpAdapter().getInstance()
  // A single-page app: unknown paths under /admin resolve to its entry point.
  instance.get('/admin', (_request, reply) => reply.redirect('/admin/', 302))

  log.info({ root }, 'admin UI available at /admin/')
  return true
}
