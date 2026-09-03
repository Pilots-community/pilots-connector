/**
 * The BFF, against a scripted connector.
 *
 * Two things this tier has to prove, and neither is about business logic:
 *
 * - **The API key never leaves the server.** It is scoped to a whole
 *   participant; in a browser it would be readable by anyone with devtools. This
 *   is the reason the BFF exists at all, so it is asserted rather than assumed.
 * - **A signed-in user becomes an `X-Actor-Ref`.** The connector authenticates
 *   the key, not the person, and records who was driving as an unproven audit
 *   hint. If that translation broke, every audit entry would say "the UI".
 *
 * Business behaviour is not tested here. The connector's suite owns that, and
 * duplicating it would mean two places that could disagree about what a
 * transition does.
 */
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createAuth, type AuthService } from '../src/server/auth.js'
import { loadConfig, ConfigError, type ProcessUiConfig } from '../src/server/config.js'
import { registerRoutes } from '../src/server/routes.js'

const API_KEY = 'ak_01J0000000000000000000TEST.notarealsecret'

interface Seen {
  path: string
  method: string
  authorization: string | null
  actorRef: string | null
  body: unknown
}

/** A connector that records what the BFF asked it and answers plausibly. */
function fakeConnector(): { app: FastifyInstance; seen: Seen[]; url: () => string } {
  const seen: Seen[] = []
  const app = Fastify({ logger: false })

  app.addHook('onRequest', async (request) => {
    seen.push({
      path: request.url,
      method: request.method,
      authorization: (request.headers['authorization'] as string) ?? null,
      actorRef: (request.headers['x-actor-ref'] as string) ?? null,
      body: null,
    })
  })

  app.get('/api/local/v1/me', async () => ({
    participant: { id: 'org-a', did: 'did:web:org-a.example', displayName: 'Org A' },
  }))
  app.get('/api/local/v1/instances', async () => ({ instances: [] }))
  app.get('/api/local/v1/connections', async () => ({ connections: [] }))
  app.get('/api/local/v1/definitions', async () => ({ definitions: [] }))
  app.post('/api/local/v1/instances', async (request, reply) => {
    seen[seen.length - 1]!.body = request.body
    return reply.status(201).send({
      instance: { id: '01J0', state: 'ORDERED', seq: 1, available: [], redacted: false },
      events: [],
    })
  })
  app.post('/api/local/v1/instances/:id/transitions', async (_request, reply) =>
    reply.status(409).send({
      type: 'urn:pilots:problem:seq-conflict',
      title: 'Sequence conflict',
      status: 409,
      detail: 'If-Match is 1 but the instance is at 3',
      seq: 3,
    }),
  )

  return {
    app,
    seen,
    url: () => {
      const address = app.server.address() as { port: number }
      return `http://127.0.0.1:${address.port}`
    },
  }
}

function config(connectorUrl: string): ProcessUiConfig {
  return loadConfig({
    PILOTS_UI_PORT: '0',
    PILOTS_CONNECTOR_URL: connectorUrl,
    PILOTS_API_KEY: API_KEY,
    PILOTS_UI_NAME: 'Org A',
    PILOTS_UI_LOG_LEVEL: 'silent',
    NODE_ENV: 'test',
    PILOTS_UI_SEED_EMAIL: 'alice@org-a.example',
    PILOTS_UI_SEED_PASSWORD: 'correct-horse-battery',
  })
}

let connector: ReturnType<typeof fakeConnector>
let ui: FastifyInstance
let auth: AuthService
let cookie: string

beforeEach(async () => {
  connector = fakeConnector()
  await connector.app.listen({ port: 0, host: '127.0.0.1' })

  const settings = config(connector.url())
  ui = Fastify({ logger: false })
  auth = createAuth(settings, 'http://localhost')
  await auth.seed()

  ui.all('/api/auth/*', async (request, reply) => {
    const headers = new Headers()
    for (const [name, value] of Object.entries(request.headers)) {
      if (value !== undefined) headers.set(name, String(value))
    }
    const response = await auth.handler(
      new Request(new URL(request.url, 'http://localhost'), {
        method: request.method,
        headers,
        ...(request.method === 'GET' ? {} : { body: JSON.stringify(request.body) }),
      }),
    )
    reply.status(response.status)
    response.headers.forEach((value, key) => void reply.header(key, value))
    return reply.send(Buffer.from(await response.arrayBuffer()))
  })

  registerRoutes(ui, settings, auth)
  await ui.ready()

  const signedIn = await ui.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    payload: { email: 'alice@org-a.example', password: 'correct-horse-battery' },
  })
  cookie = signedIn.headers['set-cookie'] as string
  connector.seen.length = 0
})

afterEach(async () => {
  await ui.close()
  await connector.app.close()
})

const signedIn = () => ({ cookie })

