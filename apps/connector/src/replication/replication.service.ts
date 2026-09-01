/**
 * Applying a peer's events to our own replica.
 *
 * This is where "the host cannot lie" is either enforced or it is not. Every
 * event is verified before anything is stored: the signature against the
 * actor's published key, `prev` against the header we already hold, `from`
 * against the state we computed, the actor's authority against the definition,
 * and — the one that only matters once metadata crosses a wire — `genesis`
 * against the instance identity the sender handed us.
 *
 * **A verification failure is a hard error.** Not a retry, not a resync, not a
 * "fetch a fresh copy and carry on". A broken chain means the peer rewrote
 * history, and silently recovering from that would delete the only evidence.
 * It is audited as `chain.verify` / `failed`, surfaced, and the events are
 * dropped on the floor.
 */
import {
  DeliveryBatch,
  type EventDelivery,
  Problem,
  foldEvents,
  genesisHash,
  hashJson,
  headerHash,
  homeParticipant,
  instanceGenesis,
  participantDids,
  protocolError,
  rolesOf,
  verifyChain,
  type DidResolver,
  type InstanceIdentity,
  type ProcessDefinition,
  type ProtocolError,
  type SignedEvent,
  type StoredEvent,
  type StoredInstance,
} from '@pilots/protocol'

import type { ParticipantConfig } from '../config/config.js'
import type { DefinitionRegistry } from '../definitions/definition-registry.js'
import type { LogService } from '../logging/log.service.js'
import type { WriteNotice } from '../notifications/notification.service.js'
import type { Store } from '../store/store.js'
import type { EventWrite } from '../store/types.js'

export type ReplicationResult<T> = { ok: true; value: T } | { ok: false; errors: ProtocolError[] }

export interface ApplyOutcome {
  instanceId: string
  /** How many events were new. Zero is a normal, successful outcome: a duplicate. */
  applied: number
  /** The seq we now hold, so a caller can tell a peer where to resume from. */
  seq: number
  /** Set when the delivery skipped ahead and a `?since=` pull is needed. */
  gapFrom?: number
  /** Events we already held whose withheld payload has now been released to us. */
  completed?: number
}

export class ReplicationService {
  constructor(
    private readonly store: Store,
    private readonly definitions: DefinitionRegistry,
    private readonly resolver: DidResolver,
    private readonly log: LogService,
    private readonly now: () => string,
    private readonly localParticipants: () => readonly ParticipantConfig[],
    private readonly onWrite: (notice: WriteNotice) => Promise<void>,
  ) {}

  /** Apply a whole batch, one instance at a time. */
  async applyBatch(
    participant: ParticipantConfig,
    peerDid: string,
    body: unknown,
  ): Promise<ReplicationResult<ApplyOutcome[]>> {
    const parsed = DeliveryBatch.safeParse(body)
    if (!parsed.success) {
      return {
        ok: false,
        errors: parsed.error.issues.map((issue) =>
          protocolError(Problem.schemaInvalid, issue.message, `/${issue.path.join('/')}`),
        ),
      }
    }

    const outcomes: ApplyOutcome[] = []
    for (const delivery of parsed.data.deliveries) {
      const applied = await this.apply(participant, peerDid, delivery)
      if (!applied.ok) return applied
      outcomes.push(applied.value)
    }
    return { ok: true, value: outcomes }
  }

