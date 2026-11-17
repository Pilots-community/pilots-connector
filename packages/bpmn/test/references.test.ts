/**
 * Renaming by hand in JSON is exactly where a definition breaks: one `from`
 * forgotten and the linter is the first to notice. A rename here follows every
 * reference; a removal either refuses and says what still depends on it, or —
 * when asked — removes those too, never leaving a dangling reference and never
 * widening who may read what.
 */
import { canonicalise } from '@pilots/protocol'
import { describe, expect, it } from 'vitest'

import { applyCommand } from '../src/commands/apply.js'
import type { Command } from '../src/commands/types.js'
import type { DefinitionDocument } from '../src/document.js'
import { examples } from './helpers/examples.js'
import { small } from './helpers/small.js'

function apply(document: DefinitionDocument, command: Command): DefinitionDocument {
  const result = applyCommand(document, command)
  if (!result.ok) throw new Error(result.error.message)
  return result.document
}

/** small(), with a reference of every kind to rename through. */
function rich(): DefinitionDocument {
  const document = small()
  document.createdBy = ['alpha']
  document.states.push({ id: 'WAITING', title: 'Waiting' })
  document.transitions.push(
    { id: 'wait', title: 'Wait', from: ['OPEN'], to: 'WAITING', by: ['alpha'], deadline: 'PT1H', onDeadline: 'lapse' },
    { id: 'lapse', title: 'Lapse', from: ['WAITING'], to: 'DROPPED', by: [] },
    { id: 'resume', title: 'Resume', from: ['WAITING', 'OPEN'], to: 'DONE', by: ['beta'] },
  )
  document.visibility = [
    { path: 'note', roles: ['alpha'], whenState: ['WAITING'] },
    { path: 'note', roles: ['alpha', 'beta'] },
  ]
  document.links = [{ onEvent: 'quotation:AGREED', triggers: 'lapse' }]
  return document
}

describe('rename', () => {
  it('follows a role through hostedBy, createdBy, by and visibility', () => {
    const next = apply(rich(), { type: 'rename', kind: 'role', from: 'alpha', to: 'gamma' })
    const text = JSON.stringify(next)
    expect(text).not.toContain('"alpha"')
    expect(next.createdBy).toEqual(['gamma'])
    expect(next.transitions.find((t) => t.id === 'wait')?.by).toEqual(['gamma'])
    expect(next.visibility?.[1]?.roles).toEqual(['gamma', 'beta'])
  })

  it('follows a state through initialState, from, to and whenState — but not a linked instance’s event', () => {
    const renamed = apply(rich(), { type: 'rename', kind: 'state', from: 'WAITING', to: 'PAUSED' })
    expect(renamed.transitions.find((t) => t.id === 'resume')?.from).toEqual(['PAUSED', 'OPEN'])
    expect(renamed.visibility?.[0]?.whenState).toEqual(['PAUSED'])
    const initial = apply(rich(), { type: 'rename', kind: 'state', from: 'OPEN', to: 'READY' })
    expect(initial.initialState).toBe('READY')
    // `onEvent` names a state of *another* definition; it is not ours to rename.
    expect(apply(rich(), { type: 'rename', kind: 'state', from: 'DONE', to: 'AGREED' }).links?.[0]?.onEvent).toBe(
      'quotation:AGREED',
    )
  })

  it('follows a transition through onDeadline and links', () => {
    const next = apply(rich(), { type: 'rename', kind: 'transition', from: 'lapse', to: 'expire' })
    expect(next.transitions.find((t) => t.id === 'wait')?.onDeadline).toBe('expire')
    expect(next.links?.[0]?.triggers).toBe('expire')
  })

  it('refuses a name already taken or malformed, and accepts the same name as a no-op', () => {
    expect(applyCommand(rich(), { type: 'rename', kind: 'role', from: 'alpha', to: 'beta' }).ok).toBe(false)
    expect(applyCommand(rich(), { type: 'rename', kind: 'state', from: 'OPEN', to: '9' }).ok).toBe(false)
    expect(applyCommand(rich(), { type: 'rename', kind: 'state', from: 'OPEN', to: 'OPEN' }).ok).toBe(true)
  })

  it.each(examples())('renamed and renamed back, $name is byte-identical', ({ document }) => {
    const bytes = (d: DefinitionDocument): string => canonicalise(d)
    for (const [kind, id] of [
      ['role', document.roles[0]!.id],
      ['state', document.states[0]!.id],
      ['transition', document.transitions[0]!.id],
    ] as const) {
      const there = apply(document, { type: 'rename', kind, from: id, to: 'zzRenamed' })
      expect(bytes(apply(there, { type: 'rename', kind, from: 'zzRenamed', to: id }))).toBe(bytes(document))
    }
  })
})

describe('remove', () => {
  it('refuses while something depends on the element, and says what', () => {
    const result = applyCommand(rich(), { type: 'remove', kind: 'transition', id: 'lapse' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('has-dependents')
    expect(result.error.dependents).toEqual(['deadline of wait', 'link quotation:AGREED'])
  })

  it('never removes the host or the initial state, even when asked to cascade', () => {
    expect(applyCommand(rich(), { type: 'remove', kind: 'role', id: 'beta', cascade: true }).ok).toBe(false)
    expect(applyCommand(rich(), { type: 'remove', kind: 'state', id: 'OPEN', cascade: true }).ok).toBe(false)
  })

  it('cascades a transition: deadlines that fired it are cleared, links to it are removed', () => {
    const next = apply(rich(), { type: 'remove', kind: 'transition', id: 'lapse', cascade: true })
    const wait = next.transitions.find((t) => t.id === 'wait')!
    expect('deadline' in wait || 'onDeadline' in wait).toBe(false)
    expect(next.links).toEqual([])
  })

  it('cascades a role: out of every by, createdBy and grant — dropping a grant left with nobody', () => {
    const next = apply(rich(), { type: 'remove', kind: 'role', id: 'alpha', cascade: true })
    expect(next.transitions.find((t) => t.id === 'wait')?.by).toEqual([])
    expect('createdBy' in next).toBe(false)
    expect(next.visibility).toEqual([{ path: 'note', roles: ['beta'] }])
  })

  it('cascades a state: transitions that only lived there go, others lose it from `from`, and a grant is never widened', () => {
    const next = apply(rich(), { type: 'remove', kind: 'state', id: 'WAITING', cascade: true })
    expect(next.transitions.map((t) => t.id)).toEqual(['finish', 'drop', 'resume'])
    expect(next.transitions.find((t) => t.id === 'resume')?.from).toEqual(['OPEN'])
    // The grant that applied only in WAITING is gone, not turned into "always".
    expect(next.visibility).toEqual([{ path: 'note', roles: ['alpha', 'beta'] }])
  })

  it('refuses to leave a process with no transition at all', () => {
    const lonely = small()
    lonely.transitions = [lonely.transitions[0]!]
    expect(applyCommand(lonely, { type: 'remove', kind: 'transition', id: 'finish' }).ok).toBe(false)
  })
})
