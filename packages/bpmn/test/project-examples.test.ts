/**
 * The five committed definitions, drawn — the proof nothing is dropped.
 *
 * Every element must be findable in the diagram by its `ref`, and drawing must
 * leave the document byte-identical, so its `definitionHash` cannot move.
 */
import { hashJson } from '@pilots/protocol'
import { describe, expect, it } from 'vitest'

import type { DiagramModel, ElementRef } from '../src/model.js'
import { toDiagram } from '../src/project.js'
import { examples } from './helpers/examples.js'

const refers = (model: DiagramModel, match: (ref: ElementRef) => boolean): boolean =>
  [...model.nodes, ...model.edges].some((one) => one.ref !== null && match(one.ref))

describe.each(examples())('$name', ({ document }) => {
  const model = toDiagram(document)

  it('draws every role as a lane', () => {
    expect(model.lanes.map((lane) => lane.roleId)).toEqual(document.roles.map((role) => role.id))
  })

  it('draws every state', () => {
    for (const state of document.states) {
      expect(refers(model, (ref) => ref.kind === 'state' && ref.id === state.id)).toBe(true)
    }
  })

  it('draws every transition, as a task, an event or an arrow', () => {
    for (const transition of document.transitions) {
      expect(refers(model, (ref) => ref.kind === 'transition' && ref.id === transition.id), transition.id).toBe(true)
    }
  })

  it('draws every deadline as a timer and every link as a message', () => {
    for (const transition of document.transitions.filter((one) => one.deadline !== undefined)) {
      expect(model.nodes.some((n) => n.key === `timer:${transition.id}`)).toBe(true)
    }
    for (const [index] of (document.links ?? []).entries()) {
      expect(refers(model, (ref) => ref.kind === 'link' && ref.index === index)).toBe(true)
    }
  })

  it('marks every automatic transition and every wildcard', () => {
    for (const transition of document.transitions) {
      const drawn = [...model.nodes, ...model.edges].filter(
        (one) => one.ref?.kind === 'transition' && one.ref.id === transition.id,
      )
      if (transition.auto === true) expect(drawn.some((one) => one.markers.includes('auto'))).toBe(true)
      if (transition.from.includes('*') && transition.by.length > 0) {
        expect(drawn.some((one) => one.markers.includes('any-state'))).toBe(true)
      }
    }
  })

  it('leaves the document — and therefore its hash — exactly as it was', () => {
    const before = hashJson(document)
    toDiagram(document)
    expect(hashJson(document)).toBe(before)
  })
})
