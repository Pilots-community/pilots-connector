/**
 * Transitions the runtime fires: no lane, because the connector is not a
 * participant. A timer or a message *is* the transition when nobody may fire it
 * by hand, and points at the task when somebody also may (B3).
 */
import { describe, expect, it } from 'vitest'

import type { DefinitionDocument } from '../src/document.js'
import { toDiagram } from '../src/project.js'
import { small } from './helpers/small.js'

const arrows = (document: DefinitionDocument): string[] =>
  toDiagram(document).edges.map((e) => `${e.source}->${e.target}`)

/** OPEN → (propose) → WAITING; a deadline on `propose` lapses into DROPPED. */
function withDeadline(): DefinitionDocument {
  const document = small()
  document.states.push({ id: 'WAITING', title: 'Waiting' })
  document.transitions.push(
    { id: 'propose', title: 'Propose', from: ['OPEN'], to: 'WAITING', by: ['beta'], deadline: 'PT1H', onDeadline: 'lapse' },
    { id: 'settle', title: 'Settle', from: ['WAITING'], to: 'DONE', by: ['alpha'] },
    { id: 'lapse', title: 'Lapse', from: ['WAITING'], to: 'DROPPED', by: [] },
  )
  return document
}

describe('timers', () => {
  it('waits in the state the deadline arms in and is the transition it fires', () => {
    const model = toDiagram(withDeadline())
    expect(model.nodes.find((n) => n.key === 'timer:propose')).toMatchObject({
      kind: 'timer',
      label: 'PT1H',
      lane: null,
      ref: { kind: 'transition', id: 'propose' },
    })
    expect(model.nodes.some((n) => n.key.startsWith('task:lapse'))).toBe(false)
    const lapse = model.edges.find((e) => e.source === 'timer:propose')
    expect(lapse).toMatchObject({ target: 'state:DROPPED', ref: { kind: 'transition', id: 'lapse' } })
  })

  it('races the people who may act there, behind one gateway', () => {
    const out = toDiagram(withDeadline()).edges.filter((e) => e.source === 'gateway:WAITING')
    expect(out.map((e) => e.target)).toEqual(['task:settle@alpha', 'timer:propose'])
  })

  it('points at the task when the transition it fires is one people may also fire', () => {
    const document = withDeadline()
    document.transitions[2]!.onDeadline = 'drop'
    expect(arrows(document)).toContain('timer:propose->task:drop@alpha')
  })
})

describe('messages', () => {
  function linked(): DefinitionDocument {
    const document = small()
    document.transitions.push({ id: 'begin', title: 'Begin', from: ['OPEN'], to: 'DONE', by: [] })
    document.links = [
      { onEvent: 'quotation:AGREED', triggers: 'begin' },
      { onEvent: 'quotation:REJECTED', triggers: 'drop' },
    ]
    return document
  }

  it('is the transition a link fires when nobody may fire it by hand', () => {
    const model = toDiagram(linked())
    expect(model.nodes.find((n) => n.key === 'message:begin#0')).toMatchObject({
      kind: 'message',
      label: 'quotation:AGREED',
      ref: { kind: 'link', index: 0 },
    })
    expect(arrows(linked())).toContain('message:begin#0->state:DONE')
  })

  it('points at the task when people may fire it too, and carries the wildcard', () => {
    const model = toDiagram(linked())
    expect(model.nodes.find((n) => n.key === 'message:drop#0')?.markers).toContain('any-state')
    expect(arrows(linked())).toContain('message:drop#0->task:drop@alpha')
  })
})

describe('automatic and unfireable', () => {
  it('draws an automatic step nobody fires as an arrow, not a task', () => {
    const document = small()
    document.transitions.push({ id: 'skip', title: 'Skip', from: ['OPEN'], to: 'DONE', by: [], auto: true })
    const model = toDiagram(document)
    expect(model.nodes.some((n) => n.key.startsWith('task:skip'))).toBe(false)
    const arrow = model.edges.find((e) => e.ref?.kind === 'transition' && e.ref.id === 'skip')
    expect(arrow).toMatchObject({ label: 'Skip', markers: ['auto'] })
  })

  it('marks an automatic task somebody may also fire', () => {
    const document = small()
    document.transitions[0]!.auto = true
    expect(toDiagram(document).nodes.find((n) => n.key === 'task:finish@beta')?.markers).toContain('auto')
  })

  it('still draws a transition nothing can fire, outside every lane, rather than dropping it', () => {
    const document = small()
    document.transitions.push({ id: 'stuck', title: 'Stuck', from: ['OPEN'], to: 'DONE', by: [] })
    expect(toDiagram(document).nodes.find((n) => n.key === 'task:stuck')).toMatchObject({
      lane: null,
      markers: ['unfireable'],
    })
  })
})
