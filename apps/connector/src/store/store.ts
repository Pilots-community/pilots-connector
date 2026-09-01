/**
 * The `Store` a connector runs against.
 *
 * Three adapters, one conformance suite, configuration chooses:
 *
 * | Profile                  | Adapter | Containers |
 * |--------------------------|---------|------------|
 * | unit and scenario tests  | memory  | 0          |
 * | dev, demo, small party   | file    | 0          |
 * | large party              | mongo   | 0 self-run |
 *
 * The Mongo adapter lands at M3, not at the end, because memory and file are
 * both in-process and single-writer and so hide precisely the contracts a
 * networked store differs on.
 */
import type {
  ApiKeyRecord,
  Connection,
  NotificationSubscription,
  Offering,
  StoredInstance,
} from '@pilots/protocol'

import type {
  AppendEventResult,
  AuditLog,
  Collection,
  EventLog,
  EventWrite,
  IdempotencyStore,
  StoredDocument,
} from './types.js'

/** A participant this connector holds a key for and acts on behalf of. */
export interface ParticipantRecord extends StoredDocument {
  /** For a participant, `id` and `participantId` are the same value. */
  did: string
  displayName: string
  baseUrl: string
  createdAt: string
}

export type ApiKeyDocument = ApiKeyRecord & StoredDocument
export type ConnectionDocument = Connection & StoredDocument
export type OfferingDocument = Offering & StoredDocument
export type SubscriptionDocument = NotificationSubscription & StoredDocument
export type InstanceDocument = StoredInstance & StoredDocument

export interface Store {
  readonly participants: Collection<ParticipantRecord>
  readonly apiKeys: Collection<ApiKeyDocument>
  readonly connections: Collection<ConnectionDocument>
  readonly offerings: Collection<OfferingDocument>
  readonly subscriptions: Collection<SubscriptionDocument>
  readonly instances: Collection<InstanceDocument>
  readonly events: EventLog
  readonly idempotency: IdempotencyStore
  readonly audit: AuditLog

  /**
   * Append each event and update each materialised instance — **all of them, or
   * none**. The log is the truth and the instance document is a cache of it, so
   * the two must never diverge, for any participant in the batch.
   */
  appendEvent(writes: readonly EventWrite[]): Promise<AppendEventResult>

  /**
   * Look an API key up by its public id **across participants**.
   *
   * The one deliberate exception to participant-scoped reads: an inbound request
   * presents a key id and nothing else, so the participant is what the lookup
   * returns rather than something the caller can supply.
   */
  findApiKeyById(id: string): Promise<ApiKeyDocument | undefined>

  close(): Promise<void>
}

/** DI token. Nest cannot inject an interface, so the port needs a symbol. */
export const STORE = Symbol('Store')
