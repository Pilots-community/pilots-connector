import { describe, expect, it } from 'vitest'

import type { VisibilityDocument } from '../src/document.js'
import { readAccess, visibilityPaths, writeAccess } from '../src/forms/visibility.js'

const grants: VisibilityDocument[] = [
  { path: 'mass', roles: ['beta'] },
  { path: 'mass', roles: ['alpha'], whenState: ['PAID', 'DONE'] },
  { path: 'name', roles: ['alpha', 'beta'] },
]

describe('readAccess', () => {
  it('reads always, only in some states, and the default', () => {
    expect(readAccess(grants, 'mass', 'beta')).toEqual({ kind: 'always' })
    expect(readAccess(grants, 'mass', 'alpha')).toEqual({ kind: 'states', states: ['PAID', 'DONE'] })
    expect(readAccess(grants, 'mass', 'gamma')).toEqual({ kind: 'default' })
  })

  it('treats any unconditional grant as always — any matching grant is enough', () => {
    const both = [...grants, { path: 'mass', roles: ['alpha'] }]
    expect(readAccess(both, 'mass', 'alpha')).toEqual({ kind: 'always' })
  })
})

describe('writeAccess', () => {
  it('takes one role out of a shared grant without touching the others', () => {
    const next = writeAccess(grants, 'name', 'alpha', { kind: 'default' })
    expect(next).toContainEqual({ path: 'name', roles: ['beta'] })
    expect(readAccess(next, 'name', 'alpha')).toEqual({ kind: 'default' })
  })

  it('writes a state-restricted grant, replacing the role’s old ones for that field', () => {
    const next = writeAccess(grants, 'mass', 'beta', { kind: 'states', states: ['DONE'] })
    expect(next.filter((g) => g.path === 'mass' && g.roles.includes('beta'))).toEqual([
      { path: 'mass', roles: ['beta'], whenState: ['DONE'] },
    ])
  })
})

describe('visibilityPaths', () => {
  it('lists the data fields and any path a grant already names', () => {
    const data = { type: 'object', properties: { name: { type: 'string' }, size: { type: 'number' } } }
    expect(visibilityPaths(data, grants)).toEqual(['name', 'size', 'mass'])
  })
})
