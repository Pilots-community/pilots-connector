/**
 * Node-to-node authentication, and S4d on the peer surface.
 *
 * Every test here ends with **no business event and an audit entry**, which is
 * the whole reason the audit log exists: a refused request produces nothing in
 * the event log, so without this there would be no record it ever happened.
 *
 * The calls go straight at `PeerSurface.handle`, which is the same function the
 * in-process transport and the Nest controller both reach. Nothing about
 * authentication lives in the HTTP layer, so nothing here is weaker than what
 * ships.
 */
import { signPeerToken, verifyAuditChain } from '@pilots/protocol'
import { beforeEach, afterEach, describe, expect, it } from 'vitest'

import { ACME, VANMOER } from './helpers/core.js'
import { buildScenario, SCENARIO_START, type Scenario } from './helpers/network.js'

let scenario: Scenario

beforeEach(async () => {
  scenario = await buildScenario({
    acme: { participants: [ACME] },
    vanmoer: { participants: [VANMOER] },
  })
})

afterEach(async () => {
  await scenario.close()
})

/** A token Acme mints for Van Moer, with whatever we want to get wrong about it. */
async function acmeToken(
  overrides: { aud?: string; jti?: string; nowMs?: number; ttlSeconds?: number } = {},
): Promise<string> {
  const acme = scenario.node('acme')
  return signPeerToken(acme.runtime.identity.asSigner(), ACME.id, {
    iss: ACME.did,
    aud: overrides.aud ?? VANMOER.did,
    jti: overrides.jti ?? 'jti-1',
    nowMs: overrides.nowMs ?? Date.parse(SCENARIO_START),
    ...(overrides.ttlSeconds === undefined ? {} : { ttlSeconds: overrides.ttlSeconds }),
  })
}

async function callVanMoer(token: string | undefined, path = '/api/peer/v1/offerings') {
  return scenario.node('vanmoer').runtime.peers.handle({
    method: 'GET',
    path,
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  })
}

async function refusals(): Promise<
  { action: string; outcome: string; problem: string | null; detail: string | null }[]
> {
  const entries = await scenario.node('vanmoer').runtime.store.audit.read(VANMOER.id)
  return entries
    .filter((entry) => entry.outcome !== 'ok')
    .map((entry) => ({
      action: entry.action,
      outcome: entry.outcome,
      problem: entry.problem,
      detail: entry.detail,
    }))
}

