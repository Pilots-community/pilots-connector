/**
 * The one mutating path.
 *
 * Creating an instance and advancing one are the same code path with a different
 * `expectedSeq`, because creation *is* event `seq` 1. "Update a field" and
 * "advance the state" are the same thing too — a transition with a patch and no
 * `to`. One endpoint, one audit trail, one permission check.
 *
 * **Home-node resolution happens per instance, at write time**: the definition
 * names a *role*, and only this instance's `participants` map names the
 * participant filling it. Nothing here caches "we host definition X" — that
 * would break role symmetry silently, and a one-directional demo would still
 * pass. The same connector is authoritative for one instance of a definition and
 * a replica of another, at the same time.
 */
import {
  CREATE_TRANSITION,
  Problem,
  autoTransitions,
  availableTransitions,
  outcomeOf,
  evaluateCreate,
  evaluateTransition,
  filterEvent,
  filterInstance,
  genesisHash,
  verifyChain,
  headerHash,
  homeParticipant,
  instanceGenesis,
  protocolError,
  rolesOf,
  signEvent,
  type AttachmentRef,
  type AvailableAction,
  type DidResolver,
  type Instance,
  type InstanceIdentity,
  type InstanceOutcome,
  type JsonObject,
  type ParticipantMap,
  type ProtocolError,
  type Signer,
  type SignedEvent,
  type StoredEvent,
  type StoredInstance,
} from '@pilots/protocol'

import type { ParticipantConfig } from '../config/config.js'
import type {
  DefinitionRegistry,
  RegisteredDefinition,
} from '../definitions/definition-registry.js'
import type { InstanceDocument, Store } from '../store/store.js'
import type { EventWrite } from '../store/types.js'

/** Who is asking, resolved by whichever guard let them in. */
export interface CallerContext {
  /** The local participant this call acts for. */
  participant: ParticipantConfig
  /** Asserted, unproven. An audit hint, never an identity claim. */
  actorRef: string | null
}

export interface CreateInstanceRequest {
  definition: string
  participants: ParticipantMap
  data?: JsonObject
  quotationId?: string | null
  offering?: string | null
}

export interface ApplyTransitionRequest {
  transition: string
  patch?: JsonObject | null
  attachments?: AttachmentRef[]
}

export interface InstanceView {
  instance: Instance
  /** True when the visibility filter withheld something from this reader. */
  redacted: boolean
  /** What this participant may fire right now — the UI's buttons, computed once. */
  available: AvailableAction[]
  /** Whether this connector's copy is the authoritative one. */
  home: boolean
  /**
   * Whether this process is over, and how — `running`, `fulfilled`, `abandoned`.
   *
   * The generic companion to `state`. `state` speaks the definition's own
   * vocabulary and means nothing without it; this is the half every caller can
   * act on, so nobody has to hardcode that `VGM_ISSUED` is the good ending.
   */
  outcome: InstanceOutcome
}

export interface WriteOutcome {
  instance: StoredInstance
  /** Every event this call produced: the transition, plus any `auto` that followed. */
  events: StoredEvent[]
}

export type ServiceResult<T> =
  | { ok: true; value: T }
  | {
      ok: false
      errors: ProtocolError[]
      conflict?: { actualSeq: number }
      /**
       * A status the caller must not recompute.
       *
       * Set only by the relay, so a home node's `409` stays a `409` on its way
       * through us. Deriving it from the problem type again would quietly turn
       * a peer's answer into our opinion of it.
       */
      status?: number
    }

/**
 * How a call reaches an instance whose home node is somebody else.
 *
 * One method, because there is one thing to do: hand the home node an event we
 * have already signed, and adopt whatever it accepted. Anything richer would be
 * a second write path, and a second write path is how "decide local-vs-remote
 * per definition" gets introduced by accident.
 *
 * **We sign before we relay.** The signature must come from the participant that
 * acted — docs/PROTOCOL.md §7.1 and §7.3 both say the verifying key is the
 * *actor's* — so the home node cannot produce it on our behalf. It can do
 * everything else: assign nothing (we already know `seq` and `prev` from our own
 * verified replica, which is what `If-Match` is for), but check every rule and
 * refuse us.
 */
