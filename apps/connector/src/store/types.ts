/**
 * The store port.
 *
 * Document-oriented, because that is what the artefacts are: a definition, an
 * instance and an event are JSON, and `instance.data` was always an opaque blob
 * validated at the application layer against the definition's JSON Schema. SQL
 * was never what constrained it. What we gain is no ORM, no migrations, and a
 * dev store that needs no infrastructure at all.
 *
 * **Every document carries `participantId`.** The demo runs one participant per
 * connector; the code never assumes it. That is a few hours of care now, and it
 * is what makes the hosted topologies possible without a rewrite.
 *
 * Connector-internal by design. Nothing outside the connector consumes a
 * repository, so promoting this to a shared package would be packaging for its
 * own sake.
 */
import type { AuditEntry, StoredEvent, StoredInstance } from '@pilots/protocol'

/** Every stored document is addressable by `(participantId, id)`. */
export interface StoredDocument {
  id: string
  participantId: string
}

/** Equality on top-level fields. Deliberately not a query language. */
export type Where<T> = { [K in keyof T]?: T[K] }

export interface Query<T> {
  where?: Where<T>
  /** Top-level field to sort by. Documents missing it sort last. */
  sort?: { field: keyof T & string; direction?: 'asc' | 'desc' }
  limit?: number
  /** Skip documents whose `id` is at or before this one, in sort order. */
  after?: string
}

/**
 * One collection of documents belonging to one participant.
 *
 * Reads are always scoped by `participantId` — there is no cross-participant
 * read on this interface, which is what keeps multi-tenancy readiness from
 * decaying into a filter someone forgets to apply.
 */
export interface Collection<T extends StoredDocument> {
  get(participantId: string, id: string): Promise<T | undefined>
  find(participantId: string, query?: Query<T>): Promise<T[]>
  /** Rejects with `DuplicateKeyError` if `(participantId, id)` already exists. */
  insert(document: T): Promise<void>
  /** Rejects with `NotFoundError` if it does not exist. */
  replace(document: T): Promise<void>
  /** Insert or replace. */
  upsert(document: T): Promise<void>
  delete(participantId: string, id: string): Promise<boolean>
  count(participantId: string, query?: Query<T>): Promise<number>
}

/**
 * A notification, queued for local delivery and kept as the replay log.
 *
 * One record does both jobs on purpose. `GET /notifications?since=<cursor>` is
 * specified as *authoritative* recovery, so the notification has to be stored
 * anyway; a separate delivery queue beside it would be a second copy that could
 * disagree about what was sent.
 *
 * The cursor **is** the `id`: monotonic ULIDs sort lexicographically, so
 * "everything after this cursor" is an ordinary range read rather than a second
 * ordering to keep consistent.
 */
export interface NotificationDocument extends StoredDocument {
  subscriptionId: string
  notification: string
  instanceId: string
  createdAt: string
  /** The envelope exactly as it will be delivered, already visibility-filtered. */
  envelope: unknown
  status: 'pending' | 'delivered' | 'dead'
  attempts: number
  /** When the next attempt becomes due. Compared against `Clock`, never a timer. */
  nextAttemptAt: string | null
  lastError: string | null
}

/**
 * A peer whose connection requests are accepted without asking the operator.
 *
 * Operator state, and deliberately not configuration: a demo that seeds trust
 * from a file and a production connector that curates it in the admin UI should
 * be the same code path with different data.
 */
export interface TrustedPeerDocument extends StoredDocument {
  /** The peer's DID. Also the document id, so the allowlist cannot hold duplicates. */
  did: string
  addedAt: string
  note: string | null
}

export class DuplicateKeyError extends Error {
  constructor(
    readonly collection: string,
    readonly participantId: string,
    readonly id: string,
  ) {
    super(`${collection}: ${id} already exists for participant ${participantId}`)
    this.name = 'DuplicateKeyError'
  }
}

export class NotFoundError extends Error {
  constructor(
    readonly collection: string,
    readonly participantId: string,
    readonly id: string,
  ) {
    super(`${collection}: ${id} not found for participant ${participantId}`)
    this.name = 'NotFoundError'
  }
}

/**
 * The event log for one participant.
 *
 * Separate from `Collection` because every read of it is a range over `seq`, and
 * bending a document query language into that would be worse than naming it.
 */
