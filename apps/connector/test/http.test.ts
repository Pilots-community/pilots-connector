/**
 * The three surfaces over real HTTP.
 *
 * This is M2's exit criterion: S1's full weighing sequence on `/api/local/v1`
 * with an API key, one connector, no database — plus the audit log showing every
 * call, including a deliberately refused one.
 */
import { Problem, verifyAuditChain, type AuditEntry } from '@pilots/protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ACME, VANMOER } from './helpers/core.js'
import { buildTestApp, provision, type TestApp } from './helpers/app.js'

const PARTICIPANTS = { shipper: ACME.did, weigher: VANMOER.did }
const CERTIFICATE_SHA = `sha256:${'a'.repeat(64)}`

let testApp: TestApp
let acmeKey: string
let vanmoerKey: string
let session: string

beforeEach(async () => {
  testApp = await buildTestApp()
  const acme = await provision(testApp, 'acme')
  const vanmoer = await provision(testApp, 'vanmoer')
  acmeKey = acme.apiKey
  vanmoerKey = vanmoer.apiKey
  session = acme.session
})

afterEach(async () => {
  await testApp.close()
})

function local(apiKey: string, actorRef = 'alice@acme.example') {
  return {
    authorization: `ApiKey ${apiKey}`,
    'x-actor-ref': actorRef,
    'content-type': 'application/json',
  }
}

async function createWeighing(): Promise<{ id: string; etag: string }> {
  const response = await testApp.app.inject({
    method: 'POST',
    url: '/api/local/v1/instances',
    headers: local(acmeKey),
    payload: {
      definition: 'container-weighing@1.0.0',
      participants: PARTICIPANTS,
      data: { containerNumber: 'MSCU1234567', terminal: '869' },
    },
  })
  expect(response.statusCode).toBe(201)
  const body = response.json()
  return { id: body.instance.id, etag: response.headers['etag'] as string }
}

async function transition(
  apiKey: string,
  id: string,
  payload: Record<string, unknown>,
  ifMatch: number | undefined,
  extra: Record<string, string> = {},
) {
  return testApp.app.inject({
    method: 'POST',
    url: `/api/local/v1/instances/${id}/transitions`,
    headers: {
      ...local(apiKey),
      ...(ifMatch === undefined ? {} : { 'if-match': `"${ifMatch}"` }),
      ...extra,
    },
    payload,
  })
}

describe('the well-known DID document', () => {
  it('is served without authentication, because that is the whole of onboarding', async () => {
    const response = await testApp.app.inject({ method: 'GET', url: '/.well-known/did.json' })
    expect(response.statusCode).toBe(200)

    const document = response.json()
    expect(document.id).toBe(ACME.did)
    expect(document.verificationMethod).toHaveLength(1)
    expect(response.body).not.toContain('"d"')
  })

  it('resolves a hosted tenant by its did:web path segments', async () => {
    const response = await testApp.app.inject({ method: 'GET', url: '/t/vanmoer/did.json' })
    expect(response.statusCode).toBe(200)
    expect(response.json().id).toBe(VANMOER.did)

    const missing = await testApp.app.inject({ method: 'GET', url: '/t/nobody/did.json' })
    expect(missing.statusCode).toBe(404)
  })
})

describe('the auth boundary is visible in the URL', () => {
  it('refuses the local surface without an API key', async () => {
    const response = await testApp.app.inject({ method: 'GET', url: '/api/local/v1/instances' })
    expect(response.statusCode).toBe(401)
    expect(response.headers['content-type']).toContain('application/problem+json')
    expect(response.json().type).toBe(Problem.credentialInvalid)
  })

  it('never accepts an admin session on the local surface', async () => {
    const response = await testApp.app.inject({
      method: 'GET',
      url: '/api/local/v1/instances',
      headers: { authorization: `Session ${session}` },
    })
    expect(response.statusCode).toBe(401)
  })

  it('never accepts an API key on the admin surface', async () => {
    const response = await testApp.app.inject({
      method: 'GET',
      url: '/api/admin/v1/apikeys',
      headers: { authorization: `ApiKey ${acmeKey}` },
    })
    expect(response.statusCode).toBe(401)
  })

  it('refuses the peer surface, which has no connections enabled', async () => {
    const response = await testApp.app.inject({
      method: 'GET',
      url: '/api/peer/v1/instances',
      headers: { authorization: 'Bearer whatever' },
    })
    expect(response.statusCode).toBe(401)
    expect(response.json().detail).toMatch(/no peer connections/)
  })

  it('refuses a key that lacks the scope for the call', async () => {
    const readOnly = await provision(testApp, 'acme', ['instances:read'])
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/api/local/v1/instances',
      headers: local(readOnly.apiKey),
      payload: { definition: 'container-weighing@1.0.0', participants: PARTICIPANTS, data: {} },
    })
    expect(response.statusCode).toBe(403)
    expect(response.json().type).toBe(Problem.scopeMissing)
  })

  it('refuses a revoked key', async () => {
    const doomed = await provision(testApp, 'acme')
    const id = (
      await testApp.app.inject({
        method: 'GET',
        url: '/api/admin/v1/apikeys?participantId=acme',
        headers: { authorization: `Session ${session}` },
      })
    ).json()

    await testApp.app.inject({
      method: 'DELETE',
      url: `/api/admin/v1/apikeys/${id.apiKeys.at(-1)!.id}?participantId=acme`,
      headers: { authorization: `Session ${session}` },
    })

    const response = await testApp.app.inject({
      method: 'GET',
      url: '/api/local/v1/instances',
      headers: local(doomed.apiKey),
    })
    expect(response.statusCode).toBe(401)
  })
})

