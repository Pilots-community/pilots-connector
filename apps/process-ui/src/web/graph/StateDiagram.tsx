/**
 * The process, drawn — and, when given a history, the path actually walked.
 *
 * Mounted read-only: `nodesDraggable` and `nodesConnectable` are off, so this is
 * a picture. Iteration 2 turns both on and adds `onConnect` plus a properties
 * panel; the model underneath (`toGraph`) is already the one an editor mutates,
 * which is why React Flow was chosen over a hand-rolled SVG.
 */
import { Background, Controls, ReactFlow, type Edge, type Node } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useMemo } from 'react'

import type { ProcessDefinition, SignedEvent } from '../api.js'
import { positionOf } from './layout.js'
import { ANY_STATE_NODE, toGraph } from './to-graph.js'

export function StateDiagram({
  definition,
  history,
  current,
  height = 'h-64',
}: {
  definition: ProcessDefinition
  history?: readonly SignedEvent[]
  current?: string
  height?: string
}) {
  const { nodes, edges } = useMemo(
    () =>
      toGraph(definition, {
        ...(history ? { history } : {}),
        ...(current ? { current } : {}),
      }),
    [definition, history, current],
  )

  const flowNodes: Node[] = useMemo(() => {
    const seen = new Map<string, number>()
    return nodes.map((node) => {
      const index = seen.get(node.lane) ?? 0
      seen.set(node.lane, index + 1)
      return {
        id: node.id,
        position: positionOf(node, node.lane === 'off-path' ? index : 0),
        data: { label: node.id === ANY_STATE_NODE ? 'any state' : node.title },
        draggable: false,
        /*
         * Classes rather than inline hex, so the diagram follows the app into
         * dark mode. Three weights — where you are, where you have been, and
         * where you might still go — so the current state is findable at a
         * glance from the back of a room.
         */
        className: [
          'rounded-md border px-2 py-1 text-[11px] text-center w-[150px]',
          node.kind === 'any-state' ? 'border-dashed' : '',
          node.current
            ? 'border-2 border-sky-500 bg-sky-500 text-white font-medium'
            : node.reached
              ? 'border-slate-400 bg-slate-200 text-slate-900 dark:border-slate-500 dark:bg-slate-700 dark:text-slate-100'
              : 'border-slate-300 bg-white text-slate-400 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-500',
        ]
          .filter(Boolean)
          .join(' '),
      }
    })
  }, [nodes])

  const flowEdges: Edge[] = useMemo(
    () =>
      edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        label: edge.title,
        style: {
          strokeWidth: edge.taken ? 2.5 : 1,
          // `currentColor` would follow the page, but React Flow paints edges in
          // an SVG layer of its own, so these two are picked to read on either
          // background rather than to match one.
          stroke: edge.taken ? '#0ea5e9' : '#64748b',
          // A wildcard is dashed: not a step in the flow so much as an escape
          // available from anywhere.
          ...(edge.wildcard ? { strokeDasharray: '4 4' } : {}),
        },
        labelShowBg: false,
        labelStyle: { fontSize: 9, fill: edge.taken ? '#0ea5e9' : '#94a3b8' },
      })),
    [edges],
  )

  return (
    <div
      data-testid="state-diagram"
      className={`${height} w-full rounded-lg border border-slate-200 dark:border-slate-800`}
    >
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        fitView
        fitViewOptions={{ padding: 0.15 }}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        colorMode="system"
        minZoom={0.2}
      >
        <Background />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  )
}