  async apply(
    participant: ParticipantConfig,
    peerDid: string,
    delivery: EventDelivery,
  ): Promise<ReplicationResult<ApplyOutcome>> {
    const identity = delivery.instance
    const dids = participantDids(identity.participants)

    // Two checks that come before any cryptography, because they are about
    // whether this instance is any of our business at all.
    if (!dids.includes(participant.did)) {
      return this.refuse(
        participant,
        identity.id,
        Problem.notAParticipant,
        `${participant.did} holds no role in this instance`,
      )
    }
    if (!dids.includes(peerDid)) {
      return this.refuse(
        participant,
        identity.id,
        Problem.notAParticipant,
        `${peerDid} is not a participant in this instance and may not replicate it`,
      )
    }

    const registered = this.definitions.get(identity.definition)
    if (!registered) {
      return this.refuse(
        participant,
        identity.id,
        Problem.definitionInvalid,
        `this connector does not hold ${identity.definition}`,
      )
    }

    // The sender's metadata, checked against what the log commits to. If these
    // disagree, nothing else is worth checking.
    const expected = genesisHash(instanceGenesis(identity))
    const wrong = delivery.events.find((event) => event.header.genesis !== expected)
    if (wrong) {
      return this.chainBroken(
        participant,
        identity.id,
        `the event at seq ${wrong.header.seq} does not belong to the instance this delivery describes`,
      )
    }

    const existing = await this.store.events.read(participant.id, identity.id, 0)

    /*
     * Check what overlaps with history we already hold, before deciding anything
     * is merely redundant.
     *
     * A peer re-presenting a *doctored* copy of an event we already have is the
     * purest form of "the host rewrote history", and skipping it as a duplicate
     * would be the quietest possible way to miss it. Two things must hold: the
     * header is byte-identical to ours, and any payload offered still hashes to
     * what that header commits to.
     */
    const bySeq = new Map(existing.map((event) => [event.header.seq, event]))
    for (const event of delivery.events) {
      const ours = bySeq.get(event.header.seq)
      if (!ours) continue

      if (headerHash(ours.header) !== headerHash(event.header)) {
        return this.chainBroken(
          participant,
          identity.id,
          `the event at seq ${event.header.seq} differs from the one already recorded: history has been rewritten`,
        )
      }
      if (!event.redacted && event.payload !== null) {
        if (hashJson(event.payload) !== event.header.payloadHash) {
          return this.chainBroken(
            participant,
            identity.id,
            `the payload at seq ${event.header.seq} does not hash to the payloadHash its header commits to`,
            Problem.payloadHashMismatch,
          )
        }
      }
    }

    // A field withheld at one state can be released at a later one, and a
    // replica cannot re-filter its way to a value it was never sent. So a
    // delivery may legitimately carry a *fuller* copy of an event we hold.
    const completed = await this.complete(participant, registered, identity, delivery.events)

    const held = existing.length
    const first = delivery.events[0]!.header.seq

    if (first > held + 1) {
      // A gap. Not an error and not something to guess around: the pull endpoint
      // is authoritative, so say where to resume from and let the caller pull.
      return {
        ok: true,
        value: { instanceId: identity.id, applied: 0, seq: held, gapFrom: held },
      }
    }

    const fresh = delivery.events.filter((event) => event.header.seq > held)
    if (fresh.length === 0) {
      return { ok: true, value: { instanceId: identity.id, applied: 0, seq: held, completed } }
    }

    const chain: SignedEvent[] = [...existing.map(toSignedEvent), ...fresh]

    /*
     * The whole chain is verified on every delivery, not just the new tail.
     *
     * It is O(events) per delivery, which for processes measured in tens of
     * events is microseconds. The alternative — trusting our own earlier
     * verification and checking only the join — is faster and is what a large
     * deployment would want, but it makes "we verified this" depend on state
     * rather than on the log in front of us. Revisit when a process gets long,
     * not before.
     */
    const verified = await verifyChain(chain, {
      resolver: this.resolver,
      definition: registered.definition,
      participants: identity.participants,
      instanceId: identity.id,
      genesis: instanceGenesis(identity),
    })

    if (!verified.ok) {
      const failure = verified.failures[0]
      return this.chainBroken(
        participant,
        identity.id,
        failure ? `seq ${failure.seq}: ${failure.error.detail}` : 'the chain did not verify',
        failure?.error.type,
      )
    }
    if (verified.state === null) {
      return this.chainBroken(participant, identity.id, 'the log folds to no state at all')
    }

    const before = await this.store.instances.get(participant.id, identity.id)

    // Home is resolved from *this instance's* participants, every time. A
    // replica of one instance and the home node of another under the same
    // definition is the normal case, not an edge case.
    const host = homeParticipant(registered.definition, identity.participants)

    /*
     * One `appendEvent` per event, not one for the whole delivery.
     *
     * The store's batch is all-or-nothing against a single `expectedSeq` per
     * participant, which is exactly right for "one transition, several local
     * copies" and exactly wrong for "several transitions". Each event is still
     * atomic across every local participant that holds the instance; a delivery
     * interrupted halfway leaves a shorter log, never a torn one.
     */
    const locals = this.localParticipants().filter(
      (local) => rolesOf(identity.participants, local.did).length > 0,
    )
    const running = new Map<string, SignedEvent[]>()
    for (const local of locals) {
      running.set(
        local.id,
        (await this.store.events.read(local.id, identity.id, 0)).map(toSignedEvent),
      )
    }

    let applied = 0
    let seq = held
    for (const event of delivery.events) {
      const writes: EventWrite[] = []
      for (const local of locals) {
        const log = running.get(local.id)!
        if (event.header.seq !== log.length + 1) continue

        const folded = foldEvents([...log, event])
        writes.push({
          participantId: local.id,
          expectedSeq: log.length,
          event: {
            ...event,
            participantId: local.id,
            // Never replicated, and never ours to invent for someone else's act.
            actorRef: null,
            recordedAt: this.now(),
          },
          instanceAfter: this.materialise(
            identity,
            local.id,
            host === local.did,
            { state: folded.state ?? verified.state, seq: folded.seq, data: folded.data },
            event.header.at,
          ),
        })
      }
      if (writes.length === 0) continue

      const appended = await this.store.appendEvent(writes)
      if (!appended.ok) {
        // Somebody replicated the same events concurrently. Harmless: the log is
        // identical either way, and the loser has nothing to add.
        break
      }
      for (const write of writes) running.get(write.participantId)!.push(event)
      applied += 1
      seq = event.header.seq
    }

    if (applied === 0) {
      return { ok: true, value: { instanceId: identity.id, applied: 0, seq, completed } }
    }

    await this.log.record({
      level: 'info',
      message: `replicated ${applied} event(s) from ${peerDid}`,
      audit: {
        participantId: participant.id,
        category: 'peer',
        action: 'replication.apply',
        actor: { kind: 'peer', id: peerDid, actorRef: null },
        outcome: 'ok',
        subject: { instance: identity.id },
        detail: `now at seq ${seq}`,
      },
    })

    const after = await this.store.instances.get(participant.id, identity.id)
    if (after) {
      await this.onWrite({
        definition: registered,
        before: before ?? null,
        after,
        events: fresh.map((event) => ({
          ...event,
          participantId: participant.id,
          actorRef: null,
          recordedAt: this.now(),
        })),
      })
    }

    return { ok: true, value: { instanceId: identity.id, applied, seq, completed } }
  }