describe('S1 over the local API', () => {
  it('runs the whole weighing sequence', async () => {
    const { id, etag } = await createWeighing()
    expect(etag).toBe('"1"')

    const announced = await transition(
      acmeKey,
      id,
      { transition: 'announceTruck', patch: { truckPlate: '1-ABC-123' } },
      1,
    )
    expect(announced.statusCode).toBe(201)
    expect(announced.headers['etag']).toBe('"2"')

    const weighed = await transition(
      vanmoerKey,
      id,
      {
        transition: 'weigh',
        patch: { grossMass: { value: 24000, unit: 'kg', measuredAt: '2026-08-24T09:19:00.000Z' } },
      },
      2,
    )
    expect(weighed.statusCode).toBe(201)

    // Step 6 — the shipper reads and the mass is withheld.
    const asShipper = await testApp.app.inject({
      method: 'GET',
      url: `/api/local/v1/instances/${id}`,
      headers: local(acmeKey),
    })
    expect(asShipper.headers['etag']).toBe('"3"')
    const shipperView = asShipper.json()
    expect(shipperView.data).not.toHaveProperty('grossMass')
    expect(shipperView.redacted).toBe(true)

    await transition(
      vanmoerKey,
      id,
      { transition: 'recordPayment', patch: { paymentReference: 'PAY-1' } },
      3,
    )

    // Step 8 — the same stored event, filtered differently.
    const released = await testApp.app.inject({
      method: 'GET',
      url: `/api/local/v1/instances/${id}`,
      headers: local(acmeKey),
    })
    expect(released.json().data).toHaveProperty('grossMass')

    const issued = await transition(
      vanmoerKey,
      id,
      {
        transition: 'issueVgm',
        patch: { certificate: { sha256: CERTIFICATE_SHA, issuedAt: '2026-08-24T09:30:00.000Z' } },
        attachments: [{ sha256: CERTIFICATE_SHA, mime: 'application/pdf', size: 41022 }],
      },
      4,
    )
    expect(issued.statusCode).toBe(201)
    expect(issued.json().instance.state).toBe('VGM_ISSUED')
  })

  it('returns the signed event log, visibility-filtered', async () => {
    const { id } = await createWeighing()
    const response = await testApp.app.inject({
      method: 'GET',
      url: `/api/local/v1/instances/${id}/events`,
      headers: local(acmeKey),
    })
    const { events } = response.json()
    expect(events).toHaveLength(1)
    expect(events[0]?.header.transition).toBe('create')
    expect(events[0]?.sig).toMatch(/^[\w-]+\.\.[\w-]+$/)
  })

  it('lists a definition and its content hash', async () => {
    const response = await testApp.app.inject({
      method: 'GET',
      url: '/api/local/v1/definitions/container-weighing@1.0.0',
      headers: local(acmeKey),
    })
    expect(response.statusCode).toBe(200)
    expect(response.json().contentHash).toMatch(/^sha256:[0-9a-f]{64}$/)
  })
})