export interface PeerRelay {
  available(): boolean
  forward(input: RelayRequest): Promise<ServiceResult<WriteOutcome>>
}

export interface RelayRequest {
  caller: CallerContext
  /** The participant that hosts this instance. Resolved per instance, never per definition. */
  homeDid: string
  identity: InstanceIdentity
  event: StoredEvent
  /** True when this event creates the instance, so the home node has nothing yet. */
  creating: boolean
}

/** The default before any transport is configured: there is nowhere to forward to. */
export const NO_RELAY: PeerRelay = {
  available: () => false,
  forward: async ({ homeDid }) =>
    fail(
      Problem.peerUnreachable,
      `${homeDid} hosts this instance and no peer transport is configured`,
    ),
}

/**
 * Something that reacts to a committed write: peer delivery, local
 * notifications, and anything later that needs to know a process moved.
 */
export interface WriteObserver {
  onWrite(notice: {
    definition: RegisteredDefinition
    before: StoredInstance | null
    after: StoredInstance
    events: readonly StoredEvent[]
  }): Promise<void>
}

/** A `links`-driven or deadline-driven chain must terminate. */
const MAX_AUTO_CHAIN = 16

export class InstanceService {
  constructor(
    private readonly store: Store,
    private readonly definitions: DefinitionRegistry,
    private readonly signer: Signer,
    private readonly now: () => string,
    private readonly nextId: () => string,
    private readonly localParticipants: () => readonly ParticipantConfig[],
    private readonly resolver: DidResolver,
    private readonly relay: PeerRelay = NO_RELAY,
    /**
     * Told about every committed write, so peer delivery and local
     * notifications fan out from **one** place. A second call site would be a
     * second chance to forget one.
     */
    private readonly observers: readonly WriteObserver[] = [],
  ) {}

  /** Fan a committed write out to everything that reacts to writes. */
  private async announce(
    definition: RegisteredDefinition,
    before: StoredInstance | null,
    after: StoredInstance,
    events: readonly StoredEvent[],
  ): Promise<void> {
    if (events.length === 0) return
    for (const observer of this.observers) {
      await observer.onWrite({ definition, before, after, events })
    }
  }

  // ── reads ────────────────────────────────────────────────────────────────

  async read(caller: CallerContext, instanceId: string): Promise<InstanceView | undefined> {
    const stored = await this.store.instances.get(caller.participant.id, instanceId)
    return stored ? this.viewAs(caller.participant.did, stored) : undefined
  }

  /**
   * The same read, filtered for a **peer** rather than for ourselves.
   *
   * The peer surface answers from here rather than from the home node's own
   * copy, so a peer can never see through our eyes. One filter, one code path,
   * whichever side of the connector is asking.
   */
  async readForPeer(
    holder: ParticipantConfig,
    viewerDid: string,
    instanceId: string,
  ): Promise<InstanceView | undefined> {
    const stored = await this.store.instances.get(holder.id, instanceId)
    if (!stored || rolesOf(stored.participants, viewerDid).length === 0) return undefined
    return this.viewAs(viewerDid, stored)
  }

  async list(caller: CallerContext): Promise<InstanceView[]> {
    const stored = await this.store.instances.find(caller.participant.id, {
      sort: { field: 'createdAt', direction: 'desc' },
    })
    return stored.map((instance) => this.viewAs(caller.participant.did, instance))
  }

  /** The event log as this participant may see it, visibility-filtered. */
  async events(
    caller: CallerContext,
    instanceId: string,
    sinceSeq = 0,
  ): Promise<SignedEvent[] | undefined> {
    const stored = await this.store.instances.get(caller.participant.id, instanceId)
    if (!stored) return undefined

    const registered = this.definitions.get(stored.definition)
    const roles = rolesOf(stored.participants, caller.participant.did)
    const events = await this.store.events.read(caller.participant.id, instanceId, sinceSeq)

    return events.map((record) => {
      const event: SignedEvent = {
        header: record.header,
        payload: record.payload,
        redacted: record.redacted,
        sig: record.sig,
      }
      // Filtered against the instance's *current* state, so the same stored
      // event reads differently before and after payment. Nothing is re-sent and
      // nothing is re-signed.
      return registered ? filterEvent(registered.definition, event, roles, stored.state) : event
    })
  }

