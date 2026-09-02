/**
 * The event chain — the record.
 *
 * Three separate mechanisms for three separate problems, and they are not
 * alternatives to each other:
 *
 * - `seq` + `If-Match` — two parties acting on one instance at once.
 * - `prev` + `sig` — the host rewriting history.
 * - `Idempotency-Key` — a client retrying after a timeout. (That one is the
 *   store's, not this file's.)
 *
 * Verification here is the whole of S4b. A failure at the `prev` hash or the
 * `from` state means the host has rewritten history: it is a hard error, it is
 * audited as `chain.verify` / `failed`, and it must not be recoverable by
 * silently resyncing. This module therefore stops at the first broken event
 * rather than trying to carry on.
 */
import { EMPTY_PAYLOAD_HASH, canonicalBytes, hashJson, type Sha256 } from '../canonical.js'
import { verifyDetachedJws, protectedHeaderOf, signDetachedJws } from '../crypto/jws.js'
import { isJsonObject, type JsonObject } from '../json.js'
import { applyMergePatch } from '../merge-patch.js'
import { Problem, protocolError, type ProtocolError } from '../problems.js'
import { findVerificationMethod, type DidResolver } from '../ports/did-resolver.js'
import type { Signer } from '../ports/signer.js'
import type { AttachmentRef } from '../schemas/common.js'
import {
  CREATE_TRANSITION,
  expandFromStates,
  findTransition,
  type ProcessDefinition,
} from '../schemas/definition.js'
import { EventHeader, type SignedEvent } from '../schemas/event.js'
import { rolesOf, type InstanceGenesis, type ParticipantMap } from '../schemas/instance.js'
import { filterPayload } from './visibility.js'

export interface EventDraft {
  instance: string
  /** `sha256` of the instance's genesis — see `genesisHash`. */
  genesis: Sha256
  seq: number
  transition: string
  actor: string
  from: string | null
  to: string | null
  at: string
  prev: Sha256 | null
  /** The signed event that justified a runtime-fired transition. See `EventHeader.cause`. */
  cause?: Sha256 | null
  payload?: JsonObject | null
  attachments?: readonly AttachmentRef[]
}

/**
 * Assemble a header. Every field is present; the payload is committed to by hash
 * rather than included, which is what lets the signature cover the header alone.
 */
export function buildEventHeader(draft: EventDraft): EventHeader {
  const payload = draft.payload ?? null
  return EventHeader.parse({
    instance: draft.instance,
    genesis: draft.genesis,
    seq: draft.seq,
    transition: draft.transition,
    actor: draft.actor,
    from: draft.from,
    to: draft.to,
    at: draft.at,
    prev: draft.prev,
    cause: draft.cause ?? null,
    payloadHash: payload === null ? EMPTY_PAYLOAD_HASH : hashJson(payload),
    attachments: [...(draft.attachments ?? [])],
  })
}

/**
 * `sha256` of the canonicalised instance genesis — what every header commits to.
 *
 * A replica computes this from the instance metadata the peer sent it and
 * compares. A mismatch means the metadata does not belong to this log, which is
 * a broken chain and not a recoverable disagreement.
 */
export function genesisHash(genesis: InstanceGenesis): Sha256 {
  return hashJson(genesis)
}

/** `sha256` of the canonicalised header — what the next event's `prev` points at. */
export function headerHash(header: EventHeader): Sha256 {
  return hashJson(header)
}

/** Build and sign one event. The signature covers the canonicalised header only. */
export async function signEvent(
  signer: Signer,
  participantId: string,
  draft: EventDraft,
): Promise<SignedEvent> {
  const header = buildEventHeader(draft)
  const sig = await signDetachedJws(signer, participantId, canonicalBytes(header))
  return { header, payload: draft.payload ?? null, redacted: false, sig }
}

/**
 * The event as one viewer may see it: the header and signature untouched, the
 * payload run through the visibility filter, and `redacted` set when anything
 * was withheld.
 */
export function filterEvent(
  definition: ProcessDefinition,
  event: SignedEvent,
  roles: readonly string[],
  currentState: string,
): SignedEvent {
  const filtered = filterPayload(definition, event.payload, roles, currentState)
  if (!filtered.redacted) return { ...event, payload: filtered.value }
  return { ...event, payload: filtered.value, redacted: true }
}

