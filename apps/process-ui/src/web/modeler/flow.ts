/**
 * The diagram model, in React Flow's terms — and the two gestures that mean
 * something to the definition: dropping a task in another lane (a change of
 * role) and drawing an arrow from one state to another (a new task).
 */
import {
  LANE_HEIGHT,
  laneAt,
  type DiagramLayout,
  type DiagramModel,
  type DiagramNode,
  type ElementRef,
} from '@pilots/bpmn'
import type { Edge, Node } from '@xyflow/react'

export const LANE_WIDTH = 2400

export function toFlow(
  model: DiagramModel,
  layout: DiagramLayout,
  options: { flagged: ReadonlySet<string>; readOnly: boolean },
): { nodes: Node[]; edges: Edge[] } {
  const lanes: Node[] = model.lanes.map((lane, index) => ({
    id: lane.key,
    type: 'lane',
    position: { x: 0, y: index * LANE_HEIGHT },
    data: { title: lane.title, multiple: lane.multiple, flagged: options.flagged.has(lane.key) },
    draggable: false,
    selectable: true,
    zIndex: -1,
    style: { width: LANE_WIDTH, height: LANE_HEIGHT },
  }))
  const nodes: Node[] = model.nodes.map((node) => ({
    id: node.key,
    type: 'bpmn',
    position: layout[node.key] ?? { x: 0, y: 0 },
    data: { node, flagged: options.flagged.has(node.key) },
    draggable: !options.readOnly,
    selectable: true,
  }))
  const edges: Edge[] = model.edges.map((edge) => ({
    id: edge.key,
    source: edge.source,
    target: edge.target,
    ...(edge.label === null ? {} : { label: edge.label }),
    data: { flagged: options.flagged.has(edge.key), markers: edge.markers },
  }))
  return { nodes: [...lanes, ...nodes], edges }
}

/** A task dropped in another lane is fired by another role. */
export function laneChange(
  node: DiagramNode,
  y: number,
  model: DiagramModel,
): { transition: string; fromRole: string; toRole: string } | null {
  if (node.kind !== 'task' || node.lane === null || node.ref?.kind !== 'transition') return null
  const toRole = laneAt(model, y)
  if (toRole === null || toRole === node.lane) return null
  return { transition: node.ref.id, fromRole: node.lane, toRole }
}

/** An arrow may be drawn from a state, or from the gateway after it. */
export function stateOfKey(key: string): string | null {
  const match = /^(?:state|gateway):(.+)$/.exec(key)
  return match?.[1] ?? null
}

/** What the properties panel should show for a clicked key. */
export function refOfKey(model: DiagramModel, key: string): ElementRef | null {
  const lane = model.lanes.find((one) => one.key === key)
  if (lane !== undefined) return { kind: 'role', id: lane.roleId }
  return (
    model.nodes.find((one) => one.key === key)?.ref ?? model.edges.find((one) => one.key === key)?.ref ?? null
  )
}
