/**
 * One conformance suite, every adapter, identical assertions.
 *
 * Its real job is the two operations that shape the port. Everything else here
 * is ordinary CRUD, present so an adapter cannot pass by implementing only the
 * interesting half.
 *
 * Memory and file are both single-writer and in-process, so on their own they
 * cannot fail these tests in the ways a real store can. That is precisely why
 * the Mongo adapter runs this same suite in CI from M3, rather than appearing at
 * the end and needing a signature change.
 */
import {
  EMPTY_PAYLOAD_HASH,
  hashJson,
  verifyAuditChain,
  type StoredEvent,
  type StoredInstance,
} from '@pilots/protocol'
import { beforeEach, afterEach, describe, expect, it } from 'vitest'

import type { Store } from '../store.js'
import { DuplicateKeyError, NotFoundError, type EventWrite } from '../types.js'

const ORG_A = 'org-a'
const ORG_B = 'org-b'
const INSTANCE = '01J0000000000000000000000A'
const AT = '2026-08-24T09:00:00.000Z'

function instanceAt(
  seq: number,
  state: string,
  overrides: Partial<StoredInstance> = {},
): StoredInstance {
  return {
    id: INSTANCE,
    participantId: ORG_A,
    kind: 'service',
    definition: 'container-weighing@1.0.0',
    definitionHash: `sha256:${'d'.repeat(64)}`,
    participants: { shipper: 'did:web:org-a.example', weigher: 'did:web:org-b.example' },
    quotationId: null,
    offering: null,
    state,
    seq,
    data: { containerNumber: 'MSCU1234567', terminal: '869' },
    home: true,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  }
}

function eventAt(
  seq: number,
  to: string,
  from: string | null,
  payload: Record<string, unknown> | null = null,
): StoredEvent {
  return {
    header: {
      instance: INSTANCE,
      seq,
      transition: seq === 1 ? 'create' : 'announceTruck',
      actor: 'did:web:org-a.example',
      from,
      to,
      at: AT,
      prev: seq === 1 ? null : `sha256:${'0'.repeat(64)}`,
      payloadHash: payload === null ? EMPTY_PAYLOAD_HASH : hashJson(payload as never),
      genesis: `sha256:${'1'.repeat(64)}`,
      cause: null,
      attachments: [],
    },
    payload: payload as never,
    redacted: false,
    sig: 'eyJhbGciOiJFZERTQSJ9..signature',
    participantId: ORG_A,
    actorRef: 'alice@org-a.example',
    recordedAt: AT,
  }
}

/** A single write is a batch of one. */
function append(store: Store, write: EventWrite) {
  return store.appendEvent([write])
}

export interface ConformanceContext {
  /** A store over **fresh, empty** backing storage. Called before every test. */
  create(): Promise<Store>
  /** Close and reopen over the **same** backing storage. */
  reopen(store: Store): Promise<Store>
  /**
   * Whether writes survive a close and reopen. The file adapter says yes, the
   * memory adapter says no — and each is asserted, so "it forgot everything"
   * can never pass as "it persisted nothing interesting".
   */
  persistent: boolean
}

