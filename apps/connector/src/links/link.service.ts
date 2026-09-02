/**
 * `links` — advancing one instance from a signed event in another.
 *
 * This is what makes "the quotation process does not block execution" concrete.
 * A service instance is created at the same time as its quotation and sits in
 * `PENDING_CONTRACT`: real, addressable, and simply unable to advance yet. When
 * the quotation reaches `AGREED`, the link fires `startExecution` and the
 * service becomes contracted. Nobody clicks anything, and no client had to know
 * the rule — it is in the definition.
 *
 * Three things this is careful about:
 *
 * - **It is a write observer**, so it fires on replicated events exactly as on
 *   local ones. The quotation and the service can have different home nodes;
 *   the side that hosts the *service* is the side that must react, and it may
 *   only learn of the quotation's move by replication.
 * - **Only the home node of the linked instance fires it.** `fireRuntime`
 *   enforces that. A replica firing its own runtime transitions would fork the
 *   chain, and the fork would be signed.
 * - **The causing event is recorded in the header**, not only in our audit log.
 *   A `by: []` transition is one no participant may invoke by hand, so without
 *   `cause` there is nothing to distinguish a legitimate link-driven advance
 *   from one the host decided to write. With it, a counterparty can find that
 *   event in the quotation it holds and check the claim.
 */
import { headerHash, parseLinkEvent, type StoredEvent, type StoredInstance } from '@pilots/protocol'

import type { ParticipantConfig } from '../config/config.js'
import type { DefinitionRegistry } from '../definitions/definition-registry.js'
import type { InstanceService } from '../instances/instance.service.js'
import type { LogService } from '../logging/log.service.js'
import type { WriteNotice } from '../notifications/notification.service.js'
import type { Store } from '../store/store.js'

/**
 * The only relation the schema defines today. Named rather than assumed, so
 * adding a second one is a change to this map and the `LinkRelation` enum rather
 * than a hunt through the code.
 */
const RELATIONS: Record<string, (instance: StoredInstance) => string | null> = {
  quotation: (instance) => instance.quotationId,
}

/** A link chain must terminate: a fires b fires a is a definition bug, not a hang. */
const MAX_LINK_DEPTH = 8

export class LinkService {
  constructor(
    private readonly store: Store,
    private readonly definitions: DefinitionRegistry,
    private readonly instances: InstanceService,
    private readonly log: LogService,
    private readonly localParticipants: () => readonly ParticipantConfig[],
  ) {}

  /**
   * A write landed on some instance. Advance anything linked to it.
   *
   * Matching is on the state the instance is now in **or** the transition that
   * was just fired, because `onEvent` is specified as `<relation>:<state |
   * transitionId>` and both are useful: `quotation:AGREED` is a state, and a
   * definition that wanted to react to `counter` regardless of the state it
   * lands in would name the transition.
   */
  async onWrite(notice: WriteNotice, depth = 0): Promise<void> {
    if (depth >= MAX_LINK_DEPTH) {
      this.log.warn(
        { instance: notice.after.id, depth },
        'link chain hit its depth limit; check the definition for a cycle',
      )
      return
    }

    const fired = notice.events.map((event) => event.header.transition)
    const matches = new Set<string>([notice.after.state, ...fired])

    for (const local of this.localParticipants()) {
      for (const linked of await this.linkedTo(local.id, notice.after)) {
        const registered = this.definitions.get(linked.definition)
        if (!registered) continue

        for (const link of registered.definition.links) {
          const { relation, match } = parseLinkEvent(link.onEvent)
          if (RELATIONS[relation]?.(linked) !== notice.after.id) continue
          if (!matches.has(match)) continue

          await this.fire(local, linked, link.triggers, notice, match, depth)
          break
        }
      }
    }
  }

  /** Instances this participant holds that point at `source`, by any relation. */
  private async linkedTo(participantId: string, source: StoredInstance): Promise<StoredInstance[]> {
    const held = await this.store.instances.find(participantId, {
      where: { quotationId: source.id },
    })
    // Only the home node may write, so the rest are somebody else's to advance.
    return held.filter((instance) => instance.home && instance.id !== source.id)
  }

  private async fire(
    local: ParticipantConfig,
    linked: StoredInstance,
    transition: string,
    notice: WriteNotice,
    match: string,
    depth: number,
  ): Promise<void> {
    const causing = causeFor(notice.events, match, notice.after.state)
    const cause = causing ? headerHash(causing.header) : null

    const result = await this.instances.fireRuntime({
      instanceId: linked.id,
      transition,
      cause,
      participantId: local.id,
    })

    if (!result.ok) {
      // Not necessarily wrong: a link that fires twice, or one whose target has
      // already moved on, is an ordinary outcome rather than a fault. It is
      // logged, not audited as a denial, because nobody was refused anything.
      this.log.debug(
        {
          instance: linked.id,
          transition,
          source: notice.after.id,
          reason: result.errors[0]?.detail,
        },
        'link did not fire',
      )
      return
    }

    await this.log.record({
      level: 'info',
      message: `link ${match} fired ${transition}`,
      audit: {
        participantId: local.id,
        category: 'runtime',
        action: 'link.fire',
        actor: { kind: 'runtime', id: 'links', actorRef: null },
        outcome: 'ok',
        subject: { instance: linked.id },
        detail: `${notice.after.id} reached ${match}, so ${transition} fired${
          cause === null ? '' : ` (cause ${cause})`
        }`,
      },
    })

    // A link may cascade: the instance it just advanced can itself be linked to.
    const registered = this.definitions.get(linked.definition)
    if (!registered) return
    await this.onWrite(
      {
        definition: registered,
        before: linked,
        after: result.value.instance,
        events: result.value.events,
      },
      depth + 1,
    )
  }
}

/**
 * Which of this write's events is the one to point `cause` at.
 *
 * The event that fired the matching transition, or — when the link matched on a
 * state — the event that entered it. Falling back to the last event is right
 * for an `auto` chain, where the state was reached by the final event of several.
 */
function causeFor(
  events: readonly StoredEvent[],
  match: string,
  state: string,
): StoredEvent | undefined {
  return (
    events.find((event) => event.header.transition === match) ??
    events.findLast((event) => event.header.to === state) ??
    events.at(-1)
  )
}

export const LINKS = Symbol('LinkService')
