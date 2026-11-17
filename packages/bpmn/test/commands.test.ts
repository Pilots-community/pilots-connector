/**
 * Commands: every gesture in the editor is one of these, applied to the
 * definition. Two properties carry the design: a command never leaves a
 * dangling reference, and a command followed by its inverse gives back the same
 * bytes — which is what "lossless" means for an editor.
 */
import { canonicalise, lintDefinition, ProcessDefinition } from '@pilots/protocol'
import { describe, expect, it } from 'vitest'

import { applyCommand } from '../src/commands/apply.js'
import type { Command } from '../src/commands/types.js'
import type { DefinitionDocument } from '../src/document.js'
import { examples } from './helpers/examples.js'
import { small } from './helpers/small.js'

function apply(document: DefinitionDocument, ...commands: Command[]): DefinitionDocument {
  return commands.reduce((current, command) => {
    const result = applyCommand(current, command)
    if (!result.ok) throw new Error(`${command.type}: ${result.error.message}`)
    return result.document
  }, document)
}

const refused = (document: DefinitionDocument, command: Command): string => {
  const result = applyCommand(document, command)
  if (result.ok) throw new Error(`${command.type} was accepted`)
  return result.error.code
}

const bytes = (document: DefinitionDocument): string => canonicalise(document)

describe('applyCommand', () => {
  it('never changes the document it is given', () => {
    const document = small()
    const before = bytes(document)
    apply(document, { type: 'addState', state: { id: 'NEW', title: 'New' } })
    expect(bytes(document)).toBe(before)
  })

  it('adds a role, a state and a transition', () => {
    const next = apply(
      small(),
      { type: 'addRole', role: { id: 'gamma', title: 'Gamma' } },
      { type: 'addState', state: { id: 'HELD', title: 'Held' } },
      { type: 'addTransition', transition: { id: 'hold', title: 'Hold', from: ['OPEN'], to: 'HELD', by: ['gamma'] } },
    )
    expect(next.roles.map((r) => r.id)).toEqual(['alpha', 'beta', 'gamma'])
    expect(next.transitions.at(-1)).toEqual({ id: 'hold', title: 'Hold', from: ['OPEN'], to: 'HELD', by: ['gamma'] })
  })

  it('refuses a duplicate, malformed or reserved id', () => {
    expect(refused(small(), { type: 'addRole', role: { id: 'alpha', title: 'Again' } })).toBe('duplicate-id')
    expect(refused(small(), { type: 'addState', state: { id: '1st', title: 'First' } })).toBe('invalid-id')
    expect(
      refused(small(), { type: 'addTransition', transition: { id: 'create', title: 'C', from: ['OPEN'], by: ['alpha'] } }),
    ).toBe('reserved-id')
  })

  it('refuses a transition that names a state or role nobody declared', () => {
    const base = { id: 'go', title: 'Go', from: ['OPEN'], by: ['alpha'] }
    expect(refused(small(), { type: 'addTransition', transition: { ...base, to: 'NOWHERE' } })).toBe('unknown-reference')
    expect(refused(small(), { type: 'addTransition', transition: { ...base, by: ['nobody'] } })).toBe('unknown-reference')
    expect(refused(small(), { type: 'updateTransition', id: 'finish', patch: { from: ['GHOST'] } })).toBe('unknown-reference')
  })

  it('removes a key when an update sets it to undefined, rather than writing undefined', () => {
    const next = apply(small(), { type: 'updateState', id: 'DONE', patch: { outcome: undefined } })
    expect('outcome' in next.states[1]!).toBe(false)
  })

  it('checks references in a process-level update', () => {
    expect(refused(small(), { type: 'setProcess', patch: { hostedBy: 'nobody' } })).toBe('unknown-reference')
    expect(refused(small(), { type: 'setProcess', patch: { initialState: 'NOWHERE' } })).toBe('unknown-reference')
    expect(apply(small(), { type: 'setProcess', patch: { hostedBy: 'alpha' } }).hostedBy).toBe('alpha')
  })

  it('moves a task to another lane by changing who fires it', () => {
    const next = apply(small(), { type: 'moveTask', transition: 'finish', fromRole: 'beta', toRole: 'alpha' })
    expect(next.transitions[0]!.by).toEqual(['alpha'])
    expect(refused(small(), { type: 'moveTask', transition: 'drop', fromRole: 'alpha', toRole: 'beta' })).toBe('not-allowed')
  })

  it('sets a deadline only on a transition that leads somewhere, and only to fire a real one', () => {
    const next = apply(small(), { type: 'setDeadline', transition: 'finish', deadline: 'PT1H', onDeadline: 'drop' })
    expect(next.transitions[0]).toMatchObject({ deadline: 'PT1H', onDeadline: 'drop' })
    const update = apply(small(), {
      type: 'addTransition',
      transition: { id: 'annotate', title: 'Annotate', from: ['OPEN'], by: ['alpha'] },
    })
    expect(refused(update, { type: 'setDeadline', transition: 'annotate', deadline: 'PT1H', onDeadline: 'drop' })).toBe('not-allowed')
    expect(refused(small(), { type: 'setDeadline', transition: 'finish', deadline: 'PT1H', onDeadline: 'ghost' })).toBe('unknown-reference')
  })

  it('adds a link only to a transition that exists', () => {
    expect(refused(small(), { type: 'addLink', link: { onEvent: 'quotation:AGREED', triggers: 'ghost' } })).toBe('unknown-reference')
    const next = apply(small(), { type: 'addLink', link: { onEvent: 'quotation:AGREED', triggers: 'finish' } })
    expect(next.links).toEqual([{ onEvent: 'quotation:AGREED', triggers: 'finish' }])
    expect(refused(next, { type: 'removeLink', index: 4 })).toBe('not-allowed')
  })

  it('produces a document the schema accepts and the linter passes, from structured commands alone', () => {
    const next = apply(
      small(),
      { type: 'addRole', role: { id: 'gamma', title: 'Gamma' } },
      { type: 'addState', state: { id: 'HELD', title: 'Held' } },
      { type: 'addTransition', transition: { id: 'hold', title: 'Hold', from: ['OPEN'], to: 'HELD', by: ['gamma'] } },
      { type: 'addTransition', transition: { id: 'release', title: 'Release', from: ['HELD'], to: 'DONE', by: ['beta'] } },
      { type: 'setDeadline', transition: 'hold', deadline: 'P2D', onDeadline: 'release' },
      { type: 'moveTask', transition: 'finish', fromRole: 'beta', toRole: 'gamma' },
      { type: 'addLink', link: { onEvent: 'quotation:AGREED', triggers: 'drop' } },
    )
    expect(ProcessDefinition.safeParse(next).success).toBe(true)
    expect(lintDefinition(next).diagnostics.filter((d) => d.severity === 'error')).toEqual([])
  })
})

