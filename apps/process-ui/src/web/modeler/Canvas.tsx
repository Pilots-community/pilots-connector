/**
 * The canvas. Positions are the author's and never touch the definition; the
 * two gestures that do — a task dropped in another lane, an arrow between two
 * states — are reported up as intents and become commands in the Modeler.
 */
import type { DiagramLayout, DiagramModel } from '@pilots/bpmn'
import {
  Background,
  Controls,
  MarkerType,
  ReactFlow,
  useNodesState,
  type Connection,
  type Node,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useEffect, useMemo } from 'react'

import { laneChange, stateOfKey, toFlow } from './flow.js'
import { BpmnNode, LaneNode } from './shapes.js'

const nodeTypes = { bpmn: BpmnNode, lane: LaneNode }

/**
 * Carry React Flow's own bookkeeping across a re-projection. Replacing nodes wholesale would wipe
 * `selected` and `measured` on every edit, and snap back a node that is mid-drag when a lint
 * result or a new `flagged` set arrives.
 */
function mergeNodes(previous: Node[], next: Node[]): Node[] {
  return next.map((fresh) => {
    const old = previous.find((one) => one.id === fresh.id)
    if (old === undefined) return fresh
    return {
      ...fresh,
      selected: old.selected,
      measured: old.measured,
      ...(old.dragging === true ? { position: old.position, dragging: true } : {}),
    }
  })
}

export interface CanvasProps {
  model: DiagramModel
  layout: DiagramLayout
  flagged: ReadonlySet<string>
  readOnly: boolean
  onMove: (key: string, x: number, y: number) => void
  onMoveTask: (change: { transition: string; fromRole: string; toRole: string }) => void
  onConnectStates: (from: string, to: string) => void
  onSelect: (key: string | null) => void
  /** Fill the parent's height (full screen) instead of a share of the window's. */
  fill?: boolean
}

export function Canvas(props: CanvasProps) {
  const { model, layout, flagged, readOnly } = props
  const flow = useMemo(
    () => toFlow(model, layout, { flagged, readOnly }),
    [model, layout, flagged, readOnly],
  )
  // React Flow moves a dragged node through its own state; the definition is untouched until the drop.
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>(flow.nodes)
  useEffect(() => setNodes((previous) => mergeNodes(previous, flow.nodes)), [flow.nodes, setNodes])

  const edges = useMemo(
    () =>
      flow.edges.map((edge) => ({
        ...edge,
        markerEnd: { type: MarkerType.ArrowClosed },
        // React Flow paints edges in its own SVG layer, so these read on either background.
        style: { stroke: (edge.data as { flagged: boolean }).flagged ? '#e11d48' : '#64748b' },
        labelShowBg: false,
        labelStyle: { fontSize: 9, fill: '#94a3b8' },
      })),
    [flow.edges],
  )
  const byKey = useMemo(() => new Map(model.nodes.map((node) => [node.key, node])), [model])

  return (
    <div
      data-testid="modeler-canvas"
      className={`${props.fill ? 'h-full min-h-[24rem]' : 'h-[75vh] min-h-[32rem]'} w-full rounded-lg border border-slate-200 dark:border-slate-800`}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        fitView
        fitViewOptions={{ padding: 0.1 }}
        colorMode="system"
        minZoom={0.2}
        nodesDraggable={!readOnly}
        nodesConnectable={!readOnly}
        elementsSelectable
        onNodeDragStop={(_event, node) => {
          const dropped = byKey.get(node.id)
          if (dropped === undefined) return
          const change = laneChange(dropped, node.position.y, model)
          if (change === null) {
            props.onMove(node.id, node.position.x, node.position.y)
            return
          }
          // A lane change renames the node's key, so no position is saved under the old one. Snap the
          // node back to the projection: a refused move stays put, an accepted one is re-projected
          // into its new lane by the parent.
          props.onMoveTask(change)
          const home = flow.nodes.find((one) => one.id === node.id)
          if (home !== undefined) {
            setNodes((previous) =>
              previous.map((one) =>
                one.id === node.id ? { ...one, position: home.position, dragging: false } : one,
              ),
            )
          }
        }}
        onConnect={(connection: Connection) => {
          const from = stateOfKey(connection.source)
          const to = stateOfKey(connection.target)
          if (from !== null && to !== null) props.onConnectStates(from, to)
        }}
        onNodeClick={(_event, node) => props.onSelect(node.id)}
        onEdgeClick={(_event, edge) => props.onSelect(edge.id)}
        onPaneClick={() => props.onSelect(null)}
      >
        <Background />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  )
}
