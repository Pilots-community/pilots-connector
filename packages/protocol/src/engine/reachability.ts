/**
 * Which parts of a definition can actually be walked, and by what.
 *
 * A definition's edges are not equally available. `by: []` means no participant
 * may fire a transition — but the engine may (`auto`), the clock may (a
 * `deadline` arming into the source state), or a linked instance may (a `links`
 * entry naming it). The last of those is the subtle one: `links` are declared
 * per definition and anchored **per instance**, so a link-fired edge is walkable
 * only when the relation it names is set on the instance in question.
 *
 * That distinction is why a definition can be perfectly valid while an instance
 * created under it can never succeed, which is the mistake this module exists to
 * make detectable. The linter asks the definition-level question; the connector
 * asks the instance-level one at creation; both get their answer here, because
 * two implementations of the same question would eventually disagree.
 */
import {
  expandFromStates,
  outcomeOf,
  parseLinkEvent,
  terminalStates,
  type ProcessDefinition,
} from '../schemas/definition.js'

export type EdgeDriver = 'participant' | 'auto' | 'deadline' | { link: string }

export interface DefinitionEdge {
  from: string
  to: string
  transition: string
  transitionIndex: number
  /** Everything that could fire this edge. Empty means nothing can. */
  drivers: EdgeDriver[]
}

export interface ReachabilityOptions {
  /**
   * Link relations anchored on the instance being asked about. `'all'` asks the
   * definition-level question — is this reachable for *some* instance. The
   * default, `[]`, asks the standalone question: an instance created with no
   * relations set.
   */
  anchoredRelations?: readonly string[] | 'all'
}

export interface Reachability {
  /** States reachable from `initialState` across walkable edges. */
  reachable: Set<string>
  fulfilmentReachable: boolean
  /**
   * Relations that would make fulfilment reachable if anchored. Empty when
   * fulfilment is already reachable, and also when nothing would help.
   */
  unlockingRelations: string[]
}

/** Every edge the definition declares, each tagged with what could fire it. */
export function definitionEdges(definition: ProcessDefinition): DefinitionEdge[] {
  const declared = new Set(definition.states.map((state) => state.id))

  /** Transitions fired by a link, and the relation each link names. */
  const linkRelations = new Map<string, Set<string>>()
  for (const link of definition.links) {
    const { relation } = parseLinkEvent(link.onEvent)
    const bucket = linkRelations.get(link.triggers)
    if (bucket) bucket.add(relation)
    else linkRelations.set(link.triggers, new Set([relation]))
  }

  /*
   * A deadline arms on entry into the state its transition leads to, and fires
   * `onDeadline` from there — so the clock can drive an edge only out of that
   * state, never out of every state the fired transition lists in `from`.
   */
  const deadlineArmedIn = new Map<string, Set<string>>()
  for (const transition of definition.transitions) {
    if (transition.onDeadline === undefined || transition.to === undefined) continue
    const bucket = deadlineArmedIn.get(transition.onDeadline)
    if (bucket) bucket.add(transition.to)
    else deadlineArmedIn.set(transition.onDeadline, new Set([transition.to]))
  }

  const edges: DefinitionEdge[] = []
  for (const [transitionIndex, transition] of definition.transitions.entries()) {
    const froms = expandFromStates(definition, transition).filter((state) => declared.has(state))
    for (const from of froms) {
      const drivers: EdgeDriver[] = []
      if (transition.by.length > 0) drivers.push('participant')
      if (transition.auto) drivers.push('auto')
      if (deadlineArmedIn.get(transition.id)?.has(from)) drivers.push('deadline')
      for (const relation of linkRelations.get(transition.id) ?? []) {
        drivers.push({ link: relation })
      }

      edges.push({
        from,
        // A transition with no `to` is a pure data update: a self-loop that
        // moves nothing, which is how the linter's edges treat it too.
        to: transition.to ?? from,
        transition: transition.id,
        transitionIndex,
        drivers,
      })
    }
  }
  return edges
}

function isWalkable(edge: DefinitionEdge, anchored: readonly string[] | 'all'): boolean {
  return edge.drivers.some((driver) => {
    if (typeof driver === 'string') return true
    return anchored === 'all' || anchored.includes(driver.link)
  })
}

/** Every link relation the definition mentions, in first-seen order. */
function relationsOf(definition: ProcessDefinition): string[] {
  const seen: string[] = []
  for (const link of definition.links) {
    const { relation } = parseLinkEvent(link.onEvent)
    if (!seen.includes(relation)) seen.push(relation)
  }
  return seen
}

function walkFrom(
  edges: readonly DefinitionEdge[],
  seed: string,
  anchored: readonly string[] | 'all',
): Set<string> {
  const adjacency = new Map<string, Set<string>>()
  for (const edge of edges) {
    if (!isWalkable(edge, anchored)) continue
    const bucket = adjacency.get(edge.from)
    if (bucket) bucket.add(edge.to)
    else adjacency.set(edge.from, new Set([edge.to]))
  }

  const seen = new Set([seed])
  const stack = [seed]
  while (stack.length > 0) {
    const current = stack.pop()!
    for (const next of adjacency.get(current) ?? []) {
      if (!seen.has(next)) {
        seen.add(next)
        stack.push(next)
      }
    }
  }
  return seen
}

const reachesFulfilment = (definition: ProcessDefinition, states: ReadonlySet<string>): boolean =>
  [...states].some((state) => outcomeOf(definition, state) === 'fulfilled')

export function analyseReachability(
  definition: ProcessDefinition,
  options: ReachabilityOptions = {},
): Reachability {
  const anchored = options.anchoredRelations ?? []
  const edges = definitionEdges(definition)
  const reachable = walkFrom(edges, definition.initialState, anchored)
  const fulfilmentReachable = reachesFulfilment(definition, reachable)

  if (fulfilmentReachable || anchored === 'all') {
    return { reachable, fulfilmentReachable, unlockingRelations: [] }
  }

  /*
   * Which single relation would unlock it. Tested one at a time rather than
   * reported as "every relation this definition mentions", because a definition
   * may name a relation that has nothing to do with the blocked path.
   */
  const unlockingRelations = relationsOf(definition)
    .filter((relation) => !anchored.includes(relation))
    .filter((relation) =>
      reachesFulfilment(
        definition,
        walkFrom(edges, definition.initialState, [...anchored, relation]),
      ),
    )

  return { reachable, fulfilmentReachable, unlockingRelations }
}

/**
 * Reachable non-terminal states that nothing can leave. Terminal states are
 * meant to have no exit, so they are never faulted.
 */
export function statesWithoutFireableExit(definition: ProcessDefinition): string[] {
  const terminal = new Set(terminalStates(definition))
  const edges = definitionEdges(definition)
  const { reachable } = analyseReachability(definition, { anchoredRelations: 'all' })

  return [...reachable]
    .filter((state) => !terminal.has(state))
    .filter(
      (state) =>
        !edges.some((edge) => edge.from === state && edge.to !== state && isWalkable(edge, 'all')),
    )
    .sort()
}

/** Reachable non-terminal states from which no fulfilled ending can be reached. */
export function statesWithoutFulfilment(definition: ProcessDefinition): string[] {
  const terminal = new Set(terminalStates(definition))
  const edges = definitionEdges(definition)
  const { reachable } = analyseReachability(definition, { anchoredRelations: 'all' })

  return [...reachable]
    .filter((state) => !terminal.has(state))
    .filter((state) => !reachesFulfilment(definition, walkFrom(edges, state, 'all')))
    .sort()
}
