import { describe, expect, it } from 'vitest'

import { applyCommand } from '../src/commands/apply.js'
import { getPointer, pointerOf } from '../src/commands/pointer.js'
import { small } from './helpers/small.js'

describe('setFragment', () => {
  it('sets, replaces and removes a value by JSON Pointer', () => {
    const set = applyCommand(small(), {
      type: 'setFragment',
      pointer: '/data/properties/note/maxLength',
      value: 10,
    })
    expect(set.ok && getPointer(set.document, '/data/properties/note/maxLength')).toBe(10)
    const removed = applyCommand(small(), { type: 'setFragment', pointer: '/transitions/1', value: undefined })
    expect(removed.ok && removed.document.transitions.map((t) => t.id)).toEqual(['finish'])
  })

  it('refuses a pointer that leads nowhere, and the root itself', () => {
    expect(applyCommand(small(), { type: 'setFragment', pointer: '/nope/deeper', value: 1 }).ok).toBe(false)
    expect(applyCommand(small(), { type: 'setFragment', pointer: '', value: 1 }).ok).toBe(false)
    expect(applyCommand(small(), { type: 'setFragment', pointer: 'data', value: 1 }).ok).toBe(false)
  })
})

describe('pointerOf', () => {
  it('names where an element lives', () => {
    expect(pointerOf(small(), { kind: 'state', id: 'DONE' })).toBe('/states/1')
    expect(pointerOf(small(), { kind: 'transition', id: 'drop' })).toBe('/transitions/1')
    expect(pointerOf(small(), { kind: 'role', id: 'nobody' })).toBeNull()
  })
})