describe.each(examples())('lossless on $name', ({ document }) => {
  const same = (...commands: Command[]): void => {
    expect(bytes(apply(document, ...commands))).toBe(bytes(document))
  }
  const first = document.transitions[0]!
  const firstState = document.states[0]!

  it('add, then remove, gives back the same bytes', () => {
    same({ type: 'addState', state: { id: 'ZZ_NEW', title: 'New' } }, { type: 'remove', kind: 'state', id: 'ZZ_NEW' })
    same({ type: 'addRole', role: { id: 'zzNew', title: 'New' } }, { type: 'remove', kind: 'role', id: 'zzNew' })
    same(
      { type: 'addTransition', transition: { id: 'zzNew', title: 'New', from: [firstState.id], by: [] } },
      { type: 'remove', kind: 'transition', id: 'zzNew' },
    )
    same({ type: 'addLink', link: { onEvent: 'quotation:AGREED', triggers: first.id } }, {
      type: 'removeLink',
      index: (document.links ?? []).length,
    })
  })

  it('an update, then its reverse, gives back the same bytes', () => {
    same(
      { type: 'updateState', id: firstState.id, patch: { title: 'Changed' } },
      { type: 'updateState', id: firstState.id, patch: { title: firstState.title } },
    )
    const role = first.by[0]
    const other = document.roles.find((one) => !first.by.includes(one.id))
    if (role !== undefined && other !== undefined) {
      same(
        { type: 'moveTask', transition: first.id, fromRole: role, toRole: other.id },
        { type: 'moveTask', transition: first.id, fromRole: other.id, toRole: role },
      )
    }
  })

  it('a deadline set and cleared on a transition that had none gives back the same bytes', () => {
    const plain = document.transitions.find((one) => one.deadline === undefined && one.to !== undefined)
    if (plain === undefined) return
    same(
      { type: 'setDeadline', transition: plain.id, deadline: 'PT1H', onDeadline: plain.id },
      { type: 'clearDeadline', transition: plain.id },
    )
  })
})