describe('concurrency and idempotency are separate mechanisms', () => {
  it('demands If-Match on a mutating call', async () => {
    const { id } = await createWeighing()
    const response = await transition(
      acmeKey,
      id,
      { transition: 'announceTruck', patch: { truckPlate: '1-ABC-123' } },
      undefined,
    )
    expect(response.statusCode).toBe(428)
    expect(response.json().type).toBe(Problem.preconditionRequired)
  })

  it('reports a stale If-Match as 409 carrying the real seq', async () => {
    const { id } = await createWeighing()
    await transition(acmeKey, id, { transition: 'announceTruck', patch: { truckPlate: 'A' } }, 1)

    const stale = await transition(
      acmeKey,
      id,
      { transition: 'cancel', patch: { cancellationReason: 'oops' } },
      1,
    )
    expect(stale.statusCode).toBe(409)
    const problem = stale.json()
    expect(problem.type).toBe(Problem.seqConflict)
    expect(problem.seq).toBe(2)
  })

  it('replays the original result for a repeated Idempotency-Key', async () => {
    const { id } = await createWeighing()
    const key = 'e2b7c0de-0000-4000-8000-000000000001'

    const first = await transition(
      acmeKey,
      id,
      { transition: 'announceTruck', patch: { truckPlate: '1-ABC-123' } },
      1,
      { 'idempotency-key': key },
    )
    const second = await transition(
      acmeKey,
      id,
      { transition: 'announceTruck', patch: { truckPlate: '1-ABC-123' } },
      1,
      { 'idempotency-key': key },
    )

    expect(first.statusCode).toBe(201)
    expect(second.statusCode).toBe(201)
    expect(second.json()).toEqual(first.json())

    // …and the transition was applied exactly once.
    const events = await testApp.app.inject({
      method: 'GET',
      url: `/api/local/v1/instances/${id}/events`,
      headers: local(acmeKey),
    })
    expect(events.json().events).toHaveLength(2)
  })

  it('does not block a key forever when the work failed', async () => {
    const { id } = await createWeighing()
    const key = 'e2b7c0de-0000-4000-8000-000000000002'

    const refused = await transition(
      acmeKey,
      id,
      {
        transition: 'weigh',
        patch: { grossMass: { value: 1, unit: 'kg', measuredAt: '2026-08-24T09:19:00.000Z' } },
      },
      1,
      { 'idempotency-key': key },
    )
    expect(refused.statusCode).toBe(403)

    const retried = await transition(
      acmeKey,
      id,
      { transition: 'announceTruck', patch: { truckPlate: '1-ABC-123' } },
      1,
      { 'idempotency-key': key },
    )
    expect(retried.statusCode).toBe(201)
  })
})

describe('refusals leave a trail — S4d in miniature', () => {
  async function auditEntries(): Promise<AuditEntry[]> {
    const response = await testApp.app.inject({
      method: 'GET',
      url: '/api/admin/v1/audit?participantId=acme&limit=1000',
      headers: { authorization: `Session ${session}` },
    })
    return response.json<{ entries: AuditEntry[] }>().entries
  }

  it('records a role refusal with no event to show for it', async () => {
    const { id } = await createWeighing()
    await transition(acmeKey, id, { transition: 'announceTruck', patch: { truckPlate: 'A' } }, 1)

    const refused = await transition(
      acmeKey,
      id,
      {
        transition: 'weigh',
        patch: { grossMass: { value: 1, unit: 'kg', measuredAt: '2026-08-24T09:19:00.000Z' } },
      },
      2,
    )
    expect(refused.statusCode).toBe(403)
    expect(refused.json().type).toBe(Problem.roleNotPermitted)

    const entries = await auditEntries()
    const denial = entries.find((entry) => entry.outcome === 'denied')
    expect(denial?.action).toBe('transition.apply')
    expect(denial?.problem).toBe(Problem.roleNotPermitted)
    expect(denial?.subject.instance).toBe(id)
    expect(denial?.actor.kind).toBe('apiKey')
    expect(denial?.actor.actorRef).toBe('alice@acme.example')

    // The event log is silent about all of it, by design.
    const events = await testApp.app.inject({
      method: 'GET',
      url: `/api/local/v1/instances/${id}/events`,
      headers: local(acmeKey),
    })
    expect(events.json().events).toHaveLength(2)
  })

  it('records a rejected API key where the operator can actually read it', async () => {
    await testApp.app.inject({
      method: 'GET',
      url: '/api/local/v1/instances',
      headers: { authorization: 'ApiKey ak_01J0000000000000000000000A.nope' },
    })

    const denial = (await auditEntries()).find((entry) => entry.action === 'auth.apiKey')
    expect(denial?.outcome).toBe('denied')
    expect(denial?.problem).toBe(Problem.credentialInvalid)
    expect(denial?.request?.path).toBe('/api/local/v1/instances')
    // The key id is recorded; the presented secret never is.
    expect(denial?.actor.id).toBe('ak_01J0000000000000000000000A')
    expect(JSON.stringify(denial)).not.toContain('nope')
  })

  it('keeps the audit chain unbroken across every one of them', async () => {
    const { id } = await createWeighing()
    await transition(acmeKey, id, { transition: 'announceTruck', patch: { truckPlate: 'A' } }, 1)
    await transition(acmeKey, id, { transition: 'weigh', patch: {} }, 2)
    await transition(acmeKey, id, { transition: 'cancel' }, 99)

    const entries = await auditEntries()
    expect(entries.length).toBeGreaterThanOrEqual(4)
    expect(verifyAuditChain(entries).ok).toBe(true)

    const verified = await testApp.app.inject({
      method: 'GET',
      url: '/api/admin/v1/audit/verify?participantId=acme',
      headers: { authorization: `Session ${session}` },
    })
    expect(verified.json().ok).toBe(true)
  })

  it('detects a tampered audit entry', async () => {
    await createWeighing()
    const entries = await testApp.runtime.store.audit.read('acme')
    expect(entries.length).toBeGreaterThan(1)

    // Rewrite one entry's outcome, exactly as S4b rewrites a stored event.
    const tampered = entries.map((entry, index) =>
      index === 0 ? { ...entry, outcome: 'denied' as const } : entry,
    )
    const verification = verifyAuditChain(tampered)
    expect(verification.ok).toBe(false)
    // It breaks at the entry *after* the edit, because that is where the link
    // stops matching — the same signal a rewritten event chain gives.
    expect(verification.failures[0]?.seq).toBe(2)
  })
})

