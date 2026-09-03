/**
 * What the client puts on the wire, and what it makes of what comes back.
 *
 * Against a scripted `fetch`, because this package may not import the connector
 * — that boundary is the point of the package existing. The client run against a
 * *real* connector lives in the connector's own suite, where it proves the
 * contract in this package matches the implementation.
 */
import { Problem } from '@pilots/protocol'
import { describe, expect, it } from 'vitest'

import { PilotsClient } from '../src/client.js'
import { ProblemError, TransportError } from '../src/errors.js'

interface Recorded {
  url: string
  method: string
  headers: Record<string, string>
  body: string | undefined
}

interface ScriptedAnswer {
  status: number
  body?: unknown
  contentType?: string
}

/** A `fetch` that records what it was asked and answers what the test scripted. */
function scripted(answer: ScriptedAnswer | (() => never)): {
  fetch: typeof globalThis.fetch
  calls: Recorded[]
} {
  const calls: Recorded[] = []
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof answer === 'function') answer()
    const scriptedAnswer = answer as ScriptedAnswer
    calls.push({
      // All three shapes `fetch` accepts, named rather than stringified: a
      // `Request` has no useful default stringification.
      url: input instanceof URL ? input.href : typeof input === 'string' ? input : input.url,
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
          k.toLowerCase(),
          v,
        ]),
      ),
      body: typeof init?.body === 'string' ? init.body : undefined,
    })
    const payload = scriptedAnswer.body === undefined ? '' : JSON.stringify(scriptedAnswer.body)
    return new Response(payload, {
      status: scriptedAnswer.status,
      headers: { 'content-type': scriptedAnswer.contentType ?? 'application/json' },
    })
  }) as typeof globalThis.fetch
  return { fetch, calls }
}

function client(fetch: typeof globalThis.fetch, actorRef = 'alice@org-a.example'): PilotsClient {
  return new PilotsClient({
    baseUrl: 'https://connector.example/',
    apiKey: 'ak_TEST.secret',
    actorRef,
    fetch,
  })
}

describe('every call carries the credential and the actor', () => {
  it('authenticates with the API key and asserts who is acting', async () => {
    const { fetch, calls } = scripted({ status: 200, body: { instances: [] } })
    await client(fetch).instances()

    expect(calls[0]?.url).toBe('https://connector.example/api/local/v1/instances')
    expect(calls[0]?.headers['authorization']).toBe('ApiKey ak_TEST.secret')
    // Asserted and unproven: an audit hint, never an identity claim, and never
    // part of the signed header.
    expect(calls[0]?.headers['x-actor-ref']).toBe('alice@org-a.example')
  })

  it('omits the actor when nobody in particular is acting', async () => {
    const { fetch, calls } = scripted({ status: 200, body: { instances: [] } })
    await new PilotsClient({
      baseUrl: 'https://connector.example',
      apiKey: 'ak_TEST.secret',
      fetch,
    }).instances()

    expect(calls[0]?.headers).not.toHaveProperty('x-actor-ref')
  })

  it('rebinds the actor without minting a second key', async () => {
    const { fetch, calls } = scripted({ status: 200, body: { instances: [] } })
    // Keys are per participant, not per user: a BFF holds one and says who is
    // driving each call.
    await client(fetch).as('bob@org-a.example').instances()
    expect(calls[0]?.headers['x-actor-ref']).toBe('bob@org-a.example')
  })

  it('never addresses a peer, even when browsing one’s offerings', async () => {
    const { fetch, calls } = scripted({ status: 200, body: { offerings: [] } })
    await client(fetch).offerings('did:web:org-b.example')

    // The peer is a query parameter on *our own* connector. The client holds no
    // peer address and resolves nothing.
    expect(calls[0]?.url).toBe(
      'https://connector.example/api/local/v1/offerings?peer=did%3Aweb%3Aorg-b.example',
    )
  })
})

describe('the one mutating call', () => {
  it('sends If-Match as an entity tag, because it is required', async () => {
    const { fetch, calls } = scripted({ status: 200, body: { instance: {}, events: [] } })
    await client(fetch).applyTransition('01J0', { transition: 'weigh', patch: { a: 1 } }, 3)

    expect(calls[0]?.method).toBe('POST')
    expect(calls[0]?.headers['if-match']).toBe('"3"')
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({
      transition: 'weigh',
      patch: { a: 1 },
    })
  })

  it('passes an Idempotency-Key through when one is given', async () => {
    const { fetch, calls } = scripted({ status: 200, body: { instance: {}, events: [] } })
    await client(fetch).applyTransition('01J0', { transition: 'weigh' }, 3, {
      idempotencyKey: 'retry-me',
    })
    expect(calls[0]?.headers['idempotency-key']).toBe('retry-me')
  })
})