describe('the peer surface refuses, and says so in the audit log', () => {
  it('refuses a call with no bearer token', async () => {
    const response = await callVanMoer(undefined)
    expect(response.status).toBe(401)

    const audited = await refusals()
    expect(audited).toHaveLength(1)
    expect(audited[0]?.action).toBe('auth.peer')
    expect(audited[0]?.detail).toContain('no bearer token')
  })

  it('refuses a token addressed to somebody else rather than forwarding it', async () => {
    const response = await callVanMoer(await acmeToken({ aud: 'did:web:third-party.example' }))
    expect(response.status).toBe(401)
    expect((await refusals())[0]?.detail).toContain('third-party.example')
  })

  it('refuses a replayed token, and records the jti so it can be traced', async () => {
    await scenario.connect('acme', 'vanmoer')
    const token = await acmeToken({ jti: 'replay-me' })

    expect((await callVanMoer(token)).status).toBe(200)
    expect((await callVanMoer(token)).status).toBe(401)

    const entries = await scenario.node('vanmoer').runtime.store.audit.read(VANMOER.id)
    const replayed = entries.findLast((entry) => entry.action === 'auth.peer')
    expect(replayed?.detail).toContain('replayed')
    expect(replayed?.request?.jti).toBe('replay-me')
    // The peer DID is recorded even though the call was refused: "an unknown
    // caller" and "a known peer replaying" are different operational events.
    expect(replayed?.actor.id).toBe(ACME.did)
  })

  it('refuses an expired token', async () => {
    const token = await acmeToken({ nowMs: Date.parse(SCENARIO_START) - 3_600_000 })
    expect((await callVanMoer(token)).status).toBe(401)
    expect((await refusals())[0]?.detail).toContain('expired')
  })

  it('refuses a long-lived token, which would be a password rather than a credential', async () => {
    const token = await acmeToken({ ttlSeconds: 60 * 60 * 24 * 365 })
    expect((await callVanMoer(token)).status).toBe(401)
    expect((await refusals())[0]?.detail).toContain('lifetime-too-long')
  })

  it('refuses a token signed by a key the issuer never published', async () => {
    // Van Moer's key, claiming to be Acme.
    const forged = await signPeerToken(
      scenario.node('vanmoer').runtime.identity.asSigner(),
      VANMOER.id,
      { iss: ACME.did, aud: VANMOER.did, jti: 'forged', nowMs: Date.parse(SCENARIO_START) },
    )
    expect((await callVanMoer(forged)).status).toBe(401)
    expect((await refusals())[0]?.detail).toContain('issuer-mismatch')
  })

  it('refuses process traffic from an authenticated peer with no ACTIVE connection', async () => {
    // The token verifies perfectly. The connection is the second gate, and there
    // is no privileged path around it.
    const response = await callVanMoer(await acmeToken())
    expect(response.status).toBe(403)
    expect((response.body as { type: string }).type).toContain('connection-not-active')
  })

  it('lets the handshake through without one, because that is what establishes it', async () => {
    const response = await scenario.node('vanmoer').runtime.peers.handle({
      method: 'POST',
      path: '/api/peer/v1/connections/requests',
      headers: { authorization: `Bearer ${await acmeToken()}` },
      body: {
        connectionId: '01J0000000000000000000000A',
        fromDid: ACME.did,
        fromBaseUrl: ACME.baseUrl,
        delivery: { channel: 'stream' },
      },
    })
    // 202: we have it, a human has not decided yet.
    expect(response.status).toBe(202)
  })

  it('keeps the audit chain unbroken across every refusal', async () => {
    await callVanMoer(undefined)
    await callVanMoer(await acmeToken({ aud: 'did:web:third-party.example' }))
    await callVanMoer(await acmeToken({ ttlSeconds: 60 * 60 * 24 * 365, jti: 'jti-2' }))
    await callVanMoer(await acmeToken({ jti: 'jti-3' }))

    const entries = await scenario.node('vanmoer').runtime.store.audit.read(VANMOER.id)
    expect(entries.length).toBeGreaterThanOrEqual(4)
    expect(verifyAuditChain(entries).ok).toBe(true)

    // And the event log is silent about all of it, by design.
    const instances = await scenario.node('vanmoer').runtime.store.instances.find(VANMOER.id)
    expect(instances).toHaveLength(0)
  })
})

describe('a peer may not write outside its own identity', () => {
  it('refuses an event signed by someone other than the caller', async () => {
    await scenario.connect('acme', 'vanmoer')
    const acme = scenario.node('acme')
    const vanmoer = scenario.node('vanmoer')

    const created = await acme.runtime.instances.create(acme.caller(), {
      definition: 'container-weighing@1.0.0',
      participants: { shipper: ACME.did, weigher: VANMOER.did },
      data: { containerNumber: 'MSCU1234567', terminal: '869' },
    })
    if (!created.ok) throw new Error('create failed')
    await scenario.settle()

    const events = await vanmoer.runtime.store.events.read(VANMOER.id, created.value.instance.id, 0)
    const genuine = events[0]!

    // Van Moer authenticates as itself and submits an event Acme signed. A peer
    // may act for itself; relaying somebody else's signed event is a different
    // feature with a different threat model.
    const token = await signPeerToken(vanmoer.runtime.identity.asSigner(), VANMOER.id, {
      iss: VANMOER.did,
      aud: ACME.did,
      jti: 'not-mine',
      nowMs: scenario.clock.now(),
    })
    const response = await acme.runtime.peers.handle({
      method: 'POST',
      path: `/api/peer/v1/instances/${created.value.instance.id}/transitions`,
      headers: { authorization: `Bearer ${token}` },
      body: {
        instance: {
          id: created.value.instance.id,
          kind: 'service',
          definition: 'container-weighing@1.0.0',
          participants: { shipper: ACME.did, weigher: VANMOER.did },
          quotationId: null,
          offering: null,
          createdAt: genuine.header.at,
        },
        event: {
          header: genuine.header,
          payload: genuine.payload,
          redacted: false,
          sig: genuine.sig,
        },
      },
    })

    expect(response.status).toBeGreaterThanOrEqual(400)
  })
})
