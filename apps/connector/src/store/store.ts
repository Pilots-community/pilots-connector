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
  JsonObject,
  NotificationSubscription,
  Offering,
  StoredInstance,
} from '@pilots/protocol'

import type {
  AppendEventResult,
  AttachmentStore,
  AuditLog,
  Collection,
  EventLog,
  EventWrite,
  IdempotencyStore,
  NotificationDocument,
  StoredDocument,
  TrustedPeerDocument,
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
  readonly notifications: Collection<NotificationDocument>
  readonly trustedPeers: Collection<TrustedPeerDocument>
  readonly events: EventLog
  readonly attachments: AttachmentStore
  readonly idempotency: IdempotencyStore
  readonly audit: AuditLog

  /**
   * Append each event and update each materialised instance — **all of them, or
   * none**. The log is the truth and the instance document is a cache of it, so
   * the two must never diverge, for any participant in the batch.
   */
  appendEvent(writes: readonly EventWrite[]): Promise<AppendEventResult>

  /**
   * Fill in a payload we were not entitled to see when the event arrived.
   *
   * Visibility is state-dependent, so a field withheld at `WEIGHED` may be
   * released at `PAID`. A replica cannot re-filter its way to a value it was
   * never sent, so the home node sends it when entitlement begins and this is
   * where it lands.
   *
   * **Completion, never replacement.** The header and signature are untouched
   * and the caller has already checked the new payload against the header's
   * `payloadHash`, so the only thing that can change is a redacted payload
   * becoming the genuine full one. Atomic with the instance it re-folds to, for
   * the same reason `appendEvent` is.
   */
  completeEvent(write: {
    participantId: string
    instanceId: string
    seq: number
    payload: JsonObject
    instanceAfter: StoredInstance
  }): Promise<boolean>

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