  /**
   * Fill in payloads we were not entitled to when the event first arrived.
   *
   * The check that makes this safe is one line: the incoming payload must hash
   * to the `payloadHash` the header already commits to. So the only thing that
   * can be accepted is the genuine, complete payload of an event we already hold
   * and have already verified — not a different payload, and not a partial one.
   * Header and signature are untouched, so the chain is unaffected.
   */
  private async complete(
    participant: ParticipantConfig,
    registered: { definition: ProcessDefinition },
    identity: InstanceIdentity,
    incoming: readonly SignedEvent[],
  ): Promise<number> {
    const held = await this.store.events.read(participant.id, identity.id, 0)
    if (held.length === 0) return 0

    const bySeq = new Map(held.map((event) => [event.header.seq, event]))
    let completed = 0

    for (const event of incoming) {
      const ours = bySeq.get(event.header.seq)
      if (!ours || !ours.redacted) continue
      // The header match and the payload hash were checked in `apply` before
      // anything reached here, so what is left is: is this genuinely fuller?
      if (event.redacted || event.payload === null) continue

      const refolded = foldEvents(
        held.map((stored) =>
          stored.header.seq === event.header.seq
            ? { ...toSignedEvent(stored), payload: event.payload, redacted: false }
            : toSignedEvent(stored),
        ),
      )
      const current = await this.store.instances.get(participant.id, identity.id)
      if (!current) continue

      const done = await this.store.completeEvent({
        participantId: participant.id,
        instanceId: identity.id,
        seq: event.header.seq,
        payload: event.payload,
        instanceAfter: { ...current, data: refolded.data },
      })
      if (done) {
        completed += 1
        bySeq.set(event.header.seq, { ...ours, payload: event.payload, redacted: false })
      }
    }

    void registered
    return completed
  }

  private materialise(
    identity: InstanceIdentity,
    participantId: string,
    home: boolean,
    folded: { state: string; seq: number; data: Record<string, unknown> },
    updatedAt: string,
  ): StoredInstance {
    return {
      id: identity.id,
      kind: identity.kind,
      definition: identity.definition,
      participants: identity.participants,
      quotationId: identity.quotationId,
      offering: identity.offering,
      state: folded.state,
      seq: folded.seq,
      data: folded.data as StoredInstance['data'],
      createdAt: identity.createdAt,
      updatedAt,
      participantId,
      home,
    }
  }

  private async refuse(
    participant: ParticipantConfig,
    instanceId: string,
    type: ProtocolError['type'],
    detail: string,
  ): Promise<ReplicationResult<never>> {
    await this.log.record({
      level: 'warn',
      message: `replication refused: ${detail}`,
      audit: {
        participantId: participant.id,
        category: 'peer',
        action: 'replication.apply',
        actor: { kind: 'peer', id: 'peer', actorRef: null },
        outcome: 'denied',
        problem: type,
        detail,
        subject: { instance: instanceId },
      },
    })
    return { ok: false, errors: [protocolError(type, detail)] }
  }

  /**
   * The failure S4b is about.
   *
   * Audited as `chain.verify` / `failed` so there is a record even though no
   * event was written — which is the entire reason the audit log exists.
   */
  private async chainBroken(
    participant: ParticipantConfig,
    instanceId: string,
    detail: string,
    type: ProtocolError['type'] = Problem.chainBroken,
  ): Promise<ReplicationResult<never>> {
    await this.log.record({
      level: 'error',
      message: `chain verification failed for instance ${instanceId}: ${detail}`,
      audit: {
        participantId: participant.id,
        category: 'peer',
        action: 'chain.verify',
        actor: { kind: 'peer', id: 'peer', actorRef: null },
        outcome: 'failed',
        problem: type,
        detail,
        subject: { instance: instanceId },
      },
    })
    return { ok: false, errors: [protocolError(type, detail)] }
  }
}

export function toSignedEvent(event: StoredEvent): SignedEvent {
  return {
    header: event.header,
    payload: event.payload,
    redacted: event.redacted,
    sig: event.sig,
  }
}

export const REPLICATION = Symbol('ReplicationService')