describe('the admin surface', () => {
  it('returns the API key secret exactly once', async () => {
    const created = await testApp.app.inject({
      method: 'POST',
      url: '/api/admin/v1/apikeys',
      headers: { authorization: `Session ${session}` },
      payload: { label: 'once', scopes: ['instances:read'], participantId: 'acme' },
    })
    expect(created.statusCode).toBe(201)
    const minted = created.json()
    expect(minted.secret).toContain('.')

    const listed = await testApp.app.inject({
      method: 'GET',
      url: '/api/admin/v1/apikeys?participantId=acme',
      headers: { authorization: `Session ${session}` },
    })
    expect(listed.body).not.toContain(minted.secret)
    expect(listed.body).not.toContain('secretHash')
  })

  it('publishes an offering, which is what makes a participant a supplier', async () => {
    const published = await testApp.app.inject({
      method: 'POST',
      url: '/api/admin/v1/offerings',
      headers: { authorization: `Session ${session}` },
      payload: {
        id: 'urn:offering:vanmoer:container-weighing',
        title: 'Container weighing, Antwerp 869',
        quotationDefinition: 'container-weighing-quotation@1.0.0',
        serviceDefinition: 'container-weighing@1.0.0',
        conditions: { terminal: ['869'] },
        price: { value: 45, currency: 'EUR' },
        participantId: 'vanmoer',
      },
    })
    expect(published.statusCode).toBe(201)

    const browsable = await testApp.app.inject({
      method: 'GET',
      url: '/api/local/v1/offerings',
      headers: local(vanmoerKey),
    })
    expect(browsable.json().offerings).toHaveLength(1)

    // Withdrawing stops discovery without touching anything already running.
    await testApp.app.inject({
      method: 'DELETE',
      url: '/api/admin/v1/offerings/urn:offering:vanmoer:container-weighing?participantId=vanmoer',
      headers: { authorization: `Session ${session}` },
    })
    const afterWithdrawal = await testApp.app.inject({
      method: 'GET',
      url: '/api/local/v1/offerings',
      headers: local(vanmoerKey),
    })
    expect(afterWithdrawal.json().offerings).toHaveLength(0)
  })

  it('registers a notification subscription without ever storing the secret', async () => {
    const created = await testApp.app.inject({
      method: 'POST',
      url: '/api/admin/v1/subscriptions?participantId=vanmoer',
      headers: { authorization: `Session ${session}` },
      payload: {
        label: 'backoffice-prod',
        channel: 'webhook',
        target: {
          url: 'https://backoffice.internal/pilots/hook',
          secretRef: 'env:BACKOFFICE_HOOK_SECRET',
        },
        notify: ['action.required'],
        filter: { definitions: ['container-weighing@1.0.0'], states: ['TRUCK_ANNOUNCED'] },
      },
    })
    expect(created.statusCode).toBe(201)
    const subscription = created.json()
    // A reference, never a value.
    expect(subscription.target.secretRef).toBe('env:BACKOFFICE_HOOK_SECRET')

    const listed = await testApp.app.inject({
      method: 'GET',
      url: '/api/admin/v1/subscriptions?participantId=vanmoer',
      headers: { authorization: `Session ${session}` },
    })
    expect(listed.json().subscriptions).toHaveLength(1)
  })

  it('reports where secrets live but never what they are', async () => {
    const status = await testApp.app.inject({
      method: 'GET',
      url: '/api/admin/v1/status',
      headers: { authorization: `Session ${session}` },
    })
    const body = status.json()
    expect(body.secrets.store).toBe('memory')
    expect(status.body).not.toContain(testApp.adminToken)
  })

  it('refuses a bad admin token', async () => {
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/api/admin/v1/sessions',
      payload: { token: 'adm_not-the-token' },
    })
    expect(response.statusCode).toBe(401)
  })
})
