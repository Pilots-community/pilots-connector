/**
 * The in-memory store: the test default, and the core the file adapter builds on.
 *
 * Every mutation's critical section is **synchronous**, so it is atomic against
 * every other caller without a lock — JavaScript gives us that for free, and it
 * is the honest way to get it. Durability, where an adapter wants it, happens
 * *after* the critical section through the `Journal` hook.
 */
import { chainAuditEntry, foldEvents, type AuditEntry, type StoredEvent } from '@pilots/protocol'

import type {
  ApiKeyDocument,
  ConnectionDocument,
  InstanceDocument,
  OfferingDocument,
  ParticipantRecord,
  Store,
  SubscriptionDocument,
} from '../store.js'
import {
  DuplicateKeyError,
  NotFoundError,
  type AppendEventResult,
  type AuditLog,
  type Collection,
  type CursoredEvent,
  type EventLog,
  type EventWrite,
  type IdempotencyRecord,
  type IdempotencyStore,
  type Query,
  type StoredDocument,
} from '../types.js'

/**
 * Anything that wants writes to outlive the process implements this. It is
 * called after the mutation has already been applied in memory, so a journal
 * failure never leaves the in-memory state half-changed.
 */
export interface Journal {
  /** One document at a time: rewriting a whole collection per write is quadratic. */
  writeDocument(collection: string, document: StoredDocument): Promise<void>
  deleteDocument(collection: string, participantId: string, id: string): Promise<void>
  appendEvent(event: StoredEvent): Promise<void>
  appendAudit(entry: AuditEntry): Promise<void>
}

export interface MemoryState {
  collections: Map<string, Map<string, StoredDocument>>
  /** Per participant, in recording order. The index into it is the stream cursor. */
  events: Map<string, StoredEvent[]>
  audit: Map<string, AuditEntry[]>
  idempotency: Map<string, IdempotencyRecord>
}

export function emptyState(): MemoryState {
  return {
    collections: new Map(),
    events: new Map(),
    audit: new Map(),
    idempotency: new Map(),
  }
}

/**
 * The composite key every collection is addressed by. Exported because the file
 * adapter rebuilds these maps when it loads, and a second copy of this rule is a
 * bug waiting to happen — it already was one.
 */
export function documentKey(participantId: string, id: string): string {
  return `${participantId}\u0000${id}`
}

const key = documentKey

function clone<T>(value: T): T {
  return structuredClone(value)
}

/**
 * Order two field values. Only strings and numbers sort meaningfully; anything
 * else keeps its insertion order rather than being stringified into
 * `[object Object]` and compared as nonsense.
 */
function compare(left: unknown, right: unknown): number {
  if (typeof left === 'number' && typeof right === 'number') return left - right
  if (typeof left === 'string' && typeof right === 'string') return left.localeCompare(right)
  if (left == null && right == null) return 0
  if (left == null) return 1
  if (right == null) return -1
  return 0
}

/** Cursors are zero-padded so lexical and numeric order agree. */
function toCursor(index: number): string {
  return String(index + 1).padStart(12, '0')
}

class MapCollection<T extends StoredDocument> implements Collection<T> {
  constructor(
    private readonly name: string,
    private readonly state: MemoryState,
    private readonly journal: Journal | undefined,
  ) {
    if (!state.collections.has(name)) state.collections.set(name, new Map())
  }

  private get documents(): Map<string, StoredDocument> {
    return this.state.collections.get(this.name)!
  }

  async get(participantId: string, id: string): Promise<T | undefined> {
    const found = this.documents.get(key(participantId, id))
    return found ? (clone(found) as T) : undefined
  }

  async find(participantId: string, query: Query<T> = {}): Promise<T[]> {
    let matches = [...this.documents.values()].filter(
      (doc) => doc.participantId === participantId,
    ) as T[]

    if (query.where) {
      const conditions = Object.entries(query.where)
      matches = matches.filter((doc) =>
        conditions.every(([field, expected]) => {
          const actual = (doc as Record<string, unknown>)[field]
          return Array.isArray(expected)
            ? JSON.stringify(actual) === JSON.stringify(expected)
            : actual === expected
        }),
      )
    }

    const field = query.sort?.field ?? 'id'
    const descending = query.sort?.direction === 'desc'
    matches.sort((a, b) => {
      const order = compare(
        (a as Record<string, unknown>)[field],
        (b as Record<string, unknown>)[field],
      )
      return descending ? -order : order
    })

    if (query.after !== undefined) {
      const index = matches.findIndex((doc) => doc.id === query.after)
      matches = index === -1 ? matches : matches.slice(index + 1)
    }
    if (query.limit !== undefined) matches = matches.slice(0, query.limit)

    return matches.map((doc) => clone(doc))
  }

