/**
 * A process definition, as a graph — and an instance's history, as a path
 * through it.
 *
 * Pure and browser-free, so the rules below are unit-tested rather than
 * eyeballed. It is also the model Iteration 2's editor will mutate, which is
 * why it returns plain nodes and edges rather than anything React Flow-shaped.
 *
 * Two rules, each with an obvious wrong version:
 *
 * - **The lane is declared, not guessed.** A state whose `outcome` is
 *   `abandoned` is drawn below the line; `fulfilled` stays on it, as the happy
 *   ending. An earlier draft inferred this from "reached only by a wildcard",
 *   which got `REJECTED` and `EXPIRED` wrong in the quotation definition —
 *   both arrive by ordinary transitions and neither is a happy ending.
 * - **A wildcard is one edge, not many.** `from: ["*"]` expanded is four edges
 *   in `container-weighing` and six in `container-transport-with-terminal`, and
 *   the diagram stops being readable exactly where it should be clearest.
 */
import type { ProcessDefinition, SignedEvent } from '../api.js'

export const ANY_STATE_NODE = '__any__'

export interface GraphNode {
  id: string
  title: string
  layer: number
  lane: 'main' | 'off-path'
  kind: 'state' | 'any-state'
  /** The process ends here. Derived from `outcome`, which is the only marker. */
  terminal: boolean
  /** This instance has been in this state. */
  reached: boolean
  current: boolean
}

export interface GraphEdge {
  id: string
  /** React Flow's names, not the definition's `from`/`to`, which would collide. */
  source: string
  target: string
  transition: string
  title: string
  by: string[]
  wildcard: boolean
  taken: boolean
}

export interface ProcessGraph {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

export interface GraphOptions {
  history?: readonly SignedEvent[]
  current?: string
}

const isWildcard = (from: readonly string[]): boolean => from.includes('*')

export function toGraph(definition: ProcessDefinition, options: GraphOptions = {}): ProcessGraph {
  const wildcards = definition.transitions.filter((one) => isWildcard(one.from))
  const ordinary = definition.transitions.filter((one) => !isWildcard(one.from))

  /*
   * Layers: breadth-first from the initial state over **ordinary** edges only.
   *
   * Following a wildcard would put `CANCELLED` one step from the start and sit
   * it in the middle of the happy path, because `cancel` reaches it from
   * everywhere.
   */
  const layers = new Map<string, number>([[definition.initialState, 0]])
  let frontier = [definition.initialState]
  while (frontier.length > 0) {
    const next: string[] = []
    for (const state of frontier) {
      for (const transition of ordinary) {
        if (!transition.from.includes(state) || transition.to === undefined) continue
        if (layers.has(transition.to)) continue
        layers.set(transition.to, (layers.get(state) ?? 0) + 1)
        next.push(transition.to)
      }
    }
    frontier = next
  }
  const deepest = Math.max(0, ...layers.values())

  const taken = new Set<string>()
  const reached = new Set<string>()
  for (const one of options.history ?? []) {
    if (one.header.to !== null) reached.add(one.header.to)
    if (one.header.from !== null) reached.add(one.header.from)
    taken.add(one.header.transition)
  }

  const nodes: GraphNode[] = definition.states.map((state) => ({
    id: state.id,
    title: state.title,
    // An unreachable state still has to be drawn somewhere, and the far right
    // is honest about it not lying on the path from the initial state.
    layer: layers.get(state.id) ?? deepest + 1,
    lane: state.outcome === 'abandoned' ? 'off-path' : 'main',
    kind: 'state',
    terminal: state.outcome !== undefined,
    reached: reached.has(state.id),
    current: options.current === state.id,
  }))

  if (wildcards.length > 0) {
    nodes.push({
      id: ANY_STATE_NODE,
      title: 'any state',
      layer: 0,
      lane: 'off-path',
      kind: 'any-state',
      terminal: false,
      reached: false,
      current: false,
    })
  }

  const edges: GraphEdge[] = definition.transitions.flatMap((transition) => {
    const target = transition.to
    if (target === undefined) return []
    const wildcard = isWildcard(transition.from)
    const sources = wildcard ? [ANY_STATE_NODE] : transition.from
    return sources.map((source) => ({
      id: `${transition.id}:${source}`,
      source,
      target,
      transition: transition.id,
      title: transition.title,
      by: transition.by,
      wildcard,
      taken: taken.has(transition.id),
    }))
  })

  return { nodes, edges }
}
