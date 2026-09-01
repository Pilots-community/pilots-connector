import { Test } from '@nestjs/testing'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'

import { FakeClock, deterministicIdGenerator } from '@pilots/protocol/testing'

import { AppModule } from '../../src/app.module.js'
import { loadConfig, type ConnectorConfig } from '../../src/config/config.js'
import { ProblemFilter } from '../../src/http/problem.filter.js'
import { MemorySecretStore } from '../../src/secrets/secret-store.js'
import { createRuntime, type Runtime } from '../../src/runtime.js'
import { ACME, DEFINITIONS_DIR, VANMOER } from './core.js'

export interface TestApp {
  app: NestFastifyApplication
  runtime: Runtime
  clock: FakeClock
  adminToken: string
  close(): Promise<void>
}

/** Log output is captured, not printed: a test run should be quiet. */
class Sink {
  readonly lines: string[] = []
  write(chunk: string): boolean {
    this.lines.push(chunk)
    return true
  }
}

export const logSink = new Sink()

export function testConfig(overrides: Partial<ConnectorConfig> = {}): ConnectorConfig {
  return {
    ...loadConfig({
      PILOTS_PORT: '0',
      PILOTS_STORE: 'memory',
      PILOTS_DEFINITIONS_DIR: DEFINITIONS_DIR,
      NODE_ENV: 'test',
      PILOTS_LOG_LEVEL: 'silent',
      PILOTS_PARTICIPANTS: JSON.stringify([ACME, VANMOER]),
      // One connector, no peers: these tests are about the HTTP surfaces, and a
      // connector with nowhere to relay to is exactly the M2 shape they assert.
      PILOTS_PEER_TRANSPORT: 'none',
      PILOTS_DELIVERY_INTERVAL_MS: '0',
    }),
    ...overrides,
  }
}

export async function buildTestApp(): Promise<TestApp> {
  const clock = new FakeClock('2026-08-24T09:00:00.000Z')
  const runtime = await createRuntime(testConfig(), {
    clock,
    ids: deterministicIdGenerator(11, clock),
    secrets: new MemorySecretStore(),
    logDestination: logSink as unknown as NodeJS.WritableStream,
  })

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.forRuntime(runtime)],
  }).compile()

  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
    logger: false,
  })
  app.useGlobalFilters(new ProblemFilter(runtime.log))
  await app.init()
  await app.getHttpAdapter().getInstance().ready()

  if (runtime.adminToken === undefined) throw new Error('expected a generated admin token')

  return {
    app,
    runtime,
    clock,
    adminToken: runtime.adminToken,
    close: async () => {
      await app.close()
      await runtime.close()
    },
  }
}

/** Sign in and mint an API key per participant — what an operator does once. */
export async function provision(
  testApp: TestApp,
  participantId: string,
  scopes: string[] = [
    'instances:read',
    'instances:write',
    'events:read',
    'definitions:read',
    'connections:read',
  ],
): Promise<{ session: string; apiKey: string }> {
  const signIn = await testApp.app.inject({
    method: 'POST',
    url: '/api/admin/v1/sessions',
    payload: { token: testApp.adminToken },
  })
  const session = signIn.json<{ session: { id: string } }>().session.id

  const minted = await testApp.app.inject({
    method: 'POST',
    url: '/api/admin/v1/apikeys',
    headers: { authorization: `Session ${session}` },
    payload: { label: `${participantId}-integration`, scopes, participantId },
  })
  if (minted.statusCode !== 201) throw new Error(`mint failed: ${minted.body}`)

  return { session, apiKey: minted.json<{ secret: string }>().secret }
}
