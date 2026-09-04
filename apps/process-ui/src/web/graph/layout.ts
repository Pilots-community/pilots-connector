import type { GraphNode } from './to-graph.js'

const COLUMN = 230
const OFF_PATH_ROW = 120

/**
 * Positions, ours rather than a layout library's.
 *
 * Definitions are near-linear, so layer-times-column is enough, and an editor
 * wants positions that are **stable and eventually persisted** — not recomputed
 * under the cursor every time a transition is added. That is the reason to own
 * this rather than take on `dagre`.
 *
 * `indexInLane` only spreads the off-path states, which share a row and would
 * otherwise stack on top of each other when a definition has more than one way
 * to stop short.
 */
export function positionOf(node: GraphNode, indexInLane: number): { x: number; y: number } {
  if (node.lane === 'off-path') {
    return { x: node.layer * COLUMN + indexInLane * COLUMN, y: OFF_PATH_ROW }
  }
  return { x: node.layer * COLUMN, y: 0 }
}