export function runStoreConformance(name: string, context: ConformanceContext): void {
  describe(`${name} store`, () => {
    let store: Store

    beforeEach(async () => {
      store = await context.create()
    })

    afterEach(async () => {
      await store.close()
    })

    // ─────────────────────────────────────────────────────────────────────────
    describe('collections', () => {
      const key = (id: string, participantId = ORG_A) => ({
        id,
        participantId,
        label: 'backoffice',
        secretHash: 'a'.repeat(64),
        scopes: ['instances:read' as const],
        createdBy: 'admin',
        createdAt: AT,
        lastUsedAt: null,
        revokedAt: null,
        expiresAt: null,
      })

      it('round-trips a document', async () => {
        await store.apiKeys.insert(key('ak_00000000000000000000000001'))
        const found = await store.apiKeys.get(ORG_A, 'ak_00000000000000000000000001')
        expect(found?.label).toBe('backoffice')
      })

      it('returns undefined for a document that is not there', async () => {
        expect(await store.apiKeys.get(ORG_A, 'ak_00000000000000000000000009')).toBeUndefined()
      })

      it('refuses a duplicate id for the same participant', async () => {
        await store.apiKeys.insert(key('ak_00000000000000000000000001'))
        await expect(store.apiKeys.insert(key('ak_00000000000000000000000001'))).rejects.toThrow(
          DuplicateKeyError,
        )
      })

      it('scopes every read by participant', async () => {
        await store.apiKeys.insert(key('ak_00000000000000000000000001', ORG_A))
        await store.apiKeys.insert(key('ak_00000000000000000000000002', ORG_B))

        expect(await store.apiKeys.get(ORG_B, 'ak_00000000000000000000000001')).toBeUndefined()
        expect(await store.apiKeys.find(ORG_A)).toHaveLength(1)
        expect(await store.apiKeys.find(ORG_B)).toHaveLength(1)
        expect(await store.apiKeys.count(ORG_A)).toBe(1)
      })

      it('lets the same id exist for two participants', async () => {
        await store.apiKeys.insert(key('ak_00000000000000000000000001', ORG_A))
        await expect(
          store.apiKeys.insert(key('ak_00000000000000000000000001', ORG_B)),
        ).resolves.toBeUndefined()
      })

      it('replaces an existing document and refuses to replace a missing one', async () => {
        await store.apiKeys.insert(key('ak_00000000000000000000000001'))
        await store.apiKeys.replace({ ...key('ak_00000000000000000000000001'), label: 'renamed' })
        expect((await store.apiKeys.get(ORG_A, 'ak_00000000000000000000000001'))?.label).toBe(
          'renamed',
        )

        await expect(store.apiKeys.replace(key('ak_00000000000000000000000009'))).rejects.toThrow(
          NotFoundError,
        )
      })

      it('upserts either way', async () => {
        await store.apiKeys.upsert(key('ak_00000000000000000000000001'))
        await store.apiKeys.upsert({ ...key('ak_00000000000000000000000001'), label: 'again' })
        expect(await store.apiKeys.count(ORG_A)).toBe(1)
      })

      it('deletes, and reports whether there was anything to delete', async () => {
        await store.apiKeys.insert(key('ak_00000000000000000000000001'))
        expect(await store.apiKeys.delete(ORG_A, 'ak_00000000000000000000000001')).toBe(true)
        expect(await store.apiKeys.delete(ORG_A, 'ak_00000000000000000000000001')).toBe(false)
      })

      it('filters, sorts and limits', async () => {
        await store.apiKeys.insert(key('ak_00000000000000000000000001'))
        await store.apiKeys.insert({ ...key('ak_00000000000000000000000002'), label: 'other' })
        await store.apiKeys.insert({ ...key('ak_00000000000000000000000003'), revokedAt: AT })

        expect(await store.apiKeys.find(ORG_A, { where: { label: 'other' } })).toHaveLength(1)
        expect(await store.apiKeys.find(ORG_A, { where: { revokedAt: null } })).toHaveLength(2)
        expect(await store.apiKeys.find(ORG_A, { limit: 2 })).toHaveLength(2)

        const descending = await store.apiKeys.find(ORG_A, {
          sort: { field: 'id', direction: 'desc' },
        })
        expect(descending.map((k) => k.id)).toEqual([
          'ak_00000000000000000000000003',
          'ak_00000000000000000000000002',
          'ak_00000000000000000000000001',
        ])
      })

      it('hands back copies, so a caller cannot mutate the store by accident', async () => {
        await store.apiKeys.insert(key('ak_00000000000000000000000001'))
        const first = await store.apiKeys.get(ORG_A, 'ak_00000000000000000000000001')
        first!.label = 'mutated in place'
        expect((await store.apiKeys.get(ORG_A, 'ak_00000000000000000000000001'))?.label).toBe(
          'backoffice',
        )
      })

      it('finds an API key by id alone, because an inbound request has nothing else', async () => {
        await store.apiKeys.insert(key('ak_00000000000000000000000002', ORG_B))
        const found = await store.findApiKeyById('ak_00000000000000000000000002')
        expect(found?.participantId).toBe(ORG_B)
        expect(await store.findApiKeyById('ak_00000000000000000000000009')).toBeUndefined()
      })
    })

    // ─────────────────────────────────────────────────────────────────────────
    describe('appendEvent — one atomic operation', () => {
      it('writes the event and the instance together', async () => {
        const result = await append(store, {
          participantId: ORG_A,
          expectedSeq: 0,
          event: eventAt(1, 'ORDERED', null),
          instanceAfter: instanceAt(1, 'ORDERED'),
        })
        expect(result.ok).toBe(true)

        expect((await store.instances.get(ORG_A, INSTANCE))?.seq).toBe(1)
        expect(await store.events.read(ORG_A, INSTANCE)).toHaveLength(1)
      })

      it('advances an existing instance', async () => {
        await append(store, {
          participantId: ORG_A,
          expectedSeq: 0,
          event: eventAt(1, 'ORDERED', null),
          instanceAfter: instanceAt(1, 'ORDERED'),
        })
        const result = await append(store, {
          participantId: ORG_A,
          expectedSeq: 1,
          event: eventAt(2, 'TRUCK_ANNOUNCED', 'ORDERED', { truckPlate: '1-ABC-123' }),
          instanceAfter: instanceAt(2, 'TRUCK_ANNOUNCED'),
        })
        expect(result.ok).toBe(true)
        expect((await store.instances.get(ORG_A, INSTANCE))?.state).toBe('TRUCK_ANNOUNCED')
        expect(await store.events.read(ORG_A, INSTANCE)).toHaveLength(2)
      })

      it('reports a conflict with the actual seq when expectedSeq is stale', async () => {
        await append(store, {
          participantId: ORG_A,
          expectedSeq: 0,
          event: eventAt(1, 'ORDERED', null),
          instanceAfter: instanceAt(1, 'ORDERED'),
        })

        const stale = await append(store, {
          participantId: ORG_A,
          expectedSeq: 0,
          event: eventAt(2, 'TRUCK_ANNOUNCED', 'ORDERED'),
          instanceAfter: instanceAt(2, 'TRUCK_ANNOUNCED'),
        })

        expect(stale.ok).toBe(false)
        if (!stale.ok) expect(stale.conflict.actualSeq).toBe(1)
      })

      it('leaves NO partial write behind after a conflict', async () => {
        await append(store, {
          participantId: ORG_A,
          expectedSeq: 0,
          event: eventAt(1, 'ORDERED', null),
          instanceAfter: instanceAt(1, 'ORDERED'),
        })

        await append(store, {
          participantId: ORG_A,
          expectedSeq: 0,
          event: eventAt(2, 'PAID', 'ORDERED'),
          instanceAfter: instanceAt(2, 'PAID'),
        })

        // Never an appended event with an unadvanced instance, nor the reverse.
        const instance = await store.instances.get(ORG_A, INSTANCE)
        const events = await store.events.read(ORG_A, INSTANCE)
        expect(instance?.seq).toBe(1)
        expect(instance?.state).toBe('ORDERED')
        expect(events).toHaveLength(1)
        expect(events[0]?.header.seq).toBe(1)
      })

      it('gives exactly one winner when two writers race the same seq', async () => {
        await append(store, {
          participantId: ORG_A,
          expectedSeq: 0,
          event: eventAt(1, 'ORDERED', null),
          instanceAfter: instanceAt(1, 'ORDERED'),
        })

        const results = await Promise.all([
          append(store, {
            participantId: ORG_A,
            expectedSeq: 1,
            event: eventAt(2, 'TRUCK_ANNOUNCED', 'ORDERED', { truckPlate: 'A' }),
            instanceAfter: instanceAt(2, 'TRUCK_ANNOUNCED'),
          }),
          append(store, {
            participantId: ORG_A,
            expectedSeq: 1,
            event: eventAt(2, 'CANCELLED', 'ORDERED', { cancellationReason: 'B' }),
            instanceAfter: instanceAt(2, 'CANCELLED'),
          }),
        ])

        expect(results.filter((r) => r.ok)).toHaveLength(1)
        expect(results.filter((r) => !r.ok)).toHaveLength(1)

        const events = await store.events.read(ORG_A, INSTANCE)
        expect(events).toHaveLength(2)
        expect(events.map((e) => e.header.seq)).toEqual([1, 2])
        expect((await store.instances.get(ORG_A, INSTANCE))?.seq).toBe(2)
      })

      it('refuses an event whose seq does not follow the instance', async () => {
        const result = await append(store, {
          participantId: ORG_A,
          expectedSeq: 0,
          event: eventAt(2, 'ORDERED', null),
          instanceAfter: instanceAt(2, 'ORDERED'),
        })
        expect(result.ok).toBe(false)
      })
    })

    // ─────────────────────────────────────────────────────────────────────────
    describe('appendEvent — all of them, or none', () => {
      const writeFor = (participantId: string, seq: number, state: string): EventWrite => ({
        participantId,
        expectedSeq: seq - 1,
        event: { ...eventAt(seq, state, seq === 1 ? null : 'ORDERED'), participantId },
        instanceAfter: {
          ...instanceAt(seq, state),
          participantId,
          home: participantId === ORG_B,
        },
      })

      it('writes one instance to every participant that takes part in it', async () => {
        const result = await store.appendEvent([
          writeFor(ORG_A, 1, 'ORDERED'),
          writeFor(ORG_B, 1, 'ORDERED'),
        ])
        expect(result.ok).toBe(true)

        // Each participant holds its own copy, and only the host is `home`.
        expect((await store.instances.get(ORG_A, INSTANCE))?.home).toBe(false)
        expect((await store.instances.get(ORG_B, INSTANCE))?.home).toBe(true)
        expect(await store.events.read(ORG_A, INSTANCE)).toHaveLength(1)
        expect(await store.events.read(ORG_B, INSTANCE)).toHaveLength(1)
      })

      it('applies nothing at all when any one write conflicts', async () => {
        await store.appendEvent([writeFor(ORG_A, 1, 'ORDERED'), writeFor(ORG_B, 1, 'ORDERED')])

        // Org B's copy is at 1; Org A's is too. Ask for a batch where only
        // one side is stale.
        const mixed = await store.appendEvent([
          { ...writeFor(ORG_A, 2, 'TRUCK_ANNOUNCED'), expectedSeq: 1 },
          { ...writeFor(ORG_B, 2, 'TRUCK_ANNOUNCED'), expectedSeq: 0 },
        ])

        expect(mixed.ok).toBe(false)
        if (!mixed.ok) expect(mixed.conflict.participantId).toBe(ORG_B)

        // Org A must NOT have advanced, even though its own write was valid.
        expect((await store.instances.get(ORG_A, INSTANCE))?.seq).toBe(1)
        expect(await store.events.read(ORG_A, INSTANCE)).toHaveLength(1)
      })

      it('accepts an empty batch as a no-op rather than a failure', async () => {
        expect((await store.appendEvent([])).ok).toBe(true)
      })
    })

    // ─────────────────────────────────────────────────────────────────────────
    describe('the event log', () => {
      beforeEach(async () => {
        for (const seq of [1, 2, 3]) {
          await append(store, {
            participantId: ORG_A,
            expectedSeq: seq - 1,
            event: eventAt(seq, `STATE_${seq}`, seq === 1 ? null : `STATE_${seq - 1}`, { n: seq }),
            instanceAfter: instanceAt(seq, `STATE_${seq}`),
          })
        }
      })

      it('reads in seq order', async () => {
        const events = await store.events.read(ORG_A, INSTANCE)
        expect(events.map((e) => e.header.seq)).toEqual([1, 2, 3])
      })

      it('reads strictly after a cursor, which is what ?since= means', async () => {
        expect((await store.events.read(ORG_A, INSTANCE, 1)).map((e) => e.header.seq)).toEqual([
          2, 3,
        ])
        expect(await store.events.read(ORG_A, INSTANCE, 3)).toEqual([])
      })

      it('limits', async () => {
        expect(await store.events.read(ORG_A, INSTANCE, 0, 2)).toHaveLength(2)
      })

      it('reports the head', async () => {
        expect((await store.events.head(ORG_A, INSTANCE))?.header.seq).toBe(3)
        expect(await store.events.head(ORG_A, '01J0000000000000000000000B')).toBeUndefined()
      })

      it('streams every event for a participant behind a monotonic cursor', async () => {
        const all = await store.events.readAll(ORG_A)
        expect(all).toHaveLength(3)
        expect(all.map((e) => e.cursor)).toEqual([...all.map((e) => e.cursor)].sort())

        const after = await store.events.readAll(ORG_A, all[0]!.cursor)
        expect(after.map((e) => e.event.header.seq)).toEqual([2, 3])
      })

      it('never leaks another participant’s events', async () => {
        expect(await store.events.read(ORG_B, INSTANCE)).toEqual([])
        expect(await store.events.readAll(ORG_B)).toEqual([])
      })
    })

    // ─────────────────────────────────────────────────────────────────────────
    describe('claimIdempotencyKey — exactly one winner', () => {
      it('lets the first caller through and replays the result to the second', async () => {
        expect(await store.idempotency.claim(ORG_A, 'k1', 'transition', AT)).toBeNull()
        await store.idempotency.complete(ORG_A, 'k1', { seq: 4 }, AT)

        const replay = await store.idempotency.claim(ORG_A, 'k1', 'transition', AT)
        expect(replay?.status).toBe('complete')
        expect(replay?.result).toEqual({ seq: 4 })
      })

      it('gives exactly one winner under a genuine race', async () => {
        const claims = await Promise.all([
          store.idempotency.claim(ORG_A, 'race', 'transition', AT),
          store.idempotency.claim(ORG_A, 'race', 'transition', AT),
          store.idempotency.claim(ORG_A, 'race', 'transition', AT),
        ])
        expect(claims.filter((c) => c === null)).toHaveLength(1)
        expect(claims.filter((c) => c !== null)).toHaveLength(2)
      })

      it('reports a still-running original as pending rather than complete', async () => {
        await store.idempotency.claim(ORG_A, 'k2', 'transition', AT)
        const second = await store.idempotency.claim(ORG_A, 'k2', 'transition', AT)
        expect(second?.status).toBe('pending')
      })

      it('releases a claim whose work failed, so a retry is not blocked forever', async () => {
        await store.idempotency.claim(ORG_A, 'k3', 'transition', AT)
        await store.idempotency.release(ORG_A, 'k3')
        expect(await store.idempotency.claim(ORG_A, 'k3', 'transition', AT)).toBeNull()
      })

      it('scopes keys by participant and by operation', async () => {
        await store.idempotency.claim(ORG_A, 'shared', 'transition', AT)
        expect(await store.idempotency.claim(ORG_B, 'shared', 'transition', AT)).toBeNull()
        expect(await store.idempotency.claim(ORG_A, 'shared', 'instance.create', AT)).toBeNull()
      })
    })

    // ─────────────────────────────────────────────────────────────────────────
    describe('the audit log', () => {
      const entry = (action: string, participantId = ORG_A) => ({
        at: AT,
        participantId,
        category: 'local' as const,
        action,
        actor: { kind: 'apiKey' as const, id: 'ak_1', actorRef: null },
        subject: {
          instance: null,
          connection: null,
          apiKey: null,
          subscription: null,
          offering: null,
          definition: null,
        },
        outcome: 'ok' as const,
        problem: null,
        detail: null,
        request: null,
      })

      it('numbers from 1 per participant and chains each entry to the one before', async () => {
        const first = await store.audit.append(entry('apiKey.create'))
        const second = await store.audit.append(entry('transition.apply'))

        expect(first.seq).toBe(1)
        expect(first.prev).toBeNull()
        expect(second.seq).toBe(2)
        expect(second.prev).toMatch(/^sha256:[0-9a-f]{64}$/)
      })

      it('keeps each participant’s chain separate', async () => {
        await store.audit.append(entry('a', ORG_A))
        const other = await store.audit.append(entry('b', ORG_B))
        expect(other.seq).toBe(1)
        expect(other.prev).toBeNull()
      })

      it('assigns seq atomically under concurrent appends', async () => {
        const appended = await Promise.all(
          Array.from({ length: 8 }, (_, i) => store.audit.append(entry(`action-${i}`))),
        )
        expect([...appended.map((e) => e.seq)].sort((a, b) => a - b)).toEqual([
          1, 2, 3, 4, 5, 6, 7, 8,
        ])
      })

      it('reads in order, after a cursor, and reports the head', async () => {
        await store.audit.append(entry('a'))
        await store.audit.append(entry('b'))
        await store.audit.append(entry('c'))

        expect((await store.audit.read(ORG_A)).map((e) => e.action)).toEqual(['a', 'b', 'c'])
        expect((await store.audit.read(ORG_A, 1)).map((e) => e.action)).toEqual(['b', 'c'])
        expect((await store.audit.head(ORG_A))?.action).toBe('c')
        expect(await store.audit.count(ORG_A)).toBe(3)
      })

      it('records denials, which is the whole reason it exists', async () => {
        await store.audit.append({
          ...entry('transition.apply'),
          outcome: 'denied',
          problem: 'urn:pilots:problem:role-not-permitted',
        })
        expect((await store.audit.read(ORG_A))[0]?.outcome).toBe('denied')
      })
    })

    // ─────────────────────────────────────────────────────────────────────────
    describe('audit retention — keeping less without proving less', () => {
      const entry = (action: string) => ({
        at: AT,
        participantId: ORG_A,
        category: 'admin' as const,
        action,
        actor: { kind: 'adminSession' as const, id: 'op', actorRef: null },
        subject: {
          instance: null,
          connection: null,
          apiKey: null,
          subscription: null,
          offering: null,
          definition: null,
        },
        outcome: 'ok' as const,
        problem: null,
        detail: null,
        request: null,
      })

      it('discards a prefix without renumbering what remains', async () => {
        for (const action of ['a', 'b', 'c', 'd', 'e']) await store.audit.append(entry(action))

        expect(await store.audit.prune(ORG_A, 2)).toBe(2)

        const kept = await store.audit.read(ORG_A)
        // Still 3, 4, 5 — not 1, 2, 3. Renumbering would make retention
        // indistinguishable from rewriting, and the chain worthless.
        expect(kept.map((one) => one.seq)).toEqual([3, 4, 5])
        expect(kept[0]?.action).toBe('c')
      })

      it('leaves the retained segment verifiable from where it now starts', async () => {
        for (const action of ['a', 'b', 'c', 'd', 'e']) await store.audit.append(entry(action))
        await store.audit.prune(ORG_A, 2)

        const kept = await store.audit.read(ORG_A)
        // A chain whose earlier links are elsewhere is not a broken chain, and
        // `from` is how a verifier is told so.
        expect(verifyAuditChain(kept, { from: 3 }).ok).toBe(true)
        // Told nothing, it correctly complains: seq 3 is not the first entry of
        // a whole log.
        expect(verifyAuditChain(kept).ok).toBe(false)
      })

      it('still detects tampering inside what was kept', async () => {
        for (const action of ['a', 'b', 'c', 'd', 'e']) await store.audit.append(entry(action))
        await store.audit.prune(ORG_A, 2)

        const kept = await store.audit.read(ORG_A)
        const tampered = kept.map((one, index) =>
          index === 1 ? { ...one, action: 'something-else' } : one,
        )
        // Pruning removes entries; it must not remove the property that the
        // remaining ones cannot be edited.
        expect(verifyAuditChain(tampered, { from: 3 }).ok).toBe(false)
      })

      it('appends after a prune without a gap in the chain', async () => {
        for (const action of ['a', 'b', 'c']) await store.audit.append(entry(action))
        await store.audit.prune(ORG_A, 1)

        const appended = await store.audit.append(entry('d'))
        expect(appended.seq).toBe(4)

        const kept = await store.audit.read(ORG_A)
        expect(verifyAuditChain(kept, { from: 2 }).ok).toBe(true)
      })

      it('survives a reopen', async () => {
        if (!context.persistent) return
        for (const action of ['a', 'b', 'c', 'd']) await store.audit.append(entry(action))
        await store.audit.prune(ORG_A, 2)

        const reopened = await context.reopen(store)
        try {
          const kept = await reopened.audit.read(ORG_A)
          expect(kept.map((one) => one.seq)).toEqual([3, 4])
          expect(verifyAuditChain(kept, { from: 3 }).ok).toBe(true)
        } finally {
          await reopened.close()
        }
      })
    })

    // ─────────────────────────────────────────────────────────────────────────
    describe('attachments — addressed by content', () => {
      const BYTES = new TextEncoder().encode('%PDF-1.7 a certificate')
      const DIGEST = `sha256:${'c'.repeat(64)}`

      const attachment = (bytes = BYTES, sha256 = DIGEST) => ({
        sha256,
        mime: 'application/pdf',
        size: bytes.byteLength,
        bytes,
        receivedAt: AT,
      })

      it('stores and returns the exact bytes', async () => {
        await store.attachments.put(ORG_A, attachment())

        const found = await store.attachments.get(ORG_A, DIGEST)
        expect(found?.mime).toBe('application/pdf')
        expect(found?.size).toBe(BYTES.byteLength)
        // Byte-for-byte, not "something that decodes to the same string". An
        // adapter that round-trips a PDF through a string is an adapter that
        // corrupts one.
        expect(Array.from(found?.bytes ?? [])).toEqual(Array.from(BYTES))
      })

      it('treats a repeat put of the same address as a no-op', async () => {
        await store.attachments.put(ORG_A, attachment())
        await store.attachments.put(ORG_A, attachment(new TextEncoder().encode('different')))

        // Content-addressed: the address is the content, so the first write wins
        // and a second cannot quietly change what a hash refers to.
        const found = await store.attachments.get(ORG_A, DIGEST)
        expect(Array.from(found?.bytes ?? [])).toEqual(Array.from(BYTES))
        expect(await store.attachments.list(ORG_A)).toHaveLength(1)
      })

      it('scopes attachments by participant like everything else', async () => {
        await store.attachments.put(ORG_A, attachment())

        expect(await store.attachments.has(ORG_A, DIGEST)).toBe(true)
        expect(await store.attachments.has(ORG_B, DIGEST)).toBe(false)
        expect(await store.attachments.get(ORG_B, DIGEST)).toBeUndefined()
        expect(await store.attachments.list(ORG_B)).toEqual([])
      })

      it('lists metadata without the bytes', async () => {
        await store.attachments.put(ORG_A, attachment())

        const listed = await store.attachments.list(ORG_A)
        expect(listed).toHaveLength(1)
        expect(listed[0]?.sha256).toBe(DIGEST)
        expect(listed[0]).not.toHaveProperty('bytes')
      })
    })

    // ─────────────────────────────────────────────────────────────────────────
    describe('durability across a reopen', () => {
      it(
        context.persistent
          ? 'still has everything after close and reopen'
          : 'starts empty after reopen, as an in-memory store must',
        async () => {
          await append(store, {
            participantId: ORG_A,
            expectedSeq: 0,
            event: eventAt(1, 'ORDERED', null, { containerNumber: 'MSCU1234567' }),
            instanceAfter: instanceAt(1, 'ORDERED'),
          })
          await store.attachments.put(ORG_A, {
            sha256: `sha256:${'d'.repeat(64)}`,
            mime: 'application/pdf',
            size: 3,
            bytes: new Uint8Array([1, 2, 3]),
            receivedAt: AT,
          })
          await store.audit.append({
            at: AT,
            participantId: ORG_A,
            category: 'local',
            action: 'instance.create',
            actor: { kind: 'apiKey', id: 'ak_1', actorRef: null },
            subject: {
              instance: INSTANCE,
              connection: null,
              apiKey: null,
              subscription: null,
              offering: null,
              definition: null,
            },
            outcome: 'ok',
            problem: null,
            detail: null,
            request: null,
          })

          const reopened = await context.reopen(store)
          try {
            const instance = await reopened.instances.get(ORG_A, INSTANCE)
            const events = await reopened.events.read(ORG_A, INSTANCE)

            if (!context.persistent) {
              expect(instance).toBeUndefined()
              expect(events).toEqual([])
              return
            }

            // Document bytes survive too. An attachment that vanished on
            // restart would leave a log referencing a document nobody holds.
            const document = await reopened.attachments.get(ORG_A, `sha256:${'d'.repeat(64)}`)
            expect(Array.from(document?.bytes ?? [])).toEqual([1, 2, 3])

            expect(instance?.state).toBe('ORDERED')
            expect(instance?.seq).toBe(1)
            expect(events).toHaveLength(1)
            expect(events[0]?.payload).toEqual({ containerNumber: 'MSCU1234567' })
            expect((await reopened.audit.head(ORG_A))?.action).toBe('instance.create')
            // The chain has to survive too, or the audit log's tamper evidence
            // only holds for as long as the process does.
            expect((await reopened.audit.head(ORG_A))?.seq).toBe(1)
          } finally {
            await reopened.close()
          }
        },
      )
    })
  })
}
