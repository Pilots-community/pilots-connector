/**
 * BPMN shapes as React Flow nodes. Classes, not hex, so they follow dark mode.
 *
 * Only states and gateways are connectable: an arrow drawn from one state to
 * another is the gesture that adds a task between them.
 */
import type { DiagramNode } from '@pilots/bpmn'
import { Handle, Position, type NodeProps } from '@xyflow/react'

const MARK: Record<string, string> = { auto: '⚙', 'any-state': '✱', update: '↺', unfireable: '⚠' }
const surface = 'border-slate-500 bg-white text-slate-900 dark:bg-slate-900 dark:text-slate-100'

export function BpmnNode({ data, selected }: NodeProps) {
  const { node, flagged } = data as { node: DiagramNode; flagged: boolean }
  const ring = flagged ? 'ring-2 ring-rose-500' : selected ? 'ring-2 ring-sky-500' : ''
  const connectable = node.kind === 'start' || node.kind === 'state' || node.kind === 'end' || node.kind === 'gateway'
  return (
    <div data-node={node.key} className="flex flex-col items-center">
      <Handle type="target" position={Position.Left} isConnectable={connectable} />
      <Shape node={node} ring={ring} />
      <Handle type="source" position={Position.Right} isConnectable={connectable && node.kind !== 'end'} />
    </div>
  )
}

function Shape({ node, ring }: { node: DiagramNode; ring: string }) {
  const marks = node.markers.map((marker) => MARK[marker]).filter(Boolean).join(' ')
  if (node.kind === 'task') {
    return (
      <div className={`flex h-14 w-32 items-center justify-center rounded-lg border px-2 text-center text-[11px] ${surface} ${ring}`}>
        {marks !== '' && <span className="mr-1">{marks}</span>}
        {node.label}
      </div>
    )
  }
  if (node.kind === 'gateway') {
    return (
      <div className={`h-9 w-9 rotate-45 border ${surface} ${ring}`}>
        <div className="m-2 h-4 w-4 rounded-full border border-slate-500" />
      </div>
    )
  }
  const border = node.kind === 'start' ? 'border' : node.kind === 'end' ? 'border-4' : 'border-4 border-double'
  const icon =
    node.kind === 'timer'
      ? '⏱'
      : node.kind === 'message'
        ? '✉'
        : node.markers.includes('abandoned')
          ? '✕'
          : node.markers.includes('fulfilled')
            ? '✓'
            : marks
  return (
    <div className="flex flex-col items-center">
      <div className={`flex h-9 w-9 items-center justify-center rounded-full text-xs ${border} ${surface} ${ring}`}>{icon}</div>
      <span className="mt-1 max-w-28 text-center text-[10px]">{node.label}</span>
    </div>
  )
}

export function LaneNode({ data }: NodeProps) {
  const { title, multiple, flagged } = data as { title: string; multiple: boolean; flagged: boolean }
  return (
    <div className={`h-full w-full border-b border-slate-200 dark:border-slate-700 ${flagged ? 'bg-rose-50 dark:bg-rose-950/30' : ''}`}>
      <div className="flex h-full w-28 items-center justify-center border-r border-slate-200 bg-slate-50 text-xs font-medium dark:border-slate-700 dark:bg-slate-800">
        {title}
        {multiple ? ' ⫴' : ''}
      </div>
    </div>
  )
}