describe('the credential boundary', () => {
  it('never sends the API key to the browser', async () => {
    const session = await ui.inject({ method: 'GET', url: '/api/ui/session', headers: signedIn() })
    const instances = await ui.inject({
      method: 'GET',
      url: '/api/ui/instances',
      headers: signedIn(),
    })

    // Not in a body, not in a header, not anywhere. This is the whole reason the
    // BFF exists: a participant-wide credential in a SPA is a credential in
    // everybody's devtools.
    for (const response of [session, instances]) {
      expect(response.body).not.toContain(API_KEY)
      expect(JSON.stringify(response.headers)).not.toContain(API_KEY)
    }
  })

  it('refuses every route to a caller who has not signed in', async () => {
    for (const url of [
      '/api/ui/instances',
      '/api/ui/definitions',
      '/api/ui/connections',
      '/api/ui/offerings',
    ]) {
      const response = await ui.inject({ method: 'GET', url })
      expect(response.statusCode).toBe(401)
    }
    // And it did not ask the connector anything on their behalf.
    expect(connector.seen).toHaveLength(0)
  })

  it('turns the signed-in user into an X-Actor-Ref on every connector call', async () => {
    await ui.inject({ method: 'GET', url: '/api/ui/instances', headers: signedIn() })

    const call = connector.seen.find((one) => one.path.startsWith('/api/local/v1/instances'))
    expect(call?.authorization).toBe(`ApiKey ${API_KEY}`)
    // The connector authenticates the key and records the person. It has no
    // idea who alice is, and must not.
    expect(call?.actorRef).toBe('alice@org-a.example')
  })

  it('resolves "us" to our own DID, which the browser never has to know', async () => {
    await ui.inject({
      method: 'POST',
      url: '/api/ui/instances',
      headers: signedIn(),
      payload: {
        definition: 'container-weighing@1.0.0',
        participants: { shipper: '__self__', weigher: 'did:web:org-b.example' },
      },
    })

    const created = connector.seen.find(
      (one) => one.method === 'POST' && one.path === '/api/local/v1/instances',
    )
    expect((created?.body as { participants: Record<string, string> }).participants).toEqual({
      shipper: 'did:web:org-a.example',
      weigher: 'did:web:org-b.example',
    })
  })
})

describe('a refusal reaches the browser intact', () => {
  it('passes a conflict through with its type and its seq', async () => {
    const response = await ui.inject({
      method: 'POST',
      url: '/api/ui/instances/01J0/transitions',
      headers: signedIn(),
      payload: { transition: 'weigh', ifMatch: 1 },
    })

    expect(response.statusCode).toBe(409)
    const problem = response.json<{ type: string; seq: number }>()
    // Flattened into "something went wrong", a UI could not tell the user to
    // re-read rather than retry — which is the difference that matters.
    expect(problem.type).toContain('seq-conflict')
    expect(problem.seq).toBe(3)
  })

  it('reports its own connector being down as distinct from a peer being down', async () => {
    await connector.app.close()

    const response = await ui.inject({
      method: 'GET',
      url: '/api/ui/instances',
      headers: signedIn(),
    })

    expect(response.statusCode).toBe(503)
    expect(response.json<{ type: string }>().type).toContain('connector-unreachable')
  })
})

describe('configuration refuses what it should', () => {
  it('will not start without an API key', () => {
    expect(() =>
      loadConfig({ PILOTS_CONNECTOR_URL: 'http://localhost:3000', NODE_ENV: 'test' }),
    ).toThrow(ConfigError)
  })

  it('will not seed a known password in production', () => {
    expect(() =>
      loadConfig({
        PILOTS_CONNECTOR_URL: 'http://localhost:3000',
        PILOTS_API_KEY: API_KEY,
        NODE_ENV: 'production',
        PILOTS_UI_SEED_EMAIL: 'alice@org-a.example',
        PILOTS_UI_SEED_PASSWORD: 'correct-horse-battery',
      }),
    ).toThrow(/cannot be used with NODE_ENV=production/)
  })
})

/**
 * Session cookies are scoped to this UI, not to the host.
 *
 * A regression test with a scar. Both process UIs used better-auth's default
 * cookie name, and **cookies ignore the port** — so `localhost:4000` and
 * `localhost:4001` addressed the same cookie. Signing into one silently signed
 * the other out, which looked exactly like "refreshing logs me out" to anyone
 * driving both orgs side by side.
 *
 * The e2e suite could not have caught it: it opens the second UI with
 * `browser.newPage()`, which is a fresh browser context with its own cookie
 * jar, so the two never collided there.
 */
describe('session cookies are scoped to this UI', () => {
  const base = {
    PILOTS_CONNECTOR_URL: 'http://localhost:3000',
    PILOTS_API_KEY: API_KEY,
    NODE_ENV: 'test' as const,
  }

  it('defaults the prefix, and takes it from configuration', () => {
    expect(loadConfig(base).cookiePrefix).toBe('pilots')
    expect(loadConfig({ ...base, PILOTS_UI_COOKIE_PREFIX: 'org-a' }).cookiePrefix).toBe('org-a')
  })

  it('refuses a prefix that would not be a legal cookie name', () => {
    expect(() => loadConfig({ ...base, PILOTS_UI_COOKIE_PREFIX: 'Org A' })).toThrow(ConfigError)
  })

  it('names the cookie after the prefix, so two UIs on one host do not collide', async () => {
    const settings = loadConfig({
      ...base,
      PILOTS_UI_COOKIE_PREFIX: 'org-a',
      PILOTS_UI_SEED_EMAIL: 'alice@org-a.example',
      PILOTS_UI_SEED_PASSWORD: 'correct-horse-battery',
    })
    const isolated = createAuth(settings, 'http://localhost')
    await isolated.seed()

    const response = await isolated.handler(
      new Request('http://localhost/api/auth/sign-in/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'alice@org-a.example',
          password: 'correct-horse-battery',
        }),
      }),
    )

    const setCookie = response.headers.get('set-cookie') ?? ''
    expect(setCookie).toContain('org-a.session_token')
    expect(setCookie).not.toContain('better-auth.session_token')
  })
})
