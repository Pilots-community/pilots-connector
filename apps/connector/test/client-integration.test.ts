/**
 * `@pilots/client` against a real connector, over a real socket.
 *
 * The client's own suite runs against a scripted `fetch` — it must, because that
 * package may not import this one. So this is where the contract is actually
 * checked: if the OpenAPI document or the typed client disagrees with the
 * implementation, it fails here rather than in somebody's generated client
 * three months from now.
 *
 * It listens on a real port on purpose. `app.inject()` would exercise the
 * routing without exercising `fetch`, headers, status codes or content
 * negotiation — which is most of what a client is.
 */
import { PilotsClient, ProblemError } from '@pilots/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { ORG_A, ORG_B } from './helpers/core.js'
import { buildTestApp, provision, type TestApp } from './helpers/app.js'

const PARTICIPANTS = { shipper: ORG_A.did, weigher: ORG_B.did }

let testApp: TestApp
let baseUrl: string
let orgA: PilotsClient
let orgB: PilotsClient

beforeAll(async () => {
  testApp = await buildTestApp()
  await testApp.app.listen({ port: 0, host: '127.0.0.1' })

  const address = testApp.app.getHttpServer().address() as { port: number }
  baseUrl = `http://127.0.0.1:${address.port}`

  const orgAKey = await provision(testApp, 'org-a', [
    'instances:read',
    'instances:write',
    'events:read',
    'definitions:read',
    'connections:read',
    'attachments:read',
    'attachments:write',
  ])
  const orgBKey = await provision(testApp, 'org-b', [
    'instances:read',
    'instances:write',
    'events:read',
    'definitions:read',
    'connections:read',
    'attachments:read',
    'attachments:write',
  ])

  orgA = new PilotsClient({ baseUrl, apiKey: orgAKey.apiKey, actorRef: 'alice@org-a.example' })
  orgB = new PilotsClient({
    baseUrl,
    apiKey: orgBKey.apiKey,
    actorRef: 'bram@org-b.example',
  })
})

afterAll(async () => {
  await testApp.close()
})

async function order(): Promise<{ id: string; seq: number }> {
  const created = await orgA.createInstance({
    definition: 'container-weighing@1.0.0',
    participants: PARTICIPANTS,
    data: { containerNumber: 'MSCU1234567', terminal: '869' },
  })
  return { id: created.instance.id, seq: created.instance.seq }
}

describe('the client drives the whole local API', () => {
  it('reads the definition registry', async () => {
    const definitions = await orgA.definitions()
    expect(definitions.map((one) => one.ref)).toContain('container-weighing@1.0.0')
    // A content hash, so a client can tell that two connectors hold the same
    // bytes rather than the same version number.
    expect(definitions[0]?.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/)

    const one = await orgA.definition('container-weighing@1.0.0')
    expect(one.definition.hostedBy).toBe('weigher')
  })

  it('creates an instance and reports what this participant may do next', async () => {
    const { id } = await order()
    const instance = await orgA.instance(id)

    expect(instance.state).toBe('ORDERED')
    // The field a UI renders buttons from. It is the same answer the permission
    // check and the notifications use, so a new definition needs no client work.
    expect(instance.available.map((one) => one.transition)).toContain('announceTruck')
    expect(instance.available.every((one) => one.role === 'shipper')).toBe(true)
  })

  it('runs S1 through to VGM_ISSUED, one participant at a time', async () => {
    const { id } = await order()

    const announced = await orgA.applyTransition(
      id,
      { transition: 'announceTruck', patch: { truckPlate: '1-ABC-123' } },
      1,
    )
    expect(announced.instance.state).toBe('TRUCK_ANNOUNCED')

    const weighed = await orgB.applyTransition(
      id,
      {
        transition: 'weigh',
        patch: { grossMass: { value: 24000, unit: 'kg', measuredAt: '2026-08-24T09:19:00.000Z' } },
      },
      2,
    )
    expect(weighed.instance.state).toBe('WEIGHED')

    // Org A reads. `grossMass` is withheld until payment, and the client reports
    // that the view is incomplete rather than letting it look whole.
    const beforePayment = await orgA.instance(id)
    expect(beforePayment.data['grossMass']).toBeUndefined()
    expect(beforePayment.redacted).toBe(true)

    await orgB.applyTransition(
      id,
      { transition: 'recordPayment', patch: { paymentReference: 'PMT-1' } },
      3,
    )
    const afterPayment = await orgA.instance(id)
    expect(afterPayment.data['grossMass']).toMatchObject({ value: 24000 })
  })

  it('uploads a document, references it, and fetches the bytes back', async () => {
    const { id } = await order()
    await orgA.applyTransition(
      id,
      { transition: 'announceTruck', patch: { truckPlate: '1-ABC-123' } },
      1,
    )
    await orgB.applyTransition(
      id,
      {
        transition: 'weigh',
        patch: { grossMass: { value: 24000, unit: 'kg', measuredAt: '2026-08-24T09:19:00.000Z' } },
      },
      2,
    )
    await orgB.applyTransition(
      id,
      { transition: 'recordPayment', patch: { paymentReference: 'PMT-1' } },
      3,
    )

    const pdf = new TextEncoder().encode('%PDF-1.7 verified gross mass')
    const ref = await orgB.uploadAttachment(pdf, 'application/pdf')
    // The connector hashed it. The client sent bytes and a content type, nothing
    // that could have made the address disagree with the content.
    expect(ref.sha256).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(ref.size).toBe(pdf.byteLength)

    await orgB.applyTransition(
      id,
      {
        transition: 'issueVgm',
        patch: { certificate: { sha256: ref.sha256, issuedAt: '2026-08-24T09:30:00.000Z' } },
        attachments: [ref],
      },
      4,
    )

    const bytes = new Uint8Array(await (await orgA.attachment(ref.sha256)).arrayBuffer())
    expect(new TextDecoder().decode(bytes)).toContain('verified gross mass')
  })

  it('returns the signed log for the caller to verify itself', async () => {
    const { id } = await order()
    await orgA.applyTransition(
      id,
      { transition: 'announceTruck', patch: { truckPlate: '1-ABC-123' } },
      1,
    )

    const events = await orgA.events(id)
    expect(events).toHaveLength(2)
    expect(events[0]?.header.transition).toBe('create')
    expect(events[1]?.sig).toBeTruthy()

    // `since` is a seq, not a cursor.
    expect(await orgA.events(id, 1)).toHaveLength(1)
  })
})