  async insert(document: T): Promise<void> {
    const id = key(document.participantId, document.id)
    if (this.documents.has(id)) {
      throw new DuplicateKeyError(this.name, document.participantId, document.id)
    }
    this.documents.set(id, clone(document))
    await this.journal?.writeDocument(this.name, document)
  }

  async replace(document: T): Promise<void> {
    const id = key(document.participantId, document.id)
    if (!this.documents.has(id)) {
      throw new NotFoundError(this.name, document.participantId, document.id)
    }
    this.documents.set(id, clone(document))
    await this.journal?.writeDocument(this.name, document)
  }

  async upsert(document: T): Promise<void> {
    this.documents.set(key(document.participantId, document.id), clone(document))
    await this.journal?.writeDocument(this.name, document)
  }

  async delete(participantId: string, id: string): Promise<boolean> {
    const existed = this.documents.delete(key(participantId, id))
    if (existed) await this.journal?.deleteDocument(this.name, participantId, id)
    return existed
  }

  async count(participantId: string, query?: Query<T>): Promise<number> {
    return (await this.find(participantId, query)).length
  }
}

class MemoryEventLog implements EventLog {
  constructor(private readonly state: MemoryState) {}

  private forParticipant(participantId: string): StoredEvent[] {
    return this.state.events.get(participantId) ?? []
  }

  async read(
    participantId: string,
    instanceId: string,
    sinceSeq = 0,
    limit?: number,
  ): Promise<StoredEvent[]> {
    const matches = this.forParticipant(participantId)
      .filter((event) => event.header.instance === instanceId && event.header.seq > sinceSeq)
      .sort((a, b) => a.header.seq - b.header.seq)
    return (limit === undefined ? matches : matches.slice(0, limit)).map((e) => clone(e))
  }

  async head(participantId: string, instanceId: string): Promise<StoredEvent | undefined> {
    const events = await this.read(participantId, instanceId)
    return events.at(-1)
  }

  async readAll(
    participantId: string,
    sinceCursor?: string,
    limit?: number,
  ): Promise<CursoredEvent[]> {
    const cursored = this.forParticipant(participantId).map((event, index) => ({
      cursor: toCursor(index),
      event,
    }))
    const after =
      sinceCursor === undefined ? cursored : cursored.filter((e) => e.cursor > sinceCursor)
    const limited = limit === undefined ? after : after.slice(0, limit)
    return limited.map(({ cursor, event }) => ({ cursor, event: clone(event) }))
  }
}

class MemoryIdempotency implements IdempotencyStore {
  constructor(
    private readonly state: MemoryState,
    private readonly journal: Journal | undefined,
  ) {}

  private id(participantId: string, key_: string, scope: string): string {
    return `${participantId}\u0000${scope}\u0000${key_}`
  }

  async claim(
    participantId: string,
    key_: string,
    scope: string,
    at: string,
  ): Promise<IdempotencyRecord | null> {
    const id = this.id(participantId, key_, scope)
    const existing = this.state.idempotency.get(id)
    // Insert-if-absent, in one synchronous step: two concurrent retries of the
    // same request must produce exactly one winner.
    if (existing) return clone(existing)

    const record: IdempotencyRecord = {
      id,
      participantId,
      key: key_,
      scope,
      status: 'pending',
      result: null,
      createdAt: at,
      completedAt: null,
    }
    this.state.idempotency.set(id, record)
    await this.journal?.writeDocument('idempotency', record)
    return null
  }

  async complete(participantId: string, key_: string, result: unknown, at: string): Promise<void> {
    for (const [id, record] of [...this.state.idempotency]) {
      if (!this.matches(record, participantId, key_)) continue
      const completed: IdempotencyRecord = {
        ...record,
        status: 'complete',
        result: clone(result),
        completedAt: at,
      }
      this.state.idempotency.set(id, completed)
      await this.journal?.writeDocument('idempotency', completed)
    }
  }

  async release(participantId: string, key_: string): Promise<void> {
    for (const [id, record] of [...this.state.idempotency]) {
      if (!this.matches(record, participantId, key_)) continue
      this.state.idempotency.delete(id)
      await this.journal?.deleteDocument('idempotency', record.participantId, record.id)
    }
  }

  private matches(record: IdempotencyRecord, participantId: string, key_: string): boolean {
    return record.participantId === participantId && record.key === key_
  }
}

class MemoryAuditLog implements AuditLog {
  constructor(
    private readonly state: MemoryState,
    private readonly journal: Journal | undefined,
  ) {}

  private entries(participantId: string): AuditEntry[] {
    let entries = this.state.audit.get(participantId)
    if (!entries) {
      entries = []
      this.state.audit.set(participantId, entries)
    }
    return entries
  }