describe('a refusal is something a caller can branch on', () => {
  it('reports a conflict with the seq the instance is actually at', async () => {
    const { fetch } = scripted({
      status: 409,
      contentType: 'application/problem+json',
      body: {
        type: Problem.seqConflict,
        title: 'Sequence conflict',
        status: 409,
        detail: 'If-Match is 2 but the instance is at 3',
        seq: 3,
      },
    })

    const error = await client(fetch)
      .applyTransition('01J0', { transition: 'weigh' }, 2)
      .catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(ProblemError)
    const problem = error as ProblemError
    expect(problem.isConflict).toBe(true)
    expect(problem.seq).toBe(3)
    // A conflict needs a fresh decision, not a retry. Getting this wrong is how
    // a client ends up applying the same move twice.
    expect(problem.isRetryable).toBe(false)
  })

  it('marks an unreachable peer retryable and an invalid one not', async () => {
    const unreachable = scripted({
      status: 502,
      contentType: 'application/problem+json',
      body: { type: Problem.peerUnreachable, title: 'Peer unreachable', status: 502 },
    })
    const invalid = scripted({
      status: 502,
      contentType: 'application/problem+json',
      body: { type: Problem.peerResponseInvalid, title: 'Peer response invalid', status: 502 },
    })

    const first = (await client(unreachable.fetch)
      .instances()
      .catch((cause: unknown) => cause)) as ProblemError
    const second = (await client(invalid.fetch)
      .instances()
      .catch((cause: unknown) => cause)) as ProblemError

    // Same status, opposite advice. Retrying a peer that answered something
    // that did not verify just produces another answer that does not verify.
    expect(first.isRetryable).toBe(true)
    expect(second.isRetryable).toBe(false)
  })

  it('groups the forbidden cases, which a UI treats alike', async () => {
    for (const type of [
      Problem.roleNotPermitted,
      Problem.notAParticipant,
      Problem.scopeMissing,
      Problem.connectionNotActive,
    ]) {
      const { fetch } = scripted({
        status: 403,
        contentType: 'application/problem+json',
        body: { type, title: 'Refused', status: 403 },
      })
      const error = (await client(fetch)
        .instances()
        .catch((cause: unknown) => cause)) as ProblemError
      expect(error.isForbidden).toBe(true)
    }
  })

  it('surfaces every failure when a request had several things wrong', async () => {
    const { fetch } = scripted({
      status: 422,
      contentType: 'application/problem+json',
      body: {
        type: Problem.schemaInvalid,
        title: 'Schema validation failed',
        status: 422,
        errors: [
          { type: Problem.schemaInvalid, detail: 'price is required', pointer: '/price' },
          {
            type: Problem.schemaInvalid,
            detail: 'currency must be ISO 4217',
            pointer: '/currency',
          },
        ],
      },
    })

    const error = (await client(fetch)
      .createInstance({ definition: 'x@1.0.0', participants: {} })
      .catch((cause: unknown) => cause)) as ProblemError
    expect(error.failures.map((one) => one.pointer)).toEqual(['/price', '/currency'])
  })

  it('tells "your own connector is down" apart from anything it said', async () => {
    const { fetch } = scripted(() => {
      throw new Error('ECONNREFUSED')
    })

    const error = await client(fetch)
      .instances()
      .catch((cause: unknown) => cause)

    // Not a ProblemError: nothing answered, so there is no problem document and
    // no peer to blame. A caller that cannot reach its own connector has a
    // different problem from one whose peer is down.
    expect(error).toBeInstanceOf(TransportError)
    expect((error as TransportError).message).toContain('could not reach the connector')
  })

  it('does not pretend an unreadable answer is a problem document', async () => {
    const { fetch } = scripted({ status: 502, body: undefined, contentType: 'text/html' })
    const error = (await client(fetch)
      .instances()
      .catch((cause: unknown) => cause)) as ProblemError

    expect(error).toBeInstanceOf(ProblemError)
    expect(error.type).toBe('about:blank')
    expect(error.status).toBe(502)
  })
})
