/**
 * The shapes the local API exchanges.
 *
 * Deliberately thin, and mostly re-exports. `Instance`, `SignedEvent` and the
 * rest are the *protocol's* types — the client is a way to call the API, not a
 * second definition of what the API is about. Anything declared here is either
 * a request body or a response envelope, which is to say something that exists
 * only because there is an HTTP call.
 */
import type {
  AttachmentRef,
  AvailableAction,
  Connection,
  Instance,
  InstanceOutcome,
  JsonObject,
  NotificationEnvelope,
  Offering,
  ParticipantMap,
  ProcessDefinition,
  SignedEvent,
} from '@pilots/protocol'

export type {
  AttachmentRef,
  AvailableAction,
  Connection,
  Instance,
  InstanceOutcome,
  JsonObject,
  NotificationEnvelope,
  Offering,
  ParticipantMap,
  ProcessDefinition,
  SignedEvent,
}

/**
 * An instance as the caller may see it.
 *
 * The four fields beyond `Instance` are the ones a caller needs and a stored
 * document does not have: whether this copy is authoritative, what this
 * participant may do next, whether anything was withheld from this view, and
 * whether the process is over.
 */
export interface InstanceView extends Instance {
  /** Whether this connector's copy is the authoritative one. Usually irrelevant to a client. */
  home: boolean
  /**
   * What this participant may fire right now, computed from the definition.
   *
   * This is what lets a UI render buttons for a definition it has never seen:
   * the connector already asked "which transitions list one of our roles in
   * `by` for the current state", and the answer is the same one the permission
   * check and the notifications use.
   */
  available: AvailableAction[]
  /** True when the visibility filter withheld something from this view. */
  redacted: boolean
  /**
   * Whether this process is over, and how — computed from the definition.
   *
   * The generic companion to `state`. `state` is the definition's own
   * vocabulary and means nothing to code that does not hold that definition;
   * this is the half an integrator can act on, so closing a ticket when a
   * process finishes does not mean hardcoding that `VGM_ISSUED` is the good
   * ending of one particular process.
   */
  outcome: InstanceOutcome
}

/** The participant an API key acts for. */
export interface Participant {
  id: string
  did: string
  displayName: string
}

export interface DefinitionSummary {
  ref: string
  title: string
  kind: 'quotation' | 'service'
  contentHash: string
}

export interface CreateInstanceRequest {
  /** `container-transport@1.0.0` — the definition, pinned by version. */
  definition: string
  participants: ParticipantMap
  data?: JsonObject
  /** The quotation that authorises this service execution, if any. */
  quotationId?: string | null
  /** The offering it was started from. Discovery metadata. */
  offering?: string | null
}

export interface TransitionRequest {
  transition: string
  /** JSON Merge Patch against the instance's `data`. `null` deletes a key. */
  patch?: JsonObject | null
  attachments?: AttachmentRef[]
}

/** What a write answers with: the instance as you may now see it, and what it produced. */
export interface WriteResult {
  instance: InstanceView
  events: SignedEvent[]
}

export interface RequestOptions {
  /**
   * A retry after a timeout must not apply the transition twice. Send the same
   * key on the retry and the original result comes back instead.
   */
  idempotencyKey?: string
  signal?: AbortSignal
}

export interface ClientOptions {
  /** Where the **caller's own** connector lives. A client never addresses a peer. */
  baseUrl: string
  /** `ak_….…` — minted in the admin UI, scoped to one participant. */
  apiKey: string
  /**
   * Who, on your side, is doing this. Recorded in the audit log and attached to
   * the resulting event as unsigned local metadata — **never** part of the
   * signed header, because peers do not need your employees' names and a
   * replicated chain cannot be retracted.
   */
  actorRef?: string
  /** Injected for tests and for runtimes with their own fetch. Defaults to global `fetch`. */
  fetch?: typeof globalThis.fetch
}
