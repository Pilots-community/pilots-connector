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
  type StoredEvent,
  type StoredInstance,
} from '@pilots/protocol'
import { beforeEach, afterEach, describe, expect, it } from 'vitest'

import type { Store } from '../store.js'
import { DuplicateKeyError, NotFoundError, type EventWrite } from '../types.js'

const ACME = 'acme'
const VANMOER = 'vanmoer'
const INSTANCE = '01J0000000000000000000000A'
const AT = '2026-08-24T09:00:00.000Z'

function instanceAt(
  seq: number,
  state: string,
  overrides: Partial<StoredInstance> = {},
): StoredInstance {
  return {
    id: INSTANCE,
    participantId: ACME,
    kind: 'service',
    definition: 'container-weighing@1.0.0',
    participants: { shipper: 'did:web:acme-shipping.example', weigher: 'did:web:vanmoer.example' },
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
      actor: 'did:web:acme-shipping.example',
      from,
      to,
      at: AT,
      prev: seq === 1 ? null : `sha256:${'0'.repeat(64)}`,
      payloadHash: payload === null ? EMPTY_PAYLOAD_HASH : hashJson(payload as never),
      genesis: `sha256:${'1'.repeat(64)}`,
      attachments: [],
    },
    payload: payload as never,
    redacted: false,
    sig: 'eyJhbGciOiJFZERTQSJ9..signature',
    participantId: ACME,
    actorRef: 'alice@acme.example',
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
      const key = (id: string, participantId = ACME) => ({
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
        const found = await store.apiKeys.get(ACME, 'ak_00000000000000000000000001')
        expect(found?.label).toBe('backoffice')
      })

      it('returns undefined for a document that is not there', async () => {
        expect(await store.apiKeys.get(ACME, 'ak_00000000000000000000000009')).toBeUndefined()
      })

      it('refuses a duplicate id for the same participant', async () => {
        await store.apiKeys.insert(key('ak_00000000000000000000000001'))
        await expect(store.apiKeys.insert(key('ak_00000000000000000000000001'))).rejects.toThrow(
          DuplicateKeyError,
        )
      })

      it('scopes every read by participant', async () => {
        await store.apiKeys.insert(key('ak_00000000000000000000000001', ACME))
        await store.apiKeys.insert(key('ak_00000000000000000000000002', VANMOER))

        expect(await store.apiKeys.get(VANMOER, 'ak_00000000000000000000000001')).toBeUndefined()
        expect(await store.apiKeys.find(ACME)).toHaveLength(1)
        expect(await store.apiKeys.find(VANMOER)).toHaveLength(1)
        expect(await store.apiKeys.count(ACME)).toBe(1)
      })

      it('lets the same id exist for two participants', async () => {
        await store.apiKeys.insert(key('ak_00000000000000000000000001', ACME))
        await expect(
          store.apiKeys.insert(key('ak_00000000000000000000000001', VANMOER)),
        ).resolves.toBeUndefined()
      })

      it('replaces an existing document and refuses to replace a missing one', async () => {
        await store.apiKeys.insert(key('ak_00000000000000000000000001'))
        await store.apiKeys.replace({ ...key('ak_00000000000000000000000001'), label: 'renamed' })
        expect((await store.apiKeys.get(ACME, 'ak_00000000000000000000000001'))?.label).toBe(
          'renamed',
        )

        await expect(store.apiKeys.replace(key('ak_00000000000000000000000009'))).rejects.toThrow(
          NotFoundError,
        )
      })

      it('upserts either way', async () => {
        await store.apiKeys.upsert(key('ak_00000000000000000000000001'))
        await store.apiKeys.upsert({ ...key('ak_00000000000000000000000001'), label: 'again' })
        expect(await store.apiKeys.count(ACME)).toBe(1)
      })

      it('deletes, and reports whether there was anything to delete', async () => {
        await store.apiKeys.insert(key('ak_00000000000000000000000001'))
        expect(await store.apiKeys.delete(ACME, 'ak_00000000000000000000000001')).toBe(true)
        expect(await store.apiKeys.delete(ACME, 'ak_00000000000000000000000001')).toBe(false)
      })

      it('filters, sorts and limits', async () => {
        await store.apiKeys.insert(key('ak_00000000000000000000000001'))
        await store.apiKeys.insert({ ...key('ak_00000000000000000000000002'), label: 'other' })
        await store.apiKeys.insert({ ...key('ak_00000000000000000000000003'), revokedAt: AT })

        expect(await store.apiKeys.find(ACME, { where: { label: 'other' } })).toHaveLength(1)
        expect(await store.apiKeys.find(ACME, { where: { revokedAt: null } })).toHaveLength(2)
        expect(await store.apiKeys.find(ACME, { limit: 2 })).toHaveLength(2)

        const descending = await store.apiKeys.find(ACME, {
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
        const first = await store.apiKeys.get(ACME, 'ak_00000000000000000000000001')
        first!.label = 'mutated in place'
        expect((await store.apiKeys.get(ACME, 'ak_00000000000000000000000001'))?.label).toBe(
          'backoffice',
        )
      })

      it('finds an API key by id alone, because an inbound request has nothing else', async () => {
        await store.apiKeys.insert(key('ak_00000000000000000000000002', VANMOER))
        const found = await store.findApiKeyById('ak_00000000000000000000000002')
        expect(found?.participantId).toBe(VANMOER)
        expect(await store.findApiKeyById('ak_00000000000000000000000009')).toBeUndefined()
      })
    })

    // ─────────────────────────────────────────────────────────────────────────
    describe('appendEvent — one atomic operation', () => {
      it('writes the event and the instance together', async () => {
        const result = await append(store, {
          participantId: ACME,
          expectedSeq: 0,
          event: eventAt(1, 'ORDERED', null),
          instanceAfter: instanceAt(1, 'ORDERED'),
        })
        expect(result.ok).toBe(true)

        expect((await store.instances.get(ACME, INSTANCE))?.seq).toBe(1)
        expect(await store.events.read(ACME, INSTANCE)).toHaveLength(1)
      })

      it('advances an existing instance', async () => {
        await append(store, {
          participantId: ACME,
          expectedSeq: 0,
          event: eventAt(1, 'ORDERED', null),
          instanceAfter: instanceAt(1, 'ORDERED'),
        })
        const result = await append(store, {
          participantId: ACME,
          expectedSeq: 1,
          event: eventAt(2, 'TRUCK_ANNOUNCED', 'ORDERED', { truckPlate: '1-ABC-123' }),
          instanceAfter: instanceAt(2, 'TRUCK_ANNOUNCED'),
        })
        expect(result.ok).toBe(true)
        expect((await store.instances.get(ACME, INSTANCE))?.state).toBe('TRUCK_ANNOUNCED')
        expect(await store.events.read(ACME, INSTANCE)).toHaveLength(2)
      })

      it('reports a conflict with the actual seq when expectedSeq is stale', async () => {
        await append(store, {
          participantId: ACME,
          expectedSeq: 0,
          event: eventAt(1, 'ORDERED', null),
          instanceAfter: instanceAt(1, 'ORDERED'),
        })

        const stale = await append(store, {
          participantId: ACME,
          expectedSeq: 0,
          event: eventAt(2, 'TRUCK_ANNOUNCED', 'ORDERED'),
          instanceAfter: instanceAt(2, 'TRUCK_ANNOUNCED'),
        })

        expect(stale.ok).toBe(false)
        if (!stale.ok) expect(stale.conflict.actualSeq).toBe(1)
      })

      it('leaves NO partial write behind after a conflict', async () => {
        await append(store, {
          participantId: ACME,
          expectedSeq: 0,
          event: eventAt(1, 'ORDERED', null),
          instanceAfter: instanceAt(1, 'ORDERED'),
        })

        await append(store, {
          participantId: ACME,
          expectedSeq: 0,
          event: eventAt(2, 'PAID', 'ORDERED'),
          instanceAfter: instanceAt(2, 'PAID'),
        })

        // Never an appended event with an unadvanced instance, nor the reverse.
        const instance = await store.instances.get(ACME, INSTANCE)
        const events = await store.events.read(ACME, INSTANCE)
        expect(instance?.seq).toBe(1)
        expect(instance?.state).toBe('ORDERED')
        expect(events).toHaveLength(1)
        expect(events[0]?.header.seq).toBe(1)
      })

      it('gives exactly one winner when two writers race the same seq', async () => {
        await append(store, {
          participantId: ACME,
          expectedSeq: 0,
          event: eventAt(1, 'ORDERED', null),
          instanceAfter: instanceAt(1, 'ORDERED'),
        })

        const results = await Promise.all([
          append(store, {
            participantId: ACME,
            expectedSeq: 1,
            event: eventAt(2, 'TRUCK_ANNOUNCED', 'ORDERED', { truckPlate: 'A' }),
            instanceAfter: instanceAt(2, 'TRUCK_ANNOUNCED'),
          }),
          append(store, {
            participantId: ACME,
            expectedSeq: 1,
            event: eventAt(2, 'CANCELLED', 'ORDERED', { cancellationReason: 'B' }),
            instanceAfter: instanceAt(2, 'CANCELLED'),
          }),
        ])

        expect(results.filter((r) => r.ok)).toHaveLength(1)
        expect(results.filter((r) => !r.ok)).toHaveLength(1)

        const events = await store.events.read(ACME, INSTANCE)
        expect(events).toHaveLength(2)
        expect(events.map((e) => e.header.seq)).toEqual([1, 2])
        expect((await store.instances.get(ACME, INSTANCE))?.seq).toBe(2)
      })

      it('refuses an event whose seq does not follow the instance', async () => {
        const result = await append(store, {
          participantId: ACME,
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
          home: participantId === VANMOER,
        },
      })

      it('writes one instance to every participant that takes part in it', async () => {
        const result = await store.appendEvent([
          writeFor(ACME, 1, 'ORDERED'),
          writeFor(VANMOER, 1, 'ORDERED'),
        ])
        expect(result.ok).toBe(true)

        // Each participant holds its own copy, and only the host is `home`.
        expect((await store.instances.get(ACME, INSTANCE))?.home).toBe(false)
        expect((await store.instances.get(VANMOER, INSTANCE))?.home).toBe(true)
        expect(await store.events.read(ACME, INSTANCE)).toHaveLength(1)
        expect(await store.events.read(VANMOER, INSTANCE)).toHaveLength(1)
      })

      it('applies nothing at all when any one write conflicts', async () => {
        await store.appendEvent([writeFor(ACME, 1, 'ORDERED'), writeFor(VANMOER, 1, 'ORDERED')])

        // Van Moer's copy is at 1; Acme's is too. Ask for a batch where only
        // one side is stale.
        const mixed = await store.appendEvent([
          { ...writeFor(ACME, 2, 'TRUCK_ANNOUNCED'), expectedSeq: 1 },
          { ...writeFor(VANMOER, 2, 'TRUCK_ANNOUNCED'), expectedSeq: 0 },
        ])

        expect(mixed.ok).toBe(false)
        if (!mixed.ok) expect(mixed.conflict.participantId).toBe(VANMOER)

        // Acme must NOT have advanced, even though its own write was valid.
        expect((await store.instances.get(ACME, INSTANCE))?.seq).toBe(1)
        expect(await store.events.read(ACME, INSTANCE)).toHaveLength(1)
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
            participantId: ACME,
            expectedSeq: seq - 1,
            event: eventAt(seq, `STATE_${seq}`, seq === 1 ? null : `STATE_${seq - 1}`, { n: seq }),
            instanceAfter: instanceAt(seq, `STATE_${seq}`),
          })
        }
      })

      it('reads in seq order', async () => {
        const events = await store.events.read(ACME, INSTANCE)
        expect(events.map((e) => e.header.seq)).toEqual([1, 2, 3])
      })

      it('reads strictly after a cursor, which is what ?since= means', async () => {
        expect((await store.events.read(ACME, INSTANCE, 1)).map((e) => e.header.seq)).toEqual([
          2, 3,
        ])
        expect(await store.events.read(ACME, INSTANCE, 3)).toEqual([])
      })

      it('limits', async () => {
        expect(await store.events.read(ACME, INSTANCE, 0, 2)).toHaveLength(2)
      })

      it('reports the head', async () => {
        expect((await store.events.head(ACME, INSTANCE))?.header.seq).toBe(3)
        expect(await store.events.head(ACME, '01J0000000000000000000000B')).toBeUndefined()
      })

      it('streams every event for a participant behind a monotonic cursor', async () => {
        const all = await store.events.readAll(ACME)
        expect(all).toHaveLength(3)
        expect(all.map((e) => e.cursor)).toEqual([...all.map((e) => e.cursor)].sort())

        const after = await store.events.readAll(ACME, all[0]!.cursor)
        expect(after.map((e) => e.event.header.seq)).toEqual([2, 3])
      })

      it('never leaks another participant’s events', async () => {
        expect(await store.events.read(VANMOER, INSTANCE)).toEqual([])
        expect(await store.events.readAll(VANMOER)).toEqual([])
      })
    })

    // ─────────────────────────────────────────────────────────────────────────
    describe('claimIdempotencyKey — exactly one winner', () => {
      it('lets the first caller through and replays the result to the second', async () => {
        expect(await store.idempotency.claim(ACME, 'k1', 'transition', AT)).toBeNull()
        await store.idempotency.complete(ACME, 'k1', { seq: 4 }, AT)

        const replay = await store.idempotency.claim(ACME, 'k1', 'transition', AT)
        expect(replay?.status).toBe('complete')
        expect(replay?.result).toEqual({ seq: 4 })
      })

      it('gives exactly one winner under a genuine race', async () => {
        const claims = await Promise.all([
          store.idempotency.claim(ACME, 'race', 'transition', AT),
          store.idempotency.claim(ACME, 'race', 'transition', AT),
          store.idempotency.claim(ACME, 'race', 'transition', AT),
        ])
        expect(claims.filter((c) => c === null)).toHaveLength(1)
        expect(claims.filter((c) => c !== null)).toHaveLength(2)
      })

      it('reports a still-running original as pending rather than complete', async () => {
        await store.idempotency.claim(ACME, 'k2', 'transition', AT)
        const second = await store.idempotency.claim(ACME, 'k2', 'transition', AT)
        expect(second?.status).toBe('pending')
      })

      it('releases a claim whose work failed, so a retry is not blocked forever', async () => {
        await store.idempotency.claim(ACME, 'k3', 'transition', AT)
        await store.idempotency.release(ACME, 'k3')
        expect(await store.idempotency.claim(ACME, 'k3', 'transition', AT)).toBeNull()
      })

      it('scopes keys by participant and by operation', async () => {
        await store.idempotency.claim(ACME, 'shared', 'transition', AT)
        expect(await store.idempotency.claim(VANMOER, 'shared', 'transition', AT)).toBeNull()
        expect(await store.idempotency.claim(ACME, 'shared', 'instance.create', AT)).toBeNull()
      })
    })

    // ─────────────────────────────────────────────────────────────────────────
    describe('the audit log', () => {
      const entry = (action: string, participantId = ACME) => ({
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
        await store.audit.append(entry('a', ACME))
        const other = await store.audit.append(entry('b', VANMOER))
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

        expect((await store.audit.read(ACME)).map((e) => e.action)).toEqual(['a', 'b', 'c'])
        expect((await store.audit.read(ACME, 1)).map((e) => e.action)).toEqual(['b', 'c'])
        expect((await store.audit.head(ACME))?.action).toBe('c')
        expect(await store.audit.count(ACME)).toBe(3)
      })

      it('records denials, which is the whole reason it exists', async () => {
        await store.audit.append({
          ...entry('transition.apply'),
          outcome: 'denied',
          problem: 'urn:pilots:problem:role-not-permitted',
        })
        expect((await store.audit.read(ACME))[0]?.outcome).toBe('denied')
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
            participantId: ACME,
            expectedSeq: 0,
            event: eventAt(1, 'ORDERED', null, { containerNumber: 'MSCU1234567' }),
            instanceAfter: instanceAt(1, 'ORDERED'),
          })
          await store.audit.append({
            at: AT,
            participantId: ACME,
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
            const instance = await reopened.instances.get(ACME, INSTANCE)
            const events = await reopened.events.read(ACME, INSTANCE)

            if (!context.persistent) {
              expect(instance).toBeUndefined()
              expect(events).toEqual([])
              return
            }

            expect(instance?.state).toBe('ORDERED')
            expect(instance?.seq).toBe(1)
            expect(events).toHaveLength(1)
            expect(events[0]?.payload).toEqual({ containerNumber: 'MSCU1234567' })
            expect((await reopened.audit.head(ACME))?.action).toBe('instance.create')
            // The chain has to survive too, or the audit log's tamper evidence
            // only holds for as long as the process does.
            expect((await reopened.audit.head(ACME))?.seq).toBe(1)
          } finally {
            await reopened.close()
          }
        },
      )
    })
  })
}
