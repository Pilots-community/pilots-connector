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
  evaluateCreate,
  evaluateTransition,
  filterEvent,
  filterInstance,
  headerHash,
  homeParticipant,
  protocolError,
  rolesOf,
  signEvent,
  type AttachmentRef,
  type AvailableAction,
  type Instance,
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
}

export interface WriteOutcome {
  instance: StoredInstance
  /** Every event this call produced: the transition, plus any `auto` that followed. */
  events: StoredEvent[]
}

export type ServiceResult<T> =
  { ok: true; value: T } | { ok: false; errors: ProtocolError[]; conflict?: { actualSeq: number } }

/**
 * How a call reaches an instance whose home node is somebody else.
 *
 * A port from the first write, with no implementation until M3. Writing the
 * relay into the service later is exactly how "decide local-vs-remote per
 * definition" gets introduced by accident.
 */
export interface PeerRelay {
  available(): boolean
}

/** The default until M3: there is no transport, and it says so precisely. */
export const NO_RELAY: PeerRelay = { available: () => false }

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
    private readonly relay: PeerRelay = NO_RELAY,
  ) {}

  // ── reads ────────────────────────────────────────────────────────────────

  async read(caller: CallerContext, instanceId: string): Promise<InstanceView | undefined> {
    const stored = await this.store.instances.get(caller.participant.id, instanceId)
    return stored ? this.view(caller, stored) : undefined
  }

  async list(caller: CallerContext): Promise<InstanceView[]> {
    const stored = await this.store.instances.find(caller.participant.id, {
      sort: { field: 'createdAt', direction: 'desc' },
    })
    return stored.map((instance) => this.view(caller, instance))
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

  private view(caller: CallerContext, stored: InstanceDocument): InstanceView {
    const registered = this.definitions.get(stored.definition)
    const roles = rolesOf(stored.participants, caller.participant.did)
    const instance = stripLocalFields(stored)

    if (!registered) {
      return { instance, redacted: false, available: [], home: stored.home }
    }
    const filtered = filterInstance(registered.definition, instance, roles)
    return {
      instance: filtered.instance,
      redacted: filtered.redacted,
      available: availableTransitions(registered.definition, stored, roles),
      home: stored.home,
    }
  }

  // ── writes ───────────────────────────────────────────────────────────────

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

    const home = this.resolveHome(registered, request.participants)
    if (!home.participant) return this.notHomeNode(home.did)

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
    const event = await this.sign(caller, {
      instance: instance.id,
      seq: 1,
      transition: CREATE_TRANSITION,
      from: null,
      to: instance.state,
      prev: null,
      payload: Object.keys(instance.data).length === 0 ? null : instance.data,
      attachments: [],
    })

    const appended = await this.store.appendEvent(
      this.writesFor(registered, instance, event, 0, home.did),
    )
    if (!appended.ok) {
      return {
        ok: false,
        conflict: { actualSeq: appended.conflict.actualSeq },
        errors: [protocolError(Problem.seqConflict, 'that instance id already exists')],
      }
    }

    const stored = await this.requireStored(caller, instance.id)
    const followed = await this.runAutoTransitions(caller, registered, stored, home.did)
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

    const home = this.resolveHome(registered, stored.participants)
    if (!home.participant) return this.notHomeNode(home.did)

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

    const written = await this.write(caller, registered, stored, evaluated.value, home.did)
    if (!written.ok) return written

    const followed = await this.runAutoTransitions(
      caller,
      registered,
      written.value.instance,
      home.did,
    )
    return {
      ok: true,
      value: {
        instance: followed.instance,
        events: [...written.value.events, ...followed.events],
      },
    }
  }

  /**
   * Fire every `auto` transition the new state enables, until none remain.
   *
   * This is the whole of a standing quotation: a definition whose first
   * transition auto-fires, so the instance is born `AGREED`. No separate code
   * path for a fixed price.
   */
  private async runAutoTransitions(
    caller: CallerContext,
    registered: RegisteredDefinition,
    from: StoredInstance,
    homeDid: string,
  ): Promise<{ instance: StoredInstance; events: StoredEvent[] }> {
    let instance = from
    const events: StoredEvent[] = []

    for (let depth = 0; depth < MAX_AUTO_CHAIN; depth += 1) {
      const next = autoTransitions(registered.definition, instance)[0]
      if (!next) break

      const evaluated = evaluateTransition(registered.definition, stripLocalFields(instance), {
        transition: next.id,
        patch: null,
        attachments: [],
        // The runtime fires it, not a participant. `by: []` is the normal case.
        actor: { runtime: true },
        at: this.now(),
      })
      if (!evaluated.ok) break

      const written = await this.write(caller, registered, instance, evaluated.value, homeDid)
      if (!written.ok) break

      instance = written.value.instance
      events.push(...written.value.events)
    }

    return { instance, events }
  }

  private async write(
    caller: CallerContext,
    registered: RegisteredDefinition,
    before: StoredInstance,
    move: {
      from: string
      to: string | null
      transition: { id: string }
      instance: Instance
      payload: JsonObject | null
      attachments: readonly AttachmentRef[]
    },
    homeDid: string,
  ): Promise<ServiceResult<WriteOutcome>> {
    // The chain is the home node's, so `prev` comes from the authoritative copy.
    const previous = await this.store.events.head(
      this.ownerIdFor(homeDid) ?? caller.participant.id,
      before.id,
    )
    const event = await this.sign(caller, {
      instance: before.id,
      seq: before.seq + 1,
      transition: move.transition.id,
      from: move.from,
      to: move.to,
      prev: previous ? headerHash(previous.header) : null,
      payload: move.payload,
      attachments: [...move.attachments],
    })

    const appended = await this.store.appendEvent(
      this.writesFor(registered, move.instance, event, before.seq, homeDid),
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
      value: { instance: await this.requireStored(caller, before.id), events: [event] },
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
    registered: RegisteredDefinition,
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
      seq: number
      transition: string
      from: string | null
      to: string | null
      prev: string | null
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

/** The wire shape: the stored document without this connector's own bookkeeping. */
function stripLocalFields(stored: InstanceDocument | StoredInstance): Instance {
  const { participantId: _participantId, home: _home, ...instance } = stored
  return instance
}