  private viewAs(viewerDid: string, stored: InstanceDocument): InstanceView {
    const registered = this.definitions.get(stored.definition)
    const roles = rolesOf(stored.participants, viewerDid)
    const instance = stripLocalFields(stored)

    if (!registered) {
      // No definition held, so nothing can be said about how it would end.
      return { instance, redacted: false, available: [], home: stored.home, outcome: 'running' }
    }
    const filtered = filterInstance(registered.definition, instance, roles)
    return {
      instance: filtered.instance,
      redacted: filtered.redacted,
      available: availableTransitions(registered.definition, stored, roles),
      home: stored.home,
      outcome: outcomeOf(registered.definition, stored.state),
    }
  }

  // ── writes ───────────────────────────────────────────────────────────────

  /**
   * Start an instance.
   *
   * Note the order: evaluate, **sign**, and only then ask whether we are the
   * home node. The event is identical either way — the same header, the same
   * signature, the same everything — and the only difference is whether it is
   * appended here or forwarded. That is what makes "hostedBy is an
   * implementation detail of the connector" true rather than aspirational.
   */
  async create(
    caller: CallerContext,
    request: CreateInstanceRequest,
  ): Promise<ServiceResult<WriteOutcome>> {
    const registered = this.definitions.get(request.definition)
    if (!registered) {
      return fail(
        Problem.definitionInvalid,
        `unknown definition ${request.definition}`,
        '/definition',
      )
    }

    const evaluated = evaluateCreate(registered.definition, {
      id: this.nextId(),
      participants: request.participants,
      data: request.data ?? {},
      quotationId: request.quotationId ?? null,
      offering: request.offering ?? null,
      actorDid: caller.participant.did,
      at: this.now(),
    })
    if (!evaluated.ok) return { ok: false, errors: evaluated.error }

    const instance = evaluated.value
    const home = this.resolveHome(registered, request.participants)
    if (home.did === '') {
      return fail(
        Problem.definitionInvalid,
        `no participant fills ${registered.definition.hostedBy}, so this instance has no home node`,
        '/participants',
      )
    }

    const event = await this.sign(caller, {
      instance: instance.id,
      genesis: genesisHash(instanceGenesis(instance)),
      seq: 1,
      transition: CREATE_TRANSITION,
      from: null,
      to: instance.state,
      prev: null,
      payload: Object.keys(instance.data).length === 0 ? null : instance.data,
      attachments: [],
    })

    if (!home.participant) {
      return this.relay.forward({
        caller,
        homeDid: home.did,
        identity: identityOf(instance),
        event,
        creating: true,
      })
    }

    const appended = await this.store.appendEvent(this.writesFor(instance, event, 0, home.did))
    if (!appended.ok) {
      return {
        ok: false,
        conflict: { actualSeq: appended.conflict.actualSeq },
        errors: [protocolError(Problem.seqConflict, 'that instance id already exists')],
      }
    }

    const stored = await this.requireStored(caller, instance.id)
    const followed = await this.runAutoTransitions(home.participant, registered, stored, home.did)
    await this.announce(registered, null, followed.instance, [event, ...followed.events])
    return { ok: true, value: { instance: followed.instance, events: [event, ...followed.events] } }
  }

