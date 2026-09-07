/**
 * Two answers to "our copy is wrong", which are not the same problem.
 *
 * The design says the event log is the record and the materialised instance is a
 * cache of it ([ARCHITECTURE.md §5.2](../../../../docs/ARCHITECTURE.md)). That is
 * a claim about what may be thrown away, and a claim of that kind is worth
 * exactly as much as the operation that exercises it. So:
 *
 * - **`rebuild`** — refold the instance from the log we already hold, verifying
 *   the chain on the way, and repair the document if it disagreed. This is the
 *   cache claim, made operational. It needs no peer and no network.
 * - **`recover`** — our log is short or gone; pull it back from a participant
 *   who kept a copy. This is the *home node* recovery path: a connector whose
 *   disk died is restored from the replicas of the very peers it was hosting
 *   for, and it verifies every signature on the way in — including the ones it
 *   made itself.
 *
 * What neither of these is: a way to change who hosts an instance. `hostedBy` is
 * a role, resolved through `participants`, and `participants` is inside
 * `genesis`, which every event commits to. Moving hosting to a different
 * participant would break the chain by construction — which is the point.
 * Re-hosting therefore means *the same participant on new infrastructure*, and
 * `recover` is how it gets its state back.
 *
 * The honest limitation, stated at the call site rather than in a footnote: a
 * peer can only return what it was allowed to see. Fields withheld from it stay
 * withheld, and the recovered log says so — `redacted` counts them. The chain
 * still verifies, because `payloadHash` commits to the payload rather than
 * containing it.
 */
import {
  carriesTraffic,
  foldEvents,
  homeParticipant,
  instanceGenesis,
  verifyChain,
  type DidResolver,
  type InstanceIdentity,
  type StoredInstance,
} from '@pilots/protocol'

import type { ConnectionService } from '../connections/connection.service.js'
import type { ParticipantConfig } from '../config/config.js'
import type { DefinitionRegistry } from '../definitions/definition-registry.js'
import type { PeerStreamClient } from '../delivery/peer-stream-client.js'
import type { LogService } from '../logging/log.service.js'
import { toSignedEvent } from '../replication/replication.service.js'
import type { Store } from '../store/store.js'

export interface RebuildOutcome {
  instanceId: string
  seq: number
  state: string
  /** The document disagreed with its own log, and has been rewritten from it. */
  repaired: boolean
  /** What disagreed, named — `state`, `seq`, `data`. Empty when nothing did. */
  differences: string[]
  /** Every event verified: signature, `prev`, `genesis`, actor's authority. */
  verified: boolean
}

export interface RecoverOutcome {
  instanceId: string
  /** The peer we pulled from. */
  from: string
  /** How many events were new to us. Zero means we were already current. */
  applied: number
  seq: number
  state: string
  /** Whether this connector is the home node for the instance it just recovered. */
  home: boolean
  /** Events whose payload that peer was never entitled to, and cannot return. */
  redacted: number
}

export type RecoveryResult<T> = { ok: true; value: T } | { ok: false; detail: string }

export class RecoveryService {
  constructor(
    private readonly store: Store,
    private readonly definitions: DefinitionRegistry,
    private readonly connections: ConnectionService,
    private readonly streams: PeerStreamClient,
    private readonly resolver: DidResolver,
    private readonly log: LogService,
    private readonly now: () => string,
  ) {}

  /**
   * Refold one instance from its own log.
   *
   * Deliberately not a repair-everything sweep: an operator asks about an
   * instance they have a reason to doubt, and the answer names what was wrong.
   * A silent background reconciler would make "the cache never diverges"
   * unfalsifiable.
   */
  async rebuild(
    participant: ParticipantConfig,
    instanceId: string,
  ): Promise<RecoveryResult<RebuildOutcome>> {
    const stored = await this.store.instances.get(participant.id, instanceId)
    if (!stored) {
      // Rebuilding needs the instance identity — the participants map, which the
      // log commits to by hash but does not contain. Without a document there is
      // nothing to rebuild *from*; that is `recover`'s job, because a peer sends
      // the identity along with the events.
      return { ok: false, detail: `no instance ${instanceId}; recover it from a peer instead` }
    }

    const registered = this.definitions.get(stored.definition)
    if (!registered) {
      return { ok: false, detail: `this connector does not hold ${stored.definition}` }
    }

    const events = (await this.store.events.read(participant.id, instanceId, 0)).map(toSignedEvent)
    if (events.length === 0) return { ok: false, detail: 'the log is empty' }

    const identity = toIdentity(stored)
    const verification = await verifyChain(events, {
      resolver: this.resolver,
      definition: registered.definition,
      participants: stored.participants,
      instanceId,
      // Not decoration: this is what proves the document's participants map is
      // the one the log was written against, rather than one we were handed.
      genesis: instanceGenesis(identity),
    })

    if (!verification.ok || verification.state === null) {
      await this.audit(participant, 'instance.rebuild', 'failed', instanceId, {
        detail: verification.failures[0]?.error.detail ?? 'the log folds to no state',
      })
      return {
        ok: false,
        detail: `the log does not verify at seq ${verification.failures[0]?.seq ?? 0}: ${
          verification.failures[0]?.error.detail ?? 'unknown'
        }`,
      }
    }

    const folded = foldEvents(events)
    const differences: string[] = []
    if (stored.state !== folded.state) differences.push('state')
    if (stored.seq !== folded.seq) differences.push('seq')
    if (JSON.stringify(stored.data) !== JSON.stringify(folded.data)) differences.push('data')

    if (differences.length > 0) {
      await this.store.instances.replace({
        ...stored,
        state: folded.state ?? stored.state,
        seq: folded.seq,
        data: folded.data,
        // Home is recomputed rather than carried over: it is a function of this
        // instance's participants, and a stale document is exactly where a wrong
        // answer would have been cached.
        home: homeParticipant(registered.definition, stored.participants) === participant.did,
        updatedAt: this.now(),
      })
    }

    await this.audit(
      participant,
      'instance.rebuild',
      'ok',
      instanceId,
      differences.length > 0
        ? { detail: `repaired ${differences.join(', ')} from the log at seq ${folded.seq}` }
        : { detail: `the document already matched its log at seq ${folded.seq}` },
    )

    return {
      ok: true,
      value: {
        instanceId,
        seq: folded.seq,
        state: folded.state ?? stored.state,
        repaired: differences.length > 0,
        differences,
        verified: true,
      },
    }
  }