  async append(draft: Omit<AuditEntry, 'seq' | 'prev'>): Promise<AuditEntry> {
    // Synchronous: `seq` and `prev` are assigned and the entry is pushed in one
    // step, because a caller that read the head and then wrote would race every
    // other caller and silently fork the chain.
    const entries = this.entries(draft.participantId)
    const entry = chainAuditEntry(draft, entries.at(-1) ?? null)
    entries.push(entry)
    await this.journal?.appendAudit(entry)
    return clone(entry)
  }

  async read(participantId: string, sinceSeq = 0, limit?: number): Promise<AuditEntry[]> {
    const matches = this.entries(participantId).filter((entry) => entry.seq > sinceSeq)
    return (limit === undefined ? matches : matches.slice(0, limit)).map((e) => clone(e))
  }

  async head(participantId: string): Promise<AuditEntry | undefined> {
    const last = this.entries(participantId).at(-1)
    return last ? clone(last) : undefined
  }

  async count(participantId: string): Promise<number> {
    return this.entries(participantId).length
  }
}

export class MemoryStore implements Store {
  readonly participants: Collection<ParticipantRecord>
  readonly apiKeys: Collection<ApiKeyDocument>
  readonly connections: Collection<ConnectionDocument>
  readonly offerings: Collection<OfferingDocument>
  readonly subscriptions: Collection<SubscriptionDocument>
  readonly instances: Collection<InstanceDocument>
  readonly events: EventLog
  readonly idempotency: IdempotencyStore
  readonly audit: AuditLog

  constructor(
    protected readonly state: MemoryState = emptyState(),
    private readonly journal?: Journal,
  ) {
    this.participants = new MapCollection('participants', state, journal)
    this.apiKeys = new MapCollection('apiKeys', state, journal)
    this.connections = new MapCollection('connections', state, journal)
    this.offerings = new MapCollection('offerings', state, journal)
    this.subscriptions = new MapCollection('subscriptions', state, journal)
    this.instances = new MapCollection('instances', state, journal)
    this.events = new MemoryEventLog(state)
    this.idempotency = new MemoryIdempotency(state, journal)
    this.audit = new MemoryAuditLog(state, journal)
  }

  async appendEvent(writes: readonly EventWrite[]): Promise<AppendEventResult> {
    const instances = this.state.collections.get('instances')!

    // ── critical section: synchronous, so no other caller can interleave ──
    // Check every write before applying any of them: all-or-nothing means a
    // participant whose copy conflicts must not leave the others advanced.
    for (const write of writes) {
      const current = instances.get(key(write.participantId, write.instanceAfter.id)) as
        InstanceDocument | undefined
      const actualSeq = current?.seq ?? 0
      if (
        actualSeq !== write.expectedSeq ||
        write.event.header.seq !== write.expectedSeq + 1 ||
        write.instanceAfter.seq !== write.expectedSeq + 1
      ) {
        return { ok: false, conflict: { participantId: write.participantId, actualSeq } }
      }
    }

    for (const write of writes) {
      const events = this.state.events.get(write.participantId) ?? []
      events.push(clone(write.event))
      this.state.events.set(write.participantId, events)
      instances.set(key(write.participantId, write.instanceAfter.id), clone(write.instanceAfter))
    }
    // ── end critical section ──

    // The log is the truth and the instance document is a cache of it, so the
    // events go to disk first. A crash between the two leaves an instance behind
    // its log, which reopening reconciles; the reverse would leave a connector
    // claiming a transition it cannot show.
    if (this.journal) {
      for (const write of writes) await this.journal.appendEvent(write.event)
      for (const write of writes) {
        await this.journal.writeDocument('instances', write.instanceAfter)
      }
    }

    return { ok: true }
  }

  async findApiKeyById(id: string): Promise<ApiKeyDocument | undefined> {
    for (const document of this.state.collections.get('apiKeys')!.values()) {
      if (document.id === id) return clone(document) as ApiKeyDocument
    }
    return undefined
  }

  async close(): Promise<void> {
    // Nothing to release: an in-memory store is exactly as durable as the process.
  }
}

/**
 * Rebuild a materialised instance from its own log.
 *
 * Used when reopening a file store finds an instance behind its events — the
 * log is the truth, so the cache is what gets corrected.
 */
export function reconcileInstance(
  instance: InstanceDocument,
  events: readonly StoredEvent[],
): InstanceDocument {
  if (events.length === 0 || events.length === instance.seq) return instance
  const folded = foldEvents(events)
  return {
    ...instance,
    state: folded.state ?? instance.state,
    seq: folded.seq,
    data: folded.data,
    updatedAt: events.at(-1)?.header.at ?? instance.updatedAt,
  }
}
