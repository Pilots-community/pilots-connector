/**
 * A definition, as a BPMN-style diagram.
 *
 * Plain data, nothing React Flow-shaped, so the projection is unit-tested and a
 * third party's UI can draw it with whatever it likes.
 *
 * Every node and edge carries a `ref` to the definition element behind it, and
 * a `layer`. Only `shared` exists today; a participant's private tasks arrive as
 * `private` nodes from a separate artefact, without touching the definition
 * (B7 in the design record).
 */
export type Layer = 'shared' | 'private'

export type ElementRef =
  | { kind: 'role'; id: string }
  | { kind: 'state'; id: string }
  | { kind: 'transition'; id: string }
  | { kind: 'link'; index: number }

export type NodeKind = 'start' | 'state' | 'end' | 'task' | 'timer' | 'message' | 'gateway'

export type Marker = 'fulfilled' | 'abandoned' | 'auto' | 'any-state' | 'update' | 'unfireable'

export interface DiagramLane {
  key: string
  roleId: string
  title: string
  /** `cardinality > 1`: several participants fill this role. */
  multiple: boolean
}

export interface DiagramNode {
  key: string
  kind: NodeKind
  label: string
  /** The role whose lane this is in. `null` for states and events: their lane is layout only. */
  lane: string | null
  /** `null` only for derived nodes — gateways — which have nothing behind them to edit. */
  ref: ElementRef | null
  layer: Layer
  markers: Marker[]
}

export interface DiagramEdge {
  key: string
  source: string
  target: string
  label: string | null
  ref: ElementRef | null
  layer: Layer
  markers: Marker[]
}

export interface DiagramModel {
  lanes: DiagramLane[]
  nodes: DiagramNode[]
  edges: DiagramEdge[]
}

/*
 * Keys are derived from ids, so they are stable across renders and a saved
 * layout survives an edit. A rename rewrites them (`renameLayoutKeys`).
 */
export const laneKey = (role: string): string => `lane:${role}`
export const stateKey = (state: string): string => `state:${state}`
export const taskKey = (transition: string, role?: string): string =>
  role === undefined ? `task:${transition}` : `task:${transition}@${role}`
export const timerKey = (transition: string): string => `timer:${transition}`
export const messageKey = (transition: string, occurrence: number): string =>
  `message:${transition}#${occurrence}`
export const gatewayKey = (state: string): string => `gateway:${state}`