  async applyTransition(
    caller: CallerContext,
    instanceId: string,
    request: ApplyTransitionRequest,
    ifMatch: number,
  ): Promise<ServiceResult<WriteOutcome>> {
    const stored = await this.store.instances.get(caller.participant.id, instanceId)
    // 404 and "you may not see it" are deliberately the same answer.
    if (!stored) return fail(Problem.notAParticipant, `no instance ${instanceId}`)

    const registered = this.definitions.get(stored.definition)
    if (!registered) {
      return fail(
        Problem.definitionInvalid,
        `instance ${instanceId} pins ${stored.definition}, which this connector does not hold`,
      )
    }

    if (stored.seq !== ifMatch) {
      return {
        ok: false,
        conflict: { actualSeq: stored.seq },
        errors: [
          protocolError(
            Problem.seqConflict,
            `If-Match is ${ifMatch} but the instance is at ${stored.seq}`,
          ),
        ],
      }
    }

    const roles = rolesOf(stored.participants, caller.participant.did)
    if (roles.length === 0) {
      return fail(
        Problem.notAParticipant,
        `${caller.participant.did} holds no role in this instance`,
      )
    }

    const evaluated = evaluateTransition(registered.definition, stripLocalFields(stored), {
      transition: request.transition,
      patch: request.patch ?? null,
      attachments: request.attachments ?? [],
      actor: { roles },
      at: this.now(),
    })
    if (!evaluated.ok) return { ok: false, errors: evaluated.error }

    const home = this.resolveHome(registered, stored.participants)
    const move = evaluated.value

    /*
     * `seq` and `prev` come from our own verified replica, not from the home
     * node.
     *
     * That is exactly what `If-Match` is for, and it is why it is mandatory: a
     * caller that knows the instance is at seq 3 knows the next event is seq 4
     * and what its `prev` must be, so it can build and sign the complete header
     * itself. If it guessed wrong, the home node answers 409 with the real seq.
     */
    const previous = await this.store.events.head(
      this.ownerIdFor(home.did) ?? caller.participant.id,
      stored.id,
    )
    const event = await this.sign(caller, {
      instance: stored.id,
      genesis: genesisHash(instanceGenesis(stored)),
      seq: stored.seq + 1,
      transition: move.transition.id,
      from: move.from,
      to: move.to,
      prev: previous ? headerHash(previous.header) : null,
      payload: move.payload,
      attachments: [...move.attachments],
    })

    if (!home.participant) {
      return this.relay.forward({
        caller,
        homeDid: home.did,
        identity: identityOf(stored),
        event,
        creating: false,
      })
    }

    const written = await this.commit(caller, move.instance, event, stored.seq, home.did)
    if (!written.ok) return written

    const followed = await this.runAutoTransitions(
      home.participant,
      registered,
      written.value.instance,
      home.did,
    )
    const events = [...written.value.events, ...followed.events]
    await this.announce(registered, stored, followed.instance, events)
    return { ok: true, value: { instance: followed.instance, events } }
  }

