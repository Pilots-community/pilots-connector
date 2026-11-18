/**
 * A linter diagnostic, placed on the canvas.
 *
 * The graph rules emit one diagnostic per offending state with a JSON Pointer,
 * precisely so an editor can outline the node at fault rather than print a
 * list. Anything not about a role, state, transition or link belongs to the
 * process as a whole.
 */
import { parsePointer } from './commands/pointer.js'
import type { DefinitionDocument } from './document.js'
import { laneKey, type DiagramModel, type ElementRef } from './model.js'

export type DiagnosticTarget = { kind: 'node' | 'edge' | 'lane'; key: string } | { kind: 'process' }

const PROCESS: DiagnosticTarget = { kind: 'process' }

export function targetOf(
  document: DefinitionDocument,
  model: DiagramModel,
  pointer: string | undefined,
): DiagnosticTarget {
  const segments = pointer === undefined ? null : parsePointer(pointer)
  if (segments === null || segments.length < 2) return PROCESS
  const [collection, position] = segments
  const index = Number(position)

  const drawn = (match: (ref: ElementRef) => boolean): DiagnosticTarget => {
    const node = model.nodes.find((one) => one.ref !== null && match(one.ref))
    if (node !== undefined) return { kind: 'node', key: node.key }
    const edge = model.edges.find((one) => one.ref !== null && match(one.ref))
    return edge === undefined ? PROCESS : { kind: 'edge', key: edge.key }
  }

  switch (collection) {
    case 'roles': {
      const role = document.roles[index]
      return role === undefined ? PROCESS : { kind: 'lane', key: laneKey(role.id) }
    }
    case 'states': {
      const state = document.states[index]
      return state === undefined ? PROCESS : drawn((ref) => ref.kind === 'state' && ref.id === state.id)
    }
    case 'transitions': {
      const transition = document.transitions[index]
      return transition === undefined
        ? PROCESS
        : drawn((ref) => ref.kind === 'transition' && ref.id === transition.id)
    }
    case 'links':
      return drawn((ref) => ref.kind === 'link' && ref.index === index)
    default:
      return PROCESS
  }
}
