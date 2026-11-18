/**
 * A definition, drawn as BPMN — states as events, transitions as tasks.
 *
 * BPMN is task-centric and a definition is state-centric, so the mapping is:
 * a role is a lane, a transition is a task in the lane of each role allowed to
 * fire it, a state is an event between tasks, and an ending is an end event
 * carrying its outcome. More than one way out of a state gets an event-based
 * gateway — "whoever acts first" — which is derived and never stored.
 *
 * Nothing here is ever parsed back: edits are commands on the definition, and
 * the diagram is projected again. That is what keeps the round trip lossless.
 */
import { ANY_STATE, type DefinitionDocument, type TransitionDocument } from './document.js'
import {
  gatewayKey,
  laneKey,
  messageKey,
  stateKey,
  taskKey,
  timerKey,
  type DiagramEdge,
  type DiagramModel,
  type DiagramNode,
  type ElementRef,
  type Marker,
} from './model.js'

/** A way out of a state, collected first so a state with several gets a gateway. */
interface Exit {
  state: string
  target: string
  ref: ElementRef
  label: string | null
  markers: Marker[]
}

export function toDiagram(document: DefinitionDocument): DiagramModel {
  const lanes = document.roles.map((role) => ({
    key: laneKey(role.id),
    roleId: role.id,
    title: role.title,
    multiple: (role.cardinality ?? 1) > 1,
  }))

  const nodes: DiagramNode[] = document.states.map((state) => ({
    key: stateKey(state.id),
    kind:
      state.id === document.initialState ? 'start' : state.outcome === undefined ? 'state' : 'end',
    label: state.title,
    lane: null,
    ref: { kind: 'state', id: state.id },
    layer: 'shared',
    markers: state.outcome === undefined ? [] : [state.outcome],
  }))

  const exits: Exit[] = []
  const edges: DiagramEdge[] = []
  const edge = (
    source: string,
    target: string,
    ref: ElementRef | null,
    label: string | null = null,
    markers: Marker[] = [],
  ): void => {
    edges.push({ key: `${source}->${target}`, source, target, label, ref, layer: 'shared', markers })
  }

  const links = document.links ?? []
  const byId = new Map(document.transitions.map((one) => [one.id, one]))
  const isTriggered = (transition: TransitionDocument): boolean =>
    document.transitions.some((one) => one.onDeadline === transition.id && one.deadline !== undefined) ||
    links.some((link) => link.triggers === transition.id)

  for (const transition of document.transitions) {
    const markers = markersOf(transition)
    const wildcard = transition.from.includes(ANY_STATE)

    if (transition.by.length > 0) {
      for (const role of transition.by) {
        const key = taskKey(transition.id, role)
        nodes.push({ key, kind: 'task', label: transition.title, lane: role, ref: refOf(transition), layer: 'shared', markers })
        for (const state of sourcesOf(transition)) {
          exits.push({ state, target: key, ref: refOf(transition), label: null, markers: [] })
        }
        for (const state of targetsOf(transition)) edge(key, stateKey(state), refOf(transition))
      }
      continue
    }

    const to = transition.to
    if (transition.auto === true && !wildcard && to !== undefined) {
      // A step nobody takes: the arrow is the transition.
      for (const state of sourcesOf(transition)) {
        exits.push({ state, target: stateKey(to), ref: refOf(transition), label: transition.title, markers: ['auto'] })
      }
      continue
    }

    if (transition.auto === true || !isTriggered(transition)) {
      // Outside every lane, because no role fires it. If nothing fires it at all
      // the linter says so; it is still drawn, because a projection that drops
      // what it cannot place is not lossless.
      const key = taskKey(transition.id)
      nodes.push({
        key,
        kind: 'task',
        label: transition.title,
        lane: null,
        ref: refOf(transition),
        layer: 'shared',
        markers: transition.auto === true ? markers : [...markers, 'unfireable'],
      })
      for (const state of sourcesOf(transition)) {
        exits.push({ state, target: key, ref: refOf(transition), label: null, markers: [] })
      }
      for (const state of targetsOf(transition)) edge(key, stateKey(state), refOf(transition))
    }
    // Otherwise a timer or a message fires it, and the event nodes below are the transition.
  }

  // Timers. A deadline belongs to the transition that *enters* a state: it arms on
  // entry into `to`, so the timer waits there, keyed by the transition that armed it.
  for (const arming of document.transitions) {
    if (arming.deadline === undefined) continue
    const key = timerKey(arming.id)
    nodes.push({ key, kind: 'timer', label: arming.deadline, lane: null, ref: refOf(arming), layer: 'shared', markers: [] })
    if (arming.to !== undefined) {
      exits.push({ state: arming.to, target: key, ref: refOf(arming), label: null, markers: [] })
    }
    const fired = arming.onDeadline === undefined ? undefined : byId.get(arming.onDeadline)
    if (fired === undefined) continue
    const firstRole = fired.by[0]
    if (firstRole !== undefined) {
      edge(key, taskKey(fired.id, firstRole), refOf(fired))
      continue
    }
    const lands = fired.to ?? arming.to
    if (lands !== undefined) edge(key, stateKey(lands), refOf(fired))
  }

  // Messages: a signed event in a linked instance.
  const occurrences = new Map<string, number>()
  links.forEach((link, index) => {
    const occurrence = occurrences.get(link.triggers) ?? 0
    occurrences.set(link.triggers, occurrence + 1)
    const key = messageKey(link.triggers, occurrence)
    const fired = byId.get(link.triggers)
    nodes.push({
      key,
      kind: 'message',
      label: link.onEvent,
      lane: null,
      ref: { kind: 'link', index },
      layer: 'shared',
      markers: fired?.from.includes(ANY_STATE) === true ? ['any-state'] : [],
    })
    if (fired === undefined) return
    const firstRole = fired.by[0]
    if (firstRole !== undefined) {
      edge(key, taskKey(fired.id, firstRole), refOf(fired))
      return
    }
    // Nobody fires it by hand, so the message is the transition: it waits where
    // the transition may be applied, and leads where it leads.
    for (const state of sourcesOf(fired)) {
      exits.push({ state, target: key, ref: refOf(fired), label: null, markers: [] })
    }
    for (const state of targetsOf(fired)) edge(key, stateKey(state), refOf(fired))
  })

  connectExits(exits, nodes, edge)
  return { lanes, nodes, edges: settle(nodes, edges) }
}

