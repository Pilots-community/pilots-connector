/**
 * Deadlines — the abort paths, present from the start rather than bolted on.
 *
 * A transition may declare `deadline: "PT24H"` and `onDeadline: "expire"`. The
 * timer **arms on entry into the state that transition leads to**: `offer`
 * leads to `OFFERED`, so the deadline is "how long may an offer sit
 * unanswered", and `expire` — a transition with `by: []`, which is to say one no
 * participant can invoke by hand — is what fires when it runs out.
 *
 * **A scan loop over stored state, driven by `Clock`. Never `setTimeout`.**
 * That is not fastidiousness: a timer does not survive a restart, has no meaning
 * for the file store, and cannot be driven by a fake clock — so a `PT24H`
 * deadline would be either a test that sleeps for a day or a test that shortens
 * the duration and hopes. Here it is `clock.advance('PT24H')` and a call to
 * `pump()`.
 *
 * `cause` on the resulting event is `null`, deliberately. A link-fired
 * transition points at the signed event that justified it; nothing justified
 * this but the passage of time, and time is not an event anybody signed. What a
 * counterparty checks instead is the arithmetic: it holds the same log, so it
 * can see when the state was entered and compare.
 */
import { isTerminal, parseDuration, type Clock, type ProcessDefinition } from '@pilots/protocol'

import type { ParticipantConfig } from '../config/config.js'
import type { DefinitionRegistry } from '../definitions/definition-registry.js'
import type { InstanceService } from '../instances/instance.service.js'
import type { LogService } from '../logging/log.service.js'
import type { Store } from '../store/store.js'

export interface DeadlineOutcome {
  instanceId: string
  transition: string
  /** The state the instance was in when the deadline ran out. */
  from: string
}

export class DeadlineService {
  constructor(
    private readonly store: Store,
    private readonly definitions: DefinitionRegistry,
    private readonly instances: InstanceService,
    private readonly log: LogService,
    private readonly clock: Clock,
    private readonly localParticipants: () => readonly ParticipantConfig[],
  ) {}

  /** Fire every deadline that has run out. Returns what it fired, for tests and logs. */
  async pump(): Promise<DeadlineOutcome[]> {
    const fired: DeadlineOutcome[] = []

    for (const local of this.localParticipants()) {
      for (const instance of await this.store.instances.find(local.id)) {
        // Only the home node writes, and a terminal instance has nowhere to go.
        if (!instance.home) continue

        const registered = this.definitions.get(instance.definition)
        if (!registered) continue
        if (isTerminal(registered.definition, instance.state)) continue

        const due = await this.dueOn(registered.definition, instance.state, local.id, instance.id)
        if (!due) continue

        const result = await this.instances.fireRuntime({
          instanceId: instance.id,
          transition: due.transition,
          // Nothing signed the passing of time.
          cause: null,
          participantId: local.id,
        })
        if (!result.ok) continue

        fired.push({ instanceId: instance.id, transition: due.transition, from: instance.state })
        await this.log.record({
          level: 'info',
          message: `deadline fired ${due.transition}`,
          audit: {
            participantId: local.id,
            category: 'runtime',
            action: 'deadline.fire',
            actor: { kind: 'runtime', id: 'deadlines', actorRef: null },
            outcome: 'ok',
            subject: { instance: instance.id },
            detail: `${instance.state} was entered at ${due.enteredAt} and ${due.deadline} has passed`,
          },
        })
      }
    }

    return fired
  }

  /**
   * The first deadline that has run out in this state, if any.
   *
   * `deadline` is measured from **entry into the state**, so the clock starts at
   * the last event that changed state — not at `updatedAt`, which a pure data
   * patch also moves. Reading it from the log rather than caching it on the
   * instance keeps the log the single source of the answer.
   */
  private async dueOn(
    definition: ProcessDefinition,
    state: string,
    participantId: string,
    instanceId: string,
  ): Promise<{ transition: string; deadline: string; enteredAt: string } | undefined> {
    /*
     * A deadline **arms on entry into the state its transition leads to**, not
     * the state it applies in.
     *
     * `offer` leads to `OFFERED` and carries `deadline: PT24H, onDeadline:
     * expire`; `expire` applies in `OFFERED`. So the timer means "how long may
     * an offer sit unanswered", which is the only reading under which the
     * shipped definitions can ever fire — and the one the linter enforces.
     */
    const candidates = definition.transitions.filter(
      (transition) =>
        transition.deadline !== undefined &&
        transition.onDeadline !== undefined &&
        transition.to === state,
    )
    if (candidates.length === 0) return undefined

    const enteredAt = await this.enteredStateAt(participantId, instanceId)
    if (enteredAt === undefined) return undefined
    const since = Date.parse(enteredAt)

    for (const transition of candidates) {
      const elapsed = this.clock.now() - since
      if (elapsed >= parseDuration(transition.deadline!)) {
        return {
          transition: transition.onDeadline!,
          deadline: transition.deadline!,
          enteredAt,
        }
      }
    }
    return undefined
  }

  private async enteredStateAt(
    participantId: string,
    instanceId: string,
  ): Promise<string | undefined> {
    const events = await this.store.events.read(participantId, instanceId, 0)
    return events.findLast((event) => event.header.to !== null)?.header.at
  }
}

export const DEADLINES = Symbol('DeadlineService')
