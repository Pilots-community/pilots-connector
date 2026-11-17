/**
 * The projection: a definition, drawn.
 *
 * The rule under test throughout is that the diagram is derived and never the
 * source — so every element of the definition must be findable in it, and
 * drawing must never change the document.
 */
import { describe, expect, it } from 'vitest'

import { toDiagram } from '../src/project.js'
import { small } from './helpers/small.js'

const keys = (items: { key: string }[]): string[] => items.map((one) => one.key)

describe('roles and states', () => {
  it('draws one lane per role, in the order the definition lists them', () => {
    const model = toDiagram(small())
    expect(model.lanes.map((lane) => lane.roleId)).toEqual(['alpha', 'beta'])
    expect(model.lanes[0]).toMatchObject({ key: 'lane:alpha', title: 'Alpha', multiple: false })
  })

  it('marks a role several participants fill', () => {
    const document = small()
    document.roles[0]!.cardinality = 3
    expect(toDiagram(document).lanes[0]!.multiple).toBe(true)
  })

  it('draws the initial state as a start, an ending as an end carrying its outcome', () => {
    const nodes = toDiagram(small()).nodes
    expect(nodes.find((n) => n.key === 'state:OPEN')).toMatchObject({ kind: 'start', lane: null })
    expect(nodes.find((n) => n.key === 'state:DONE')).toMatchObject({ kind: 'end', markers: ['fulfilled'] })
    expect(nodes.find((n) => n.key === 'state:DROPPED')).toMatchObject({ kind: 'end', markers: ['abandoned'] })
  })

  it('draws any other state as an intermediate event', () => {
    const document = small()
    document.states.push({ id: 'WAITING', title: 'Waiting' })
    expect(toDiagram(document).nodes.find((n) => n.key === 'state:WAITING')?.kind).toBe('state')
  })
})

describe('tasks', () => {
  it('draws one task per role that may fire the transition, in that role’s lane', () => {
    const nodes = toDiagram(small()).nodes.filter((n) => n.kind === 'task')
    expect(keys(nodes)).toEqual(['task:finish@beta', 'task:drop@alpha', 'task:drop@beta'])
    expect(nodes[1]).toMatchObject({ lane: 'alpha', ref: { kind: 'transition', id: 'drop' } })
  })

  it('draws a wildcard as one marker, not an arrow from every state', () => {
    const model = toDiagram(small())
    expect(model.nodes.find((n) => n.key === 'task:drop@alpha')?.markers).toContain('any-state')
    expect(model.edges.filter((e) => e.target === 'task:drop@alpha')).toEqual([])
  })

  it('connects a state straight to its only way out, and the task to where it leads', () => {
    const edges = toDiagram(small()).edges.map((e) => `${e.source}->${e.target}`)
    expect(edges).toContain('state:OPEN->task:finish@beta')
    expect(edges).toContain('task:finish@beta->state:DONE')
  })

  it('draws a pure data update as an arrow back to where it came from', () => {
    const document = small()
    document.transitions.push({ id: 'annotate', title: 'Annotate', from: ['OPEN'], by: ['alpha'] })
    const model = toDiagram(document)
    expect(model.nodes.find((n) => n.key === 'task:annotate@alpha')?.markers).toContain('update')
    expect(model.edges.map((e) => `${e.source}->${e.target}`)).toContain('task:annotate@alpha->state:OPEN')
  })

  it('puts a derived gateway after a state with more than one way out', () => {
    const document = small()
    document.transitions.push({ id: 'review', title: 'Review', from: ['OPEN'], to: 'DONE', by: ['alpha'] })
    const model = toDiagram(document)
    const gateway = model.nodes.find((n) => n.key === 'gateway:OPEN')
    expect(gateway).toMatchObject({ kind: 'gateway', ref: null })
    const out = model.edges.filter((e) => e.source === 'gateway:OPEN').map((e) => e.target)
    expect(out).toEqual(['task:finish@beta', 'task:review@alpha'])
    expect(model.edges.map((e) => `${e.source}->${e.target}`)).toContain('state:OPEN->gateway:OPEN')
  })

  it('marks every node and edge as shared — the only layer that exists today', () => {
    const model = toDiagram(small())
    expect(new Set([...model.nodes, ...model.edges].map((one) => one.layer))).toEqual(new Set(['shared']))
  })

  it('never changes the document it draws', () => {
    const document = small()
    const before = JSON.stringify(document)
    toDiagram(deepFreeze(document))
    expect(JSON.stringify(document)).toBe(before)
  })
})

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}
