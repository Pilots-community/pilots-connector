/**
 * S0 — Connect. The prerequisite for everything else.
 *
 * Operator work rather than integration work, and the thing a demo is allowed to
 * seed from configuration only because it is proven here. Note what Org A never
 * needs: a domain with an inbound route, a TLS certificate, a firewall rule, or
 * a callback URL per request. It publishes one static `did.json` and holds one
 * outbound connection.
 */
import { beforeEach, afterEach, describe, expect, it } from 'vitest'

import { ORG_A, ORG_B } from './helpers/core.js'
import { buildScenario, type Scenario } from './helpers/network.js'

let scenario: Scenario

beforeEach(async () => {
  scenario = await buildScenario({
    'org-a': { participants: [ORG_A] },
    'org-b': { participants: [ORG_B] },
  })
})

afterEach(async () => {
  await scenario.close()
})

const operator = { kind: 'adminSession', id: 'operator' } as const

describe('S0 — the handshake', () => {
  it('takes a connection from request to ACTIVE on both sides', async () => {
    const orgA = scenario.node('org-a')
    const orgB = scenario.node('org-b')

    // 1–2. Org A's operator asks; Org B holds it pending a human decision.
    const requested = await orgA.runtime.connections.request(
      ORG_A,
      {
        peerDid: ORG_B.did,
        peerBaseUrl: ORG_B.baseUrl,
        delivery: { channel: 'stream' },
      },
      operator,
    )
    expect(requested.ok).toBe(true)
    if (!requested.ok) return
    expect(requested.value.status).toBe('PENDING_OUTBOUND')

    // 3. Org B resolved the DID, checked the document's host against the
    // claimed base URL, and verified the request's JWS — all before an operator
    // was ever shown the request.
    const inbound = await orgB.runtime.connections.between(ORG_B.id, ORG_A.did)
    expect(inbound?.status).toBe('PENDING_INBOUND')
    // Both sides share one id, which is what lets the callbacks address it.
    expect(inbound?.id).toBe(requested.value.id)

    // 4–5. Org B's operator accepts; the callback makes Org A ACTIVE too.
    const accepted = await orgB.runtime.connections.accept(
      ORG_B,
      requested.value.id,
      { channel: 'webhook', url: `${ORG_B.baseUrl}/api/peer/v1/deliveries` },
      operator,
    )
    expect(accepted.ok).toBe(true)

    expect((await orgB.runtime.connections.between(ORG_B.id, ORG_A.did))?.status).toBe('ACTIVE')
    expect((await orgA.runtime.connections.between(ORG_A.id, ORG_B.did))?.status).toBe('ACTIVE')
  })

  it('records the delivery channel per direction, not per connection', async () => {
    await scenario.connect('org-a', 'org-b', {
      fromWants: { channel: 'stream' },
      toWants: { channel: 'webhook', url: `${ORG_B.baseUrl}/api/peer/v1/deliveries` },
    })

    const onOrgA = await scenario.node('org-a').runtime.connections.between(ORG_A.id, ORG_B.did)
    const onOrgB = await scenario.node('org-b').runtime.connections.between(ORG_B.id, ORG_A.did)

    // Org A dials out and holds a line: it needs no inbound endpoint at all.
    expect(onOrgA?.inbound.channel).toBe('stream')
    expect(onOrgA?.outbound.channel).toBe('webhook')
    // Org B's view is the mirror image. One connection, both directions.
    expect(onOrgB?.inbound.channel).toBe('webhook')
    expect(onOrgB?.outbound.channel).toBe('stream')
  })

  it('refuses a peer whose DID is not bound to the base URL it hands us', async () => {
    const orgA = scenario.node('org-a')

    const result = await orgA.runtime.connections.request(
      ORG_A,
      {
        peerDid: ORG_B.did,
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
    const orgB = scenario.node('org-b')

    // The bearer token proved the caller is Org A. Claiming to be somebody else
    // in the body is the interesting attack, and it is a hard refusal.
    const result = await orgB.runtime.connections.receiveRequest(
      ORG_B,
      ORG_A.did,
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
    expect(result.errors[0]?.detail).toMatch(/issued by .*org-a/)
  })

  it('leaves a rejected connection terminal, and audits who decided', async () => {
    const orgA = scenario.node('org-a')
    const orgB = scenario.node('org-b')

    const requested = await orgA.runtime.connections.request(
      ORG_A,
      { peerDid: ORG_B.did, peerBaseUrl: ORG_B.baseUrl, delivery: { channel: 'stream' } },
      operator,
    )
    if (!requested.ok) throw new Error('request failed')

    await orgB.runtime.connections.reject(ORG_B, requested.value.id, 'not this year', {
      kind: 'adminSession',
      id: 'org-b-operator',
    })

    expect((await orgB.runtime.connections.between(ORG_B.id, ORG_A.did))?.status).toBe('REJECTED')
    expect((await orgA.runtime.connections.between(ORG_A.id, ORG_B.did))?.status).toBe('REJECTED')

    const audit = await orgB.runtime.store.audit.read(ORG_B.id)
    const entry = audit.find((one) => one.action === 'connection.reject')
    expect(entry?.outcome).toBe('ok')
    expect(entry?.actor.kind).toBe('adminSession')
    expect(entry?.detail).toContain('not this year')
  })
})

describe('a connection is the gate every process call passes', () => {
  it('refuses to start a process with a peer we have no connection to', async () => {
    const orgA = scenario.node('org-a')

    const result = await orgA.runtime.instances.create(orgA.caller(), {
      definition: 'container-weighing@1.0.0',
      participants: { shipper: ORG_A.did, weigher: ORG_B.did },
      data: { containerNumber: 'MSCU1234567', terminal: '869' },
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors[0]?.type).toContain('connection-not-active')
  })
})
