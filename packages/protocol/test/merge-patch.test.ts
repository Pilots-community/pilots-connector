import { describe, expect, it } from 'vitest'

import { applyMergePatch } from '../src/merge-patch.js'
import type { JsonValue } from '../src/json.js'

/**
 * The table from RFC 7386 Appendix A, verbatim. This is the specification, so
 * the specification's own examples are the test.
 */
const rfc7386: Array<[target: JsonValue, patch: JsonValue, expected: JsonValue]> = [
  [{ a: 'b' }, { a: 'c' }, { a: 'c' }],
  [{ a: 'b' }, { b: 'c' }, { a: 'b', b: 'c' }],
  [{ a: 'b' }, { a: null }, {}],
  [{ a: 'b', b: 'c' }, { a: null }, { b: 'c' }],
  [{ a: ['b'] }, { a: 'c' }, { a: 'c' }],
  [{ a: 'c' }, { a: ['b'] }, { a: ['b'] }],
  [{ a: { b: 'c' } }, { a: { b: 'd', c: null } }, { a: { b: 'd' } }],
  [{ a: [{ b: 'c' }] }, { a: [1] }, { a: [1] }],
  [
    ['a', 'b'],
    ['c', 'd'],
    ['c', 'd'],
  ],
  [{ a: 'b' }, ['c'], ['c']],
  [{ a: 'foo' }, null, null],
  [{ a: 'foo' }, 'bar', 'bar'],
  [{ e: null }, { a: 1 }, { e: null, a: 1 }],
  [[1, 2], { a: 'b', c: null }, { a: 'b' }],
  [{}, { a: { bb: { ccc: null } } }, { a: { bb: {} } }],
]

describe('applyMergePatch (RFC 7386)', () => {
  it.each(rfc7386)('%j patched with %j gives %j', (target, patch, expected) => {
    expect(applyMergePatch(target, patch)).toEqual(expected)
  })

  it('does not mutate the target', () => {
    const target = { a: 'b', nested: { keep: 1, drop: 2 } }
    const result = applyMergePatch(target, { nested: { drop: null } })
    expect(target).toEqual({ a: 'b', nested: { keep: 1, drop: 2 } })
    expect(result).toEqual({ a: 'b', nested: { keep: 1 } })
  })

  it('does not share substructure with the patch', () => {
    const patch = { nested: { value: 1 } }
    const result = applyMergePatch({}, patch) as { nested: { value: number } }
    result.nested.value = 99
    expect(patch.nested.value).toBe(1)
  })

  it('replaces a non-object target when the patch is an object', () => {
    expect(applyMergePatch('scalar', { a: 1 })).toEqual({ a: 1 })
    expect(applyMergePatch(null, { a: 1 })).toEqual({ a: 1 })
  })
})
