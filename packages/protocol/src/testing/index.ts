/**
 * Test doubles for the ports.
 *
 * Shipped from the spec package, not copied into each consumer, because the rule
 * they exist to enforce is a rule of the whole project: **no unit, contract or
 * scenario test may require a network, a container, a real clock, or a
 * filesystem outside a temp dir**. A test supplies one of these instead of
 * arranging the real thing.
 *
 * Test keys are generated at setup. No private key is ever committed, including
 * as a fixture.
 */
import { monotonicFactory } from 'ulidx'

import { LocalEd25519Signer } from '../crypto/local-signer.js'
import { parseDuration } from '../duration.js'
import { fromInstant, toInstant, type Clock } from '../ports/clock.js'
import { staticDidResolver, type DidDocument, type DidResolver } from '../ports/did-resolver.js'
import type { IdGenerator } from '../ports/id-generator.js'

/**
 * A clock that only moves when a test moves it.
 *
 * This is what turns "leave an offer unanswered past PT24H" from a test that
 * sleeps for a day, or a test that shortens the duration and hopes, into a
 * function call.
 */
export class FakeClock implements Clock {
  private current: number

  constructor(start: string | number = '2026-08-24T09:00:00.000Z') {
    this.current = typeof start === 'number' ? start : fromInstant(start)
  }

  now(): number {
    return this.current
  }

  /** Advance by milliseconds, or by a definition-style duration like `PT24H`. */
  advance(by: number | string): this {
    this.current += typeof by === 'number' ? by : parseDuration(by)
    return this
  }

  set(to: string | number): this {
    this.current = typeof to === 'number' ? to : fromInstant(to)
    return this
  }

  instant(): string {
    return toInstant(this.current)
  }
}

/** mulberry32 — small, fast, and identical run to run. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * ULIDs that are reproducible from a seed, so a failing scenario test fails the
 * same way twice and a snapshot does not churn.
 */
export function deterministicIdGenerator(seed = 1, clock?: Clock): IdGenerator {
  const ulid = monotonicFactory(seededRandom(seed))
  const fallback = fromInstant('2026-01-01T00:00:00.000Z')
  return {
    next: () => ulid(clock ? clock.now() : fallback),
  }
}

export interface TestParticipants {
  signer: LocalEd25519Signer
  resolver: DidResolver
  documents: Record<string, DidDocument>
}

/**
 * Generate a key per participant and a resolver that serves their DID documents.
 * `participants` maps a local participant id to its DID.
 */
export async function testParticipants(
  participants: Record<string, string>,
): Promise<TestParticipants> {
  const signer = await LocalEd25519Signer.generate(participants)
  const documents: Record<string, DidDocument> = {}
  for (const participantId of Object.keys(participants)) {
    documents[await signer.did(participantId)] = await signer.didDocument(participantId)
  }
  return { signer, resolver: staticDidResolver(documents), documents }
}

export { staticDidResolver }