export interface EventLog {
  /** Events for one instance with `seq` strictly greater than `sinceSeq`, in order. */
  read(
    participantId: string,
    instanceId: string,
    sinceSeq?: number,
    limit?: number,
  ): Promise<StoredEvent[]>
  /** The most recent event for an instance, or undefined when there is none. */
  head(participantId: string, instanceId: string): Promise<StoredEvent | undefined>
  /**
   * Every event this participant holds, across instances, in the order they were
   * recorded — the cursor the local SSE stream and peer delivery both replay
   * from. The cursor is opaque and monotonic.
   */
  readAll(participantId: string, sinceCursor?: string, limit?: number): Promise<CursoredEvent[]>
}

export interface CursoredEvent {
  cursor: string
  event: StoredEvent
}

/**
 * Appending an event and updating the materialised instance is **one atomic
 * operation**. They must never diverge: the log is the truth and the instance
 * document is a cache of it, so a partial write leaves a connector that
 * disagrees with itself and with every peer.
 *
 * It takes a **list** of writes, all-or-nothing, because one transition can
 * touch several participants: every participant this connector holds who takes
 * part in the instance keeps its own copy and its own log. With one participant
 * that list has one entry; with a hosted tenant beside its counterparty it has
 * two, and only one of them carries `home: true`.
 *
 * This, and `claimIdempotencyKey`, are the two operations that decide the
 * interface. Everything else is ordinary reads and writes.
 */
export interface EventWrite {
  participantId: string
  /**
   * The `seq` the caller believes the instance is at. `0` when creating, which
   * is what makes creation and advance the same code path.
   */
  expectedSeq: number
  event: StoredEvent
  instanceAfter: StoredInstance
}

export interface SeqConflict {
  /** Which participant's copy conflicted. */
  participantId: string
  /** What the instance's `seq` actually is, so the caller can report it in the 409. */
  actualSeq: number
}

export type AppendEventResult = { ok: true } | { ok: false; conflict: SeqConflict }

/**
 * An `Idempotency-Key` claim.
 *
 * `claim` is insert-if-absent and must be a real unique constraint, not a
 * read-then-write: two concurrent retries of the same request have to produce
 * exactly one winner, with the loser getting the stored result rather than a
 * second transition.
 */
export interface IdempotencyRecord {
  id: string
  participantId: string
  /** The client's `Idempotency-Key`, stored rather than parsed back out of `id`. */
  key: string
  /** Which operation the key was used for, so one key cannot cross endpoints. */
  scope: string
  status: 'pending' | 'complete'
  /** The response body to replay, once the original request finished. */
  result: unknown
  createdAt: string
  completedAt: string | null
}

export interface IdempotencyStore {
  /** `null` means the caller won the claim and should do the work. */
  claim(
    participantId: string,
    key: string,
    scope: string,
    at: string,
  ): Promise<IdempotencyRecord | null>
  complete(participantId: string, key: string, result: unknown, at: string): Promise<void>
  /** Release a claim whose work failed, so a retry is not permanently blocked. */
  release(participantId: string, key: string): Promise<void>
}

/**
 * Content-addressed document bytes.
 *
 * Separate from `Collection` because the key is a **hash of the content**, not
 * an id somebody assigned — which is what makes documents deduplicated and
 * tamper-evident, and what keeps base64 out of the event stream. The event
 * header lists `{ sha256, mime, size }`; the bytes live here.
 *
 * Scoped by participant like everything else. Two participants on one connector
 * that happen to hold the same document hold it twice: cheap, and it keeps the
 * "no cross-participant read" rule intact rather than making an exception for
 * the one collection where content is identical by definition.
 */
export interface AttachmentStore {
  put(participantId: string, attachment: StoredAttachment): Promise<void>
  get(participantId: string, sha256: string): Promise<StoredAttachment | undefined>
  has(participantId: string, sha256: string): Promise<boolean>
  /** Metadata only — what a listing needs without reading the bytes. */
  list(participantId: string): Promise<Omit<StoredAttachment, 'bytes'>[]>
}

export interface StoredAttachment {
  /** `sha256:<hex>` of `bytes`. The store never assigns this; the caller proves it. */
  sha256: string
  mime: string
  size: number
  bytes: Uint8Array
  receivedAt: string
}

/**
 * The audit log, append-only and locally hash-chained.
 *
 * `append` assigns `seq` and `prev` itself, because a caller that read the head
 * and then wrote would race with every other caller and silently fork the chain.
 */
export interface AuditLog {
  append(entry: Omit<AuditEntry, 'seq' | 'prev'>): Promise<AuditEntry>
  read(participantId: string, sinceSeq?: number, limit?: number): Promise<AuditEntry[]>
  head(participantId: string): Promise<AuditEntry | undefined>
  count(participantId: string): Promise<number>
}