  /**
   * The home node accepting an event a **peer** signed and sent us.
   *
   * Every rule is enforced here that would be enforced locally — that is the
   * point of the home node existing. What it cannot do is produce the
   * signature: it belongs to the participant that acted, so the peer built and
   * signed the whole header before sending it, and all we do is refuse or
   * append.
   */
  async applySigned(input: {
    home: ParticipantConfig
    actorDid: string
    identity: InstanceIdentity
    event: SignedEvent
    creating: boolean
  }): Promise<ServiceResult<WriteOutcome>> {
    const { identity, event } = input
    const registered = this.definitions.get(identity.definition)
    if (!registered) {
      return fail(Problem.definitionInvalid, `this connector does not hold ${identity.definition}`)
    }

    if (homeParticipant(registered.definition, identity.participants) !== input.home.did) {
      return fail(
        Problem.notAParticipant,
        `${input.home.did} does not host this instance and will not write to it`,
      )
    }
    if (event.header.actor !== input.actorDid) {
      // A peer may act for itself. Forwarding somebody else's signed event is a
      // different feature with a different threat model; it is not this one.
      return fail(
        Problem.credentialInvalid,
        `this call was authenticated as ${input.actorDid} but the event was signed by ${event.header.actor}`,
      )
    }
    if (event.header.genesis !== genesisHash(instanceGenesis(identity))) {
      return fail(Problem.chainBroken, 'the event does not belong to the instance described')
    }
    if (event.header.instance !== identity.id) {
      return fail(Problem.chainBroken, 'the event names a different instance')
    }

    const stored = input.creating
      ? undefined
      : await this.store.instances.get(input.home.id, identity.id)
    if (!input.creating && !stored) {
      return fail(Problem.notAParticipant, `no instance ${identity.id}`)
    }
    if (input.creating && (await this.store.instances.get(input.home.id, identity.id))) {
      return fail(Problem.seqConflict, `instance ${identity.id} already exists`)
    }

    const existing = input.creating
      ? []
      : (await this.store.events.read(input.home.id, identity.id, 0)).map(toSigned)

    if (event.header.seq !== existing.length + 1) {
      return {
        ok: false,
        conflict: { actualSeq: existing.length },
        errors: [
          protocolError(
            Problem.seqConflict,
            `the event is seq ${event.header.seq} but the instance is at ${existing.length}`,
          ),
        ],
      }
    }

    /*
     * Signature, `prev`, `from` and the actor's authority, all through the same
     * verifier a replica uses. Deliberately not a second, home-node-flavoured
     * copy of those checks: the moment there are two, they disagree, and the one
     * that matters is whichever is weaker.
     */
    const verified = await verifyChain([...existing, event], {
      resolver: this.resolver,
      definition: registered.definition,
      participants: identity.participants,
      instanceId: identity.id,
      genesis: instanceGenesis(identity),
    })
    if (!verified.ok) {
      const failure = verified.failures[0]
      return {
        ok: false,
        errors: [failure?.error ?? protocolError(Problem.chainBroken, 'the event did not verify')],
      }
    }

    // What the signature cannot cover: the definition's own JSON Schemas and its
    // guards, which are evaluated against data the peer may only partly see.
    const roles = rolesOf(identity.participants, event.header.actor)
    if (input.creating) {
      const evaluated = evaluateCreate(registered.definition, {
        id: identity.id,
        participants: identity.participants,
        data: event.payload ?? {},
        quotationId: identity.quotationId,
        offering: identity.offering,
        actorDid: event.header.actor,
        at: event.header.at,
      })
      if (!evaluated.ok) return { ok: false, errors: evaluated.error }

      const instance = evaluated.value
      const appended = await this.store.appendEvent(
        this.writesFor(
          instance,
          { ...event, participantId: input.home.id, actorRef: null, recordedAt: this.now() },
          0,
          input.home.did,
        ),
      )
      if (!appended.ok) {
        return {
          ok: false,
          conflict: { actualSeq: appended.conflict.actualSeq },
          errors: [protocolError(Problem.seqConflict, 'that instance id already exists')],
        }
      }

      const created = await this.store.instances.get(input.home.id, identity.id)
      if (!created) throw new Error(`instance ${identity.id} vanished mid-write`)
      const followed = await this.runAutoTransitions(
        input.home,
        registered,
        created,
        input.home.did,
      )
      const events = [
        { ...event, participantId: input.home.id, actorRef: null, recordedAt: this.now() },
        ...followed.events,
      ]
      await this.announce(registered, null, followed.instance, events)
      return { ok: true, value: { instance: followed.instance, events } }
    }

    const evaluated = evaluateTransition(registered.definition, stripLocalFields(stored!), {
      transition: event.header.transition,
      patch: event.payload,
      attachments: [...event.header.attachments],
      actor: { roles },
      at: event.header.at,
    })
    if (!evaluated.ok) return { ok: false, errors: evaluated.error }

    const caller: CallerContext = { participant: input.home, actorRef: null }
    const written = await this.commit(
      caller,
      evaluated.value.instance,
      { ...event, participantId: input.home.id, actorRef: null, recordedAt: this.now() },
      stored!.seq,
      input.home.did,
    )
    if (!written.ok) return written

    const followed = await this.runAutoTransitions(
      input.home,
      registered,
      written.value.instance,
      input.home.did,
    )
    const events = [...written.value.events, ...followed.events]
    await this.announce(registered, stored!, followed.instance, events)
    return { ok: true, value: { instance: followed.instance, events } }
  }

  private async runAutoTransitions(
    home: ParticipantConfig,
    registered: RegisteredDefinition,
    from: StoredInstance,
    homeDid: string,
  ): Promise<{ instance: StoredInstance; events: StoredEvent[] }> {
    let instance = from
    const events: StoredEvent[] = []

    for (let depth = 0; depth < MAX_AUTO_CHAIN; depth += 1) {
      const next = autoTransitions(registered.definition, instance)[0]
      if (!next) break

      const written = await this.runtimeFire(home, registered, instance, homeDid, next.id, null)
      if (!written) break

      instance = written.instance
      events.push(...written.events)
    }

    return { instance, events }
  }