export function refOf(transition: TransitionDocument): ElementRef {
  return { kind: 'transition', id: transition.id }
}

/** Where a transition may be applied. A wildcard has no arrows: it is a marker instead. */
export function sourcesOf(transition: TransitionDocument): string[] {
  return transition.from.includes(ANY_STATE) ? [] : transition.from
}

/** Where a transition leads: its `to`, or back where it came from for a pure data update. */
export function targetsOf(transition: TransitionDocument): string[] {
  return transition.to === undefined ? sourcesOf(transition) : [transition.to]
}

function markersOf(transition: TransitionDocument): Marker[] {
  const markers: Marker[] = []
  if (transition.from.includes(ANY_STATE)) markers.push('any-state')
  if (transition.auto === true) markers.push('auto')
  if (transition.to === undefined) markers.push('update')
  return markers
}

/** One way out: a straight arrow. More: a derived gateway that fans out. */
function connectExits(
  exits: Exit[],
  nodes: DiagramNode[],
  edge: (s: string, t: string, r: ElementRef | null, l?: string | null, m?: Marker[]) => void,
): void {
  const byState = new Map<string, Exit[]>()
  for (const exit of exits) byState.set(exit.state, [...(byState.get(exit.state) ?? []), exit])
  for (const [state, list] of byState) {
    const only = list.length === 1 ? list[0] : undefined
    if (only !== undefined) {
      edge(stateKey(state), only.target, only.ref, only.label, only.markers)
      continue
    }
    const gateway = gatewayKey(state)
    nodes.push({ key: gateway, kind: 'gateway', label: '', lane: null, ref: null, layer: 'shared', markers: [] })
    edge(stateKey(state), gateway, null)
    for (const exit of list) edge(gateway, exit.target, exit.ref, exit.label, exit.markers)
  }
}

/**
 * Drop edges to nodes that do not exist and make keys unique.
 *
 * A draft may name a state nobody declared — the JSON tab allows it, and the
 * linter reports it. Drawing must not fail on a draft the linter would explain.
 */
function settle(nodes: DiagramNode[], edges: DiagramEdge[]): DiagramEdge[] {
  const present = new Set(nodes.map((node) => node.key))
  const seen = new Map<string, number>()
  return edges
    .filter((one) => present.has(one.source) && present.has(one.target))
    .map((one) => {
      const count = seen.get(one.key) ?? 0
      seen.set(one.key, count + 1)
      return count === 0 ? one : { ...one, key: `${one.key}#${count}` }
    })
}
