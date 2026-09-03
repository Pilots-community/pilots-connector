/**
 * The backoffice reacts, and does nothing else.
 *
 * The assertions worth reading are the negative ones: it does not consult a
 * definition, does not track state, and does not decide what may follow what. It
 * is handed "it is your turn, and here is what you may do" and posts the answer
 * back. Everything else here is about surviving delivery being at-least-once.
 */
import { PilotsClient } from '@pilots/client'
import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { Backoffice, DOCUMENT_HASH } from '../src/backoffice.js'

interface Call {
  url: string
  method: string
  body: string | undefined
  headers: Record<string, string>
}

function stubClient(answer: { status: number; body?: unknown } = { status: 200, body: {} }): {
  client: PilotsClient
  calls: Call[]
} {
  const calls: Call[] = []
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: input instanceof URL ? input.href : typeof input === 'string' ? input : input.url,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : undefined,
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
          k.toLowerCase(),
          v,
        ]),
      ),
    })
    return new Response(JSON.stringify(answer.body ?? {}), {
      status: answer.status,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof globalThis.fetch

  return {
    client: new PilotsClient({
      baseUrl: 'http://connector.example',
      apiKey: 'ak_TEST.secret',
      actorRef: 'backoffice',
      fetch,
    }),
    calls,
  }
}

function envelope(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    notification: 'action.required',
    subscription: 'sub-1',
    cursor: '000000000007',
    at: '2026-09-02T09:00:00.000Z',
    instance: {
      id: '01J0000000000000000000000A',
      definition: 'container-weighing@1.0.0',
      kind: 'service',
      state: 'TRUCK_ANNOUNCED',
      seq: 2,
    },
    available: [{ transition: 'weigh', role: 'weigher' }],
    event: { header: {}, payload: null, redacted: false, sig: 'x' },
    ...overrides,
  } as never
}

const WEIGH = {
  weigh: { patch: { grossMass: { value: 24000, unit: 'kg' } } },
}

describe('it posts back the transition the envelope named', () => {
  it('uses the seq it was given, without reading the instance first', async () => {
    const { client, calls } = stubClient()
    const handled = await new Backoffice({ client, data: WEIGH }).receive([envelope()])

    expect(handled).toEqual([
      { instance: '01J0000000000000000000000A', transition: 'weigh', outcome: 'applied' },
    ])

    // One call. No GET of the instance, no fetch of the definition: it needed
    // neither, which is the whole claim.
    expect(calls).toHaveLength(1)
    expect(calls[0]?.method).toBe('POST')
    expect(calls[0]?.url).toContain('/instances/01J0000000000000000000000A/transitions')
    expect(calls[0]?.headers['if-match']).toBe('"2"')
    expect(calls[0]?.headers['x-actor-ref']).toBe('backoffice')
  })

  it('sends an idempotency key derived from the cursor, so a redelivery is safe', async () => {
    const { client, calls } = stubClient()
    await new Backoffice({ client, data: WEIGH }).receive([envelope()])
    expect(calls[0]?.headers['idempotency-key']).toBe('backoffice-000000000007')
  })

  it('ignores a redelivery it has already handled', async () => {
    const { client, calls } = stubClient()
    const backoffice = new Backoffice({ client, data: WEIGH })

    await backoffice.receive([envelope()])
    await backoffice.receive([envelope()])

    // At-least-once is the contract, so a duplicate is expected rather than
    // exceptional — and the connector would refuse the second write anyway.
    expect(calls).toHaveLength(1)
  })

  it('ignores anything that is not its turn', async () => {
    const { client, calls } = stubClient()
    const backoffice = new Backoffice({ client, data: WEIGH })

    await backoffice.receive([envelope({ notification: 'state.changed' })])
    await backoffice.receive([envelope({ notification: 'event', cursor: '000000000008' })])

    expect(calls).toHaveLength(0)
  })

  it('reports a turn it has no data for rather than pretending', async () => {
    const { client, calls } = stubClient()
    const handled = await new Backoffice({ client, data: {} }).receive([envelope()])

    expect(handled[0]?.outcome).toBe('ignored')
    expect(calls).toHaveLength(0)
  })

  it('reports a refusal with the problem type, and does not retry it', async () => {
    const { client, calls } = stubClient({
      status: 409,
      body: {
        type: 'urn:pilots:problem:seq-conflict',
        title: 'Sequence conflict',
        status: 409,
        seq: 3,
      },
    })
    const handled = await new Backoffice({ client, data: WEIGH }).receive([envelope()])

    expect(handled[0]?.outcome).toBe('refused')
    expect(handled[0]?.detail).toContain('seq-conflict')
    // A conflict needs a fresh decision, not a retry loop.
    expect(calls).toHaveLength(1)
  })

  it('uploads a document first, then references the hash the connector computed', async () => {
    const digest = `sha256:${'a'.repeat(64)}`
    const { client, calls } = stubClient({
      status: 200,
      body: { sha256: digest, mime: 'application/pdf', size: 3 },
    })

    await new Backoffice({
      client,
      data: {
        issueVgm: {
          // The business knows it wants the certificate hash in the data; it
          // cannot know the value, because the connector computes it.
          patch: { certificate: { sha256: DOCUMENT_HASH, issuedAt: '2026-09-02T10:00:00.000Z' } },
          document: { content: 'PDF', mime: 'application/pdf' },
        },
      },
    }).receive([envelope({ available: [{ transition: 'issueVgm', role: 'weigher' }] })])

    expect(calls[0]?.url).toContain('/attachments')
    expect(calls[1]?.url).toContain('/transitions')

    const sent = JSON.parse(calls[1]?.body ?? '{}') as {
      patch: { certificate: { sha256: string } }
      attachments: Array<{ sha256: string }>
    }
    expect(sent.patch.certificate.sha256).toBe(digest)
    expect(sent.attachments[0]?.sha256).toBe(digest)
  })
})

describe('a webhook on an internal network is still authenticated', () => {
  const body = JSON.stringify({ notifications: [] })

  it('accepts a correctly signed delivery', () => {
    const secret = 'shared-with-the-connector'
    const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
    const backoffice = new Backoffice({ client: stubClient().client, data: {}, secret })

    expect(backoffice.verify(body, signature)).toBe(true)
  })

  it('refuses a wrong signature, a missing one, and a tampered body', () => {
    const secret = 'shared-with-the-connector'
    const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
    const backoffice = new Backoffice({ client: stubClient().client, data: {}, secret })

    expect(backoffice.verify(body, undefined)).toBe(false)
    expect(backoffice.verify(body, 'sha256=deadbeef')).toBe(false)
    // Reaching the port is not the same as being the connector.
    expect(backoffice.verify(`${body} `, signature)).toBe(false)
  })
})