  /**
   * Fire a transition **the runtime owns** — `auto`, a `link`, or a `deadline`.
   *
   * The three differ only in what triggered them, so they share one path. The
   * home node is the actor and the signer, because the runtime that fired it
   * *is* the home node; a `by: []` transition is precisely one no participant
   * may invoke by hand.
   *
   * `cause` is the signed event that justified it, and it goes in the header
   * rather than only in our audit log. Without it a runtime transition is
   * something a host asserts; with it, a counterparty can find the causing event
   * in the instance it belongs to and check the claim.
   */
  private async runtimeFire(
    home: ParticipantConfig,
    registered: RegisteredDefinition,
    instance: StoredInstance,
    homeDid: string,
    transition: string,
    cause: string | null,
  ): Promise<{ instance: StoredInstance; events: StoredEvent[] } | undefined> {
    const evaluated = evaluateTransition(registered.definition, stripLocalFields(instance), {
      transition,
      patch: null,
      attachments: [],
      actor: { runtime: true },
      at: this.now(),
    })
    if (!evaluated.ok) return undefined

    const event = await this.sign(
      { participant: home, actorRef: null },
      {
        instance: instance.id,
        genesis: genesisHash(instanceGenesis(instance)),
        seq: instance.seq + 1,
        transition,
        from: evaluated.value.from,
        to: evaluated.value.to,
        prev: await this.previousHash(homeDid, home, instance.id),
        cause,
        payload: evaluated.value.payload,
        attachments: [...evaluated.value.attachments],
      },
    )
    const written = await this.commit(
      { participant: home, actorRef: null },
      evaluated.value.instance,
      event,
      instance.seq,
      homeDid,
    )
    if (!written.ok) return undefined
    return { instance: written.value.instance, events: written.value.events }
  }

  /**
   * Fire a runtime-owned transition from outside — the link evaluator and the
   * deadline scanner both arrive here.
   *
   * Refuses unless we are the home node for *this instance*, resolved the same
   * way every other write resolves it. A replica firing its own runtime
   * transitions would fork the chain, and the fork would be signed.
   */
  async fireRuntime(input: {
    instanceId: string
    transition: string
    cause?: string | null
    /** Which local participant's copy to read. Defaults to the home one. */
    participantId?: string
  }): Promise<ServiceResult<WriteOutcome>> {
    for (const local of this.localParticipants()) {
      if (input.participantId !== undefined && local.id !== input.participantId) continue

      const stored = await this.store.instances.get(local.id, input.instanceId)
      if (!stored || !stored.home) continue

      const registered = this.definitions.get(stored.definition)
      if (!registered) {
        return fail(Problem.definitionInvalid, `this connector does not hold ${stored.definition}`)
      }
      const homeDid = homeParticipant(registered.definition, stored.participants) ?? ''
      if (homeDid !== local.did) continue

      const written = await this.runtimeFire(
        local,
        registered,
        stored,
        homeDid,
        input.transition,
        input.cause ?? null,
      )
      if (!written) {
        return fail(
          Problem.illegalState,
          `${input.transition} is not available on ${input.instanceId} right now`,
        )
      }

      const followed = await this.runAutoTransitions(local, registered, written.instance, homeDid)
      const events = [...written.events, ...followed.events]
      await this.announce(registered, stored, followed.instance, events)
      return { ok: true, value: { instance: followed.instance, events } }
    }

    return fail(
      Problem.notAParticipant,
      `this connector is not the home node for ${input.instanceId}`,
    )
  }

  /** The hash the next event's `prev` must carry, taken from the authoritative log. */
  private async previousHash(
    homeDid: string,
    caller: ParticipantConfig,
    instanceId: string,
  ): Promise<string | null> {
    const previous = await this.store.events.head(this.ownerIdFor(homeDid) ?? caller.id, instanceId)
    return previous ? headerHash(previous.header) : null
  }