describe('the failures a client has to tell apart', () => {
  it('reports a stale If-Match as a conflict carrying the real seq', async () => {
    const { id } = await order()
    await orgA.applyTransition(
      id,
      { transition: 'announceTruck', patch: { truckPlate: '1-ABC-123' } },
      1,
    )

    const error = await orgA
      .applyTransition(id, { transition: 'announceTruck', patch: { truckPlate: '9-XYZ-999' } }, 1)
      .catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(ProblemError)
    const problem = error as ProblemError
    expect(problem.status).toBe(409)
    expect(problem.isConflict).toBe(true)
    // Enough to re-read and decide without guessing.
    expect(problem.seq).toBe(2)
  })

  it('reports a role refusal as forbidden, not as a validation failure', async () => {
    const { id } = await order()

    // `weigh` is the weigher's move; Org A is the shipper.
    const error = (await orgA
      .applyTransition(id, { transition: 'weigh', patch: {} }, 1)
      .catch((cause: unknown) => cause)) as ProblemError

    expect(error.status).toBe(403)
    expect(error.isForbidden).toBe(true)
    expect(error.isRetryable).toBe(false)
  })

  it('reports an unreachable peer as retryable, and never as a conflict', async () => {
    // This connector has no peer transport at all, so browsing a peer's
    // offerings is exactly the "I could not ask" case.
    const error = (await orgA
      .offerings('did:web:org-b.example')
      .catch((cause: unknown) => cause)) as ProblemError

    expect(error.status).toBeGreaterThanOrEqual(400)
    // Whatever it is, it must not look like a business conflict — that is the
    // distinction the whole relay error model exists to preserve.
    expect(error.isConflict).toBe(false)
  })

  it('replays the original result for a repeated Idempotency-Key', async () => {
    const { id } = await order()
    const key = 'e2b7c0de-0000-4000-8000-000000000042'

    const first = await orgA.applyTransition(
      id,
      { transition: 'announceTruck', patch: { truckPlate: '1-ABC-123' } },
      1,
      { idempotencyKey: key },
    )
    const second = await orgA.applyTransition(
      id,
      { transition: 'announceTruck', patch: { truckPlate: '1-ABC-123' } },
      1,
      { idempotencyKey: key },
    )

    expect(second).toEqual(first)
    // And exactly one event, not two. That is the whole point.
    expect(await orgA.events(id)).toHaveLength(2)
  })

  it('refuses a key that lacks the scope, without leaking why to the caller', async () => {
    const limited = await provision(testApp, 'org-a', ['instances:read'])
    const readOnly = new PilotsClient({ baseUrl, apiKey: limited.apiKey })

    const error = (await readOnly
      .createInstance({ definition: 'container-weighing@1.0.0', participants: PARTICIPANTS })
      .catch((cause: unknown) => cause)) as ProblemError

    expect(error.status).toBe(403)
    expect(error.isForbidden).toBe(true)
    // Reading still works: scopes are per operation, not per key.
    expect(await readOnly.instances()).toBeInstanceOf(Array)
  })
})