  /**
   * Pull an instance back from a participant who still has it.
   *
   * `GET /instances/{id}/events?since=` is already the authoritative delivery
   * recovery path, so this adds no protocol: it is the same call, made
   * deliberately by an operator instead of automatically by a stream that
   * noticed a gap. Everything it returns goes through `ReplicationService`,
   * which means a peer cannot use a recovery request to hand us a chain we would
   * not otherwise have accepted.
   */
  async recover(
    participant: ParticipantConfig,
    instanceId: string,
    from?: string,
  ): Promise<RecoveryResult<RecoverOutcome>> {
    const candidates = (await this.connections.list(participant.id))
      // Not `=== 'ACTIVE'`: a DEGRADED connection is precisely the one an
      // operator reaches for here, because it is degraded by whatever went
      // wrong. `carriesTraffic` is the same predicate delivery uses.
      .filter((connection) => carriesTraffic(connection.status))
      .filter((connection) => from === undefined || connection.peerDid === from)
    if (candidates.length === 0) {
      return {
        ok: false,
        detail:
          from === undefined
            ? 'no usable connection to recover from'
            : `no usable connection to ${from}`,
      }
    }

    const held = (await this.store.events.read(participant.id, instanceId, 0)).length

    /*
     * Try each peer until one gives us something.
     *
     * Not a fallback chain so much as the shape of the problem: after losing a
     * disk we may not know which peers took part in which instance, and asking
     * one that did not is a 404 rather than an error. `pull` is silent about
     * unreachable peers by design, so the outcome is read from the log length.
     */
    for (const connection of candidates) {
      await this.streams.pull(participant, connection.peerDid, instanceId, held)
      const after = await this.store.instances.get(participant.id, instanceId)
      const events = await this.store.events.read(participant.id, instanceId, 0)
      if (!after || events.length === held) continue

      const registered = this.definitions.get(after.definition)
      const home =
        registered !== undefined &&
        homeParticipant(registered.definition, after.participants) === participant.did

      const outcome: RecoverOutcome = {
        instanceId,
        from: connection.peerDid,
        applied: events.length - held,
        seq: after.seq,
        state: after.state,
        home,
        redacted: events.filter((event) => event.redacted).length,
      }

      await this.audit(participant, 'instance.recover', 'ok', instanceId, {
        detail: `pulled ${outcome.applied} event(s) from ${connection.peerDid}; now at seq ${
          outcome.seq
        }${home ? ', as the home node' : ''}${
          outcome.redacted > 0 ? `; ${outcome.redacted} event(s) came back redacted` : ''
        }`,
      })
      return { ok: true, value: outcome }
    }

    await this.audit(participant, 'instance.recover', 'failed', instanceId, {
      detail: `no peer returned anything new for ${instanceId}`,
    })
    return { ok: false, detail: `no peer returned anything new for ${instanceId}` }
  }

  private async audit(
    participant: ParticipantConfig,
    action: string,
    outcome: 'ok' | 'failed',
    instanceId: string,
    extra: { detail: string },
  ): Promise<void> {
    await this.log.record({
      level: outcome === 'ok' ? 'info' : 'warn',
      message: `${action}: ${extra.detail}`,
      audit: {
        participantId: participant.id,
        category: 'admin',
        action,
        actor: { kind: 'runtime', id: 'recovery', actorRef: null },
        outcome,
        subject: { instance: instanceId },
        detail: extra.detail,
      },
    })
  }
}

function toIdentity(stored: StoredInstance): InstanceIdentity {
  return {
    id: stored.id,
    kind: stored.kind,
    definition: stored.definition,
    definitionHash: stored.definitionHash,
    participants: stored.participants,
    quotationId: stored.quotationId,
    offering: stored.offering,
    createdAt: stored.createdAt,
  }
}