export interface FoldResult {
  state: string | null
  seq: number
  data: JsonObject
  /** True when at least one payload was withheld, so `data` is incomplete. */
  redacted: boolean
}

/**
 * Rebuild state and data from an ordered log.
 *
 * State folds from headers alone, which is why it stays exact even when every
 * payload has been withheld. Data folds from payloads, so it is best-effort and
 * says so.
 */
export function foldEvents(events: readonly SignedEvent[]): FoldResult {
  let state: string | null = null
  let data: JsonObject = {}
  let redacted = false
  let seq = 0

  for (const event of events) {
    seq = event.header.seq
    if (event.header.to !== null) state = event.header.to
    if (wasWithheld(event)) redacted = true
    // A partially redacted payload still carries the fields this reader may
    // see. Fold them: a replica must not lose data it is entitled to merely
    // because the same event also carried something it is not.
    if (event.payload !== null) {
      const next = applyMergePatch(data, event.payload)
      data = isJsonObject(next) ? next : {}
    }
  }

  return { state, seq, data, redacted }
}

/** True when this copy of the event does not carry the payload the header commits to. */
function wasWithheld(event: SignedEvent): boolean {
  if (event.redacted) return true
  return event.payload === null && event.header.payloadHash !== EMPTY_PAYLOAD_HASH
}

export interface VerifyChainOptions {
  resolver: DidResolver
  /** Supplying it enables the `from`-continuity and role checks. */
  definition?: ProcessDefinition
  /** Supplying it enables the role check. */
  participants?: ParticipantMap
  /** Supplying it asserts every event belongs to this instance. */
  instanceId?: string
  /**
   * Supplying it asserts every event was written against **this** instance
   * identity. This is what turns `definition` and `participants` above from
   * things the caller was told into things the log proves.
   */
  genesis?: InstanceGenesis
}

export interface ChainFailure {
  seq: number
  error: ProtocolError
}

export interface ChainVerification extends FoldResult {
  ok: boolean
  failures: ChainFailure[]
}

/**
 * Verify an ordered log, in the order docs/PROTOCOL.md §7.3 sets out.
 *
 * Returns rather than throws: a broken chain is an expected outcome that the
 * caller has to audit and surface, not an exception to swallow.
 */
export async function verifyChain(
  events: readonly SignedEvent[],
  options: VerifyChainOptions,
): Promise<ChainVerification> {
  const failures: ChainFailure[] = []
  let state: string | null = null
  let data: JsonObject = {}
  let redacted = false
  let seq = 0
  let previousHash: Sha256 | null = null
  // Pinned by the caller when it knows the identity, otherwise adopted from the
  // first event so a log that changes identity halfway is still caught.
  let expectedGenesis: Sha256 | undefined =
    options.genesis === undefined ? undefined : genesisHash(options.genesis)

  for (const [index, event] of events.entries()) {
    const header = event.header
    const expectedSeq = index + 1
    const fail = (error: ProtocolError): void => {
      failures.push({ seq: header.seq, error })
    }

    if (header.seq !== expectedSeq) {
      fail(
        protocolError(
          Problem.chainBroken,
          `expected seq ${expectedSeq}, got ${header.seq}: the log is missing an event or out of order`,
        ),
      )
      break
    }

    if (options.instanceId !== undefined && header.instance !== options.instanceId) {
      fail(
        protocolError(
          Problem.chainBroken,
          `event belongs to instance ${header.instance}, not ${options.instanceId}`,
        ),
      )
      break
    }

    if (expectedGenesis !== undefined && header.genesis !== expectedGenesis) {
      fail(
        protocolError(
          Problem.chainBroken,
          index === 0 && options.genesis !== undefined
            ? 'the instance metadata does not match the genesis this log commits to'
            : `genesis changed at seq ${header.seq}: these events are not one instance`,
        ),
      )
      break
    }
    expectedGenesis ??= header.genesis

    if (header.prev !== previousHash) {
      fail(
        protocolError(
          Problem.chainBroken,
          previousHash === null
            ? 'the first event must have prev: null'
            : `prev does not match the hash of the header at seq ${expectedSeq - 1}: history has been rewritten`,
        ),
      )
      break
    }

    if (header.from !== state) {
      fail(
        protocolError(
          Problem.chainBroken,
          `from is ${String(header.from)} but the state after seq ${expectedSeq - 1} is ${String(state)}`,
        ),
      )
      break
    }

    const signatureError = await verifySignature(event, options.resolver)
    if (signatureError) {
      fail(signatureError)
      break
    }

    const authorityError = checkAuthority(event, options)
    if (authorityError) {
      fail(authorityError)
      break
    }

    const withheld = wasWithheld(event)
    if (withheld) redacted = true
    if (event.payload !== null) {
      // The hash commits to the *whole* payload, so it can only be checked on a
      // copy that carries the whole payload. Redaction is not tampering.
      if (!withheld && hashJson(event.payload) !== header.payloadHash) {
        fail(
          protocolError(
            Problem.payloadHashMismatch,
            'the payload does not hash to the payloadHash its header commits to',
          ),
        )
        break
      }
      const next = applyMergePatch(data, event.payload)
      data = isJsonObject(next) ? next : {}
    }

    if (header.to !== null) state = header.to
    previousHash = headerHash(header)
    seq = header.seq
  }

  return { ok: failures.length === 0, failures, state, seq, data, redacted }
}

