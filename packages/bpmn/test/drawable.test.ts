/**
 * The guard an editor checks before drawing. Every committed definition must
 * pass it, and the shapes a half-typed JSON object takes must not — each of them
 * once made `toDiagram` throw.
 */
import { describe, expect, it } from 'vitest'

import { isDrawable } from '../src/drawable.js'
import { toDiagram } from '../src/project.js'
import { examples } from './helpers/examples.js'
import { small } from './helpers/small.js'

describe('isDrawable', () => {
  it('accepts the committed definitions and a small one', () => {
    for (const { document } of examples()) expect(isDrawable(document)).toBe(true)
    expect(isDrawable(small())).toBe(true)
  })

  it('accepts a draft the linter would reject but the canvas can draw', () => {
    const document = small()
    document.transitions[0]!.to = 'NOWHERE'
    document.hostedBy = ''
    delete (document as { links?: unknown }).links
    delete (document as { visibility?: unknown }).visibility
    expect(isDrawable(document)).toBe(true)
    expect(() => toDiagram(document)).not.toThrow()
  })

  it('refuses what is not a definition-shaped object', () => {
    expect(isDrawable({})).toBe(false)
    expect(isDrawable(null)).toBe(false)
    expect(isDrawable([])).toBe(false)
    expect(isDrawable({ ...small(), roles: {} })).toBe(false)
  })

  it('refuses a transition without `from` or `by`, as while its keys are being typed', () => {
    const noFrom = small() as unknown as { transitions: Array<Record<string, unknown>> }
    delete noFrom.transitions[0]!['from']
    expect(isDrawable(noFrom)).toBe(false)
    const noBy = small() as unknown as { transitions: Array<Record<string, unknown>> }
    noBy.transitions[1]!['by'] = 'alpha'
    expect(isDrawable(noBy)).toBe(false)
  })

  it('refuses an element without a string id, and malformed links or grants', () => {
    expect(isDrawable({ ...small(), states: [{ title: 'No id' }] })).toBe(false)
    expect(isDrawable({ ...small(), roles: [{ id: 1, title: 'Number' }] })).toBe(false)
    expect(isDrawable({ ...small(), links: {} })).toBe(false)
    expect(isDrawable({ ...small(), links: ['x'] })).toBe(false)
    expect(isDrawable({ ...small(), visibility: [{ path: 'note', roles: 'alpha' }] })).toBe(false)
  })
})
