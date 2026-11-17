/**
 * Positions — ours, and never inside the definition.
 *
 * The `definitionHash` covers the document's bytes, so moving a box must not
 * change a process's identity: layout is a separate map keyed by the stable
 * node keys of `model.ts`. Lanes are rows; columns are breadth-first from the
 * start, which suits definitions that are near-linear (the same reasoning as
 * the process UI's `layout.ts`, and the same refusal of a layout library).
 */
import type { DiagramModel } from './model.js'

export type DiagramLayout = Record<string, { x: number; y: number }>

export const COLUMN_WIDTH = 190
export const LANE_HEIGHT = 170
/** Room on the left of every lane for its title. */
export const LANE_GUTTER = 150
const ROW_SLOT = 52
const SLOTS_PER_ROW = 3

export function autoLayout(model: DiagramModel): DiagramLayout {
  const outgoing = new Map<string, string[]>()
  const incoming = new Map<string, string[]>()
  for (const edge of model.edges) {
    outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge.target])
    incoming.set(edge.target, [...(incoming.get(edge.target) ?? []), edge.source])
  }

  const column = new Map<string, number>()
  let frontier = model.nodes.filter((node) => node.kind === 'start').map((node) => node.key)
  for (const key of frontier) column.set(key, 0)
  while (frontier.length > 0) {
    const next: string[] = []
    for (const key of frontier) {
      for (const target of outgoing.get(key) ?? []) {
        if (column.has(target)) continue
        column.set(target, (column.get(key) ?? 0) + 1)
        next.push(target)
      }
    }
    frontier = next
  }
  // Nothing leads to a wildcard task or an unanchored message, so they sit past the end.
  const beyond = Math.max(0, ...column.values()) + 1

  const byKey = new Map(model.nodes.map((node) => [node.key, node]))
  const laneIndex = new Map(model.lanes.map((lane, index) => [lane.roleId, index]))
  const outside = model.lanes.length
  const rowOfLane = (lane: string | null | undefined): number | undefined =>
    lane === null || lane === undefined ? undefined : laneIndex.get(lane)

  /** A state or an event has no lane of its own: it sits with whoever leads to it, else with whoever leaves it. */
  const rowOf = (key: string): number => {
    const own = rowOfLane(byKey.get(key)?.lane)
    if (own !== undefined) return own
    for (const neighbour of [...(incoming.get(key) ?? []), ...(outgoing.get(key) ?? [])]) {
      const row = rowOfLane(byKey.get(neighbour)?.lane)
      if (row !== undefined) return row
    }
    return outside
  }

  const used = new Map<string, number>()
  const layout: DiagramLayout = {}
  for (const node of model.nodes) {
    const col = column.get(node.key) ?? beyond
    const row = rowOf(node.key)
    const cell = `${col}:${row}`
    const slot = used.get(cell) ?? 0
    used.set(cell, slot + 1)
    layout[node.key] = {
      x: LANE_GUTTER + col * COLUMN_WIDTH + Math.floor(slot / SLOTS_PER_ROW) * 40,
      y: row * LANE_HEIGHT + 24 + (slot % SLOTS_PER_ROW) * ROW_SLOT,
    }
  }
  return layout
}

/** What the author placed, where it still exists; the automatic layout for the rest. */
export function withLayout(model: DiagramModel, saved: DiagramLayout = {}): DiagramLayout {
  const layout = autoLayout(model)
  for (const key of Object.keys(layout)) {
    const placed = saved[key]
    if (placed !== undefined) layout[key] = placed
  }
  return layout
}

/** The role whose lane a height falls in. Dropping a task there changes who fires it. */
export function laneAt(model: DiagramModel, y: number): string | null {
  const index = Math.floor(y / LANE_HEIGHT)
  return model.lanes[index]?.roleId ?? null
}

/** Keys are derived from ids, so a rename must carry the author's positions with it. */
export function renameLayoutKeys(
  layout: DiagramLayout,
  kind: 'role' | 'state' | 'transition',
  from: string,
  to: string,
): DiagramLayout {
  const rewrite = (key: string): string => {
    const colon = key.indexOf(':')
    const prefix = key.slice(0, colon)
    const rest = key.slice(colon + 1)
    switch (kind) {
      case 'role':
        if (prefix === 'lane' && rest === from) return `lane:${to}`
        if (prefix === 'task' && rest.endsWith(`@${from}`)) {
          return `task:${rest.slice(0, -from.length - 1)}@${to}`
        }
        return key
      case 'state':
        return (prefix === 'state' || prefix === 'gateway') && rest === from ? `${prefix}:${to}` : key
      case 'transition':
        if (prefix === 'timer' && rest === from) return `timer:${to}`
        if (prefix === 'task' && (rest === from || rest.startsWith(`${from}@`))) {
          return `task:${to}${rest.slice(from.length)}`
        }
        if (prefix === 'message' && rest.startsWith(`${from}#`)) {
          return `message:${to}${rest.slice(from.length)}`
        }
        return key
    }
  }
  return Object.fromEntries(Object.entries(layout).map(([key, value]) => [rewrite(key), value]))
}