  /** Append one already-signed event, atomically across every local copy. */
  private async commit(
    caller: CallerContext,
    instance: Instance,
    event: StoredEvent,
    expectedSeq: number,
    homeDid: string,
  ): Promise<ServiceResult<WriteOutcome>> {
    const appended = await this.store.appendEvent(
      this.writesFor(instance, event, expectedSeq, homeDid),
    )
    if (!appended.ok) {
      return {
        ok: false,
        conflict: { actualSeq: appended.conflict.actualSeq },
        errors: [
          protocolError(
            Problem.seqConflict,
            `the instance advanced to ${appended.conflict.actualSeq} while this call was in flight`,
          ),
        ],
      }
    }

    return {
      ok: true,
      value: { instance: await this.requireStored(caller, instance.id), events: [event] },
    }
  }

  /**
   * One write per **local** participant taking part in the instance.
   *
   * Exactly one of them carries `home: true`. With one participant configured
   * this is a batch of one; with a hosted tenant sitting beside its counterparty
   * it is two, and the replica is a real replica rather than a shared row.
   */
  private writesFor(
    instance: Instance,
    event: StoredEvent,
    expectedSeq: number,
    homeDid: string,
  ): EventWrite[] {
    return this.participantsIn(instance.participants).map((participant) => ({
      participantId: participant.id,
      expectedSeq,
      event: { ...event, participantId: participant.id },
      instanceAfter: {
        ...instance,
        participantId: participant.id,
        home: participant.did === homeDid,
      },
    }))
  }

  private async sign(
    caller: CallerContext,
    draft: {
      instance: string
      genesis: string
      seq: number
      transition: string
      from: string | null
      to: string | null
      prev: string | null
      cause?: string | null
      payload: JsonObject | null
      attachments: AttachmentRef[]
    },
  ): Promise<StoredEvent> {
    const at = this.now()
    const signed = await signEvent(this.signer, caller.participant.id, {
      ...draft,
      actor: caller.participant.did,
      at,
    })
    return {
      ...signed,
      participantId: caller.participant.id,
      // Local metadata: never in the signed header, never sent to a peer. A
      // replicated chain cannot be retracted, and peers do not need our
      // employees' names.
      actorRef: caller.actorRef,
      recordedAt: at,
    }
  }

  private async requireStored(caller: CallerContext, instanceId: string): Promise<StoredInstance> {
    const stored = await this.store.instances.get(caller.participant.id, instanceId)
    if (!stored) throw new Error(`instance ${instanceId} vanished mid-write`)
    return stored
  }

  // ── home-node resolution, per instance ───────────────────────────────────

  private resolveHome(
    registered: RegisteredDefinition,
    participants: ParticipantMap,
  ): { did: string; participant: ParticipantConfig | undefined } {
    const did = homeParticipant(registered.definition, participants) ?? ''
    return { did, participant: this.localParticipants().find((p) => p.did === did) }
  }

  private ownerIdFor(did: string): string | undefined {
    return this.localParticipants().find((p) => p.did === did)?.id
  }

  /** Every configured participant of ours that holds a role in this instance. */
  private participantsIn(participants: ParticipantMap): ParticipantConfig[] {
    return this.localParticipants().filter((p) => rolesOf(participants, p.did).length > 0)
  }

  private notHomeNode(host: string): ServiceResult<never> {
    return fail(
      Problem.peerUnreachable,
      this.relay.available()
        ? `the home node ${host} did not answer`
        : `this instance is hosted by ${host || 'a role no participant fills'}, and no peer transport is configured`,
    )
  }
}

function fail(type: ProtocolError['type'], detail: string, pointer?: string): ServiceResult<never> {
  return { ok: false, errors: [protocolError(type, detail, pointer)] }
}

/** An instance's fixed identity, as it travels to a peer alongside its events. */
export function identityOf(instance: Instance): InstanceIdentity {
  return {
    id: instance.id,
    kind: instance.kind,
    definition: instance.definition,
    participants: instance.participants,
    quotationId: instance.quotationId,
    offering: instance.offering,
    createdAt: instance.createdAt,
  }
}

function toSigned(event: StoredEvent): SignedEvent {
  return { header: event.header, payload: event.payload, redacted: event.redacted, sig: event.sig }
}

/** The wire shape: the stored document without this connector's own bookkeeping. */
function stripLocalFields(stored: InstanceDocument | StoredInstance): Instance {
  const { participantId: _participantId, home: _home, ...instance } = stored
  return instance
}
