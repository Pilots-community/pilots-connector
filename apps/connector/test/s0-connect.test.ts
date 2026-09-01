/**
 * S0 — Connect. The prerequisite for everything else.
 *
 * Operator work rather than integration work, and the thing a demo is allowed to
 * seed from configuration only because it is proven here. Note what Acme never
 * needs: a domain with an inbound route, a TLS certificate, a firewall rule, or
 * a callback URL per request. It publishes one static `did.json` and holds one
 * outbound connection.
 */
import { beforeEach, afterEach, describe, expect, it } from 'vitest'

import { ACME, VANMOER } from './helpers/core.js'
import { buildScenario, type Scenario } from './helpers/network.js'

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

const operator = { kind: 'adminSession', id: 'operator' } as const

describe('S0 — the handshake', () => {
  it('takes a connection from request to ACTIVE on both sides', async () => {
    const acme = scenario.node('acme')
    const vanmoer = scenario.node('vanmoer')

    // 1–2. Acme's operator asks; Van Moer holds it pending a human decision.
    const requested = await acme.runtime.connections.request(
      ACME,
      {
        peerDid: VANMOER.did,
        peerBaseUrl: VANMOER.baseUrl,
        delivery: { channel: 'stream' },
      },
      operator,
    )
    expect(requested.ok).toBe(true)
    if (!requested.ok) return
    expect(requested.value.status).toBe('PENDING_OUTBOUND')

    // 3. Van Moer resolved the DID, checked the document's host against the
    // claimed base URL, and verified the request's JWS — all before an operator
    // was ever shown the request.
    const inbound = await vanmoer.runtime.connections.between(VANMOER.id, ACME.did)
    expect(inbound?.status).toBe('PENDING_INBOUND')
    // Both sides share one id, which is what lets the callbacks address it.
    expect(inbound?.id).toBe(requested.value.id)

    // 4–5. Van Moer's operator accepts; the callback makes Acme ACTIVE too.
    const accepted = await vanmoer.runtime.connections.accept(
      VANMOER,
      requested.value.id,
      { channel: 'webhook', url: `${VANMOER.baseUrl}/api/peer/v1/deliveries` },
      operator,
    )
    expect(accepted.ok).toBe(true)

    expect((await vanmoer.runtime.connections.between(VANMOER.id, ACME.did))?.status).toBe('ACTIVE')
    expect((await acme.runtime.connections.between(ACME.id, VANMOER.did))?.status).toBe('ACTIVE')
  })

  it('records the delivery channel per direction, not per connection', async () => {
    await scenario.connect('acme', 'vanmoer', {
      fromWants: { channel: 'stream' },
      toWants: { channel: 'webhook', url: `${VANMOER.baseUrl}/api/peer/v1/deliveries` },
    })

    const onAcme = await scenario.node('acme').runtime.connections.between(ACME.id, VANMOER.did)
    const onVanMoer = await scenario
      .node('vanmoer')
      .runtime.connections.between(VANMOER.id, ACME.did)

    // Acme dials out and holds a line: it needs no inbound endpoint at all.
    expect(onAcme?.inbound.channel).toBe('stream')
    expect(onAcme?.outbound.channel).toBe('webhook')
    // Van Moer's view is the mirror image. One connection, both directions.
    expect(onVanMoer?.inbound.channel).toBe('webhook')
    expect(onVanMoer?.outbound.channel).toBe('stream')
  })

  it('refuses a peer whose DID is not bound to the base URL it hands us', async () => {
    const acme = scenario.node('acme')

    const result = await acme.runtime.connections.request(
      ACME,
      {
        peerDid: VANMOER.did,
        // did:web is domain-bound by construction. A DID that resolves at one
        // origin cannot ask us to send its traffic to another.
        peerBaseUrl: 'https://attacker.example',
        delivery: { channel: 'stream' },
      },
      operator,
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors[0]?.detail).toMatch(/bound to .* but claims a base URL/)
  })

  it('refuses a request whose body claims a different sender than its token', async () => {
    const vanmoer = scenario.node('vanmoer')

    // The bearer token proved the caller is Acme. Claiming to be somebody else
    // in the body is the interesting attack, and it is a hard refusal.
    const result = await vanmoer.runtime.connections.receiveRequest(
      VANMOER,
      ACME.did,
      {
        connectionId: '01J0000000000000000000000A',
        fromDid: 'did:web:someone-else.example',
        fromBaseUrl: 'https://someone-else.example',
        delivery: { channel: 'stream' },
      },
      false,
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors[0]?.detail).toMatch(/issued by .*acme/)
  })

  it('leaves a rejected connection terminal, and audits who decided', async () => {
    const acme = scenario.node('acme')
    const vanmoer = scenario.node('vanmoer')

    const requested = await acme.runtime.connections.request(
      ACME,
      { peerDid: VANMOER.did, peerBaseUrl: VANMOER.baseUrl, delivery: { channel: 'stream' } },
      operator,
    )
    if (!requested.ok) throw new Error('request failed')

    await vanmoer.runtime.connections.reject(VANMOER, requested.value.id, 'not this year', {
      kind: 'adminSession',
      id: 'vanmoer-operator',
    })

    expect((await vanmoer.runtime.connections.between(VANMOER.id, ACME.did))?.status).toBe(
      'REJECTED',
    )
    expect((await acme.runtime.connections.between(ACME.id, VANMOER.did))?.status).toBe('REJECTED')

    const audit = await vanmoer.runtime.store.audit.read(VANMOER.id)
    const entry = audit.find((one) => one.action === 'connection.reject')
    expect(entry?.outcome).toBe('ok')
    expect(entry?.actor.kind).toBe('adminSession')
    expect(entry?.detail).toContain('not this year')
  })
})

describe('a connection is the gate every process call passes', () => {
  it('refuses to start a process with a peer we have no connection to', async () => {
    const acme = scenario.node('acme')

    const result = await acme.runtime.instances.create(acme.caller(), {
      definition: 'container-weighing@1.0.0',
      participants: { shipper: ACME.did, weigher: VANMOER.did },
      data: { containerNumber: 'MSCU1234567', terminal: '869' },
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors[0]?.type).toContain('connection-not-active')
  })
})