async function verifySignature(
  event: SignedEvent,
  resolver: DidResolver,
): Promise<ProtocolError | undefined> {
  let kid: string
  try {
    kid = protectedHeaderOf(event.sig).kid
  } catch (error) {
    return protocolError(
      Problem.signatureInvalid,
      `unreadable signature: ${(error as Error).message}`,
    )
  }

  const document = await resolver.resolve(event.header.actor)
  if (!document) {
    return protocolError(
      Problem.signatureInvalid,
      `${event.header.actor} did not resolve to a DID document`,
    )
  }

  const method = findVerificationMethod(document, kid)
  if (!method) {
    return protocolError(
      Problem.signatureInvalid,
      `the DID document for ${event.header.actor} has no verification method ${kid}`,
    )
  }

  // The `kid` must belong to the actor: a valid signature by the wrong
  // participant is not a valid event.
  if (!kid.startsWith(`${event.header.actor}#`)) {
    return protocolError(
      Problem.signatureInvalid,
      `signature key ${kid} does not belong to ${event.header.actor}`,
    )
  }

  let verified: boolean
  try {
    verified = await verifyDetachedJws(event.sig, canonicalBytes(event.header), method.publicKeyJwk)
  } catch (error) {
    return protocolError(Problem.signatureInvalid, (error as Error).message)
  }
  return verified
    ? undefined
    : protocolError(
        Problem.signatureInvalid,
        'the signature does not verify against the actor’s published key: the header has been altered',
      )
}

/**
 * Did the signer hold a role the definition permits for this transition?
 *
 * A genuine signature is not authority. The host cannot invent a move by someone
 * else — it does not hold their key — but a *participant* forging a move outside
 * its own role is exactly what this check catches.
 */
function checkAuthority(
  event: SignedEvent,
  options: VerifyChainOptions,
): ProtocolError | undefined {
  const { definition, participants } = options
  if (!definition || !participants) return undefined

  const roles = rolesOf(participants, event.header.actor)
  if (roles.length === 0) {
    return protocolError(
      Problem.notAParticipant,
      `${event.header.actor} holds no role in this instance`,
    )
  }

  if (event.header.transition === CREATE_TRANSITION) {
    if (definition.createdBy && !roles.some((role) => definition.createdBy?.includes(role))) {
      return protocolError(
        Problem.roleNotPermitted,
        `only ${definition.createdBy.join(', ')} may create an instance of ${definition.id}`,
      )
    }
    return event.header.to === definition.initialState
      ? undefined
      : protocolError(
          Problem.chainBroken,
          `the creating event must enter ${definition.initialState}, not ${String(event.header.to)}`,
        )
  }

  const transition = findTransition(definition, event.header.transition)
  if (!transition) {
    return protocolError(
      Problem.unknownTransition,
      `definition ${definition.id} has no transition ${event.header.transition}`,
    )
  }

  if (transition.by.length > 0 && !transition.by.some((role) => roles.includes(role))) {
    return protocolError(
      Problem.roleNotPermitted,
      `${event.header.actor} holds ${roles.join(', ')}, but ${transition.id} is for ${transition.by.join(', ')}`,
    )
  }

  if (
    event.header.from !== null &&
    !expandFromStates(definition, transition).includes(event.header.from)
  ) {
    return protocolError(
      Problem.chainBroken,
      `${transition.id} may not be applied in state ${event.header.from}`,
    )
  }

  return undefined
}
