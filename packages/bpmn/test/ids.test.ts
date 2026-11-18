import { ProcessDefinition } from '@pilots/protocol'
import { describe, expect, it } from 'vitest'

import { IDENTIFIER, bumpVersion, freshId, identifierFrom } from '../src/commands/ids.js'
import { small } from './helpers/small.js'

describe('IDENTIFIER', () => {
  // This package may not import the protocol at runtime, so it mirrors the
  // pattern — and this test pins the mirror to the spec.
  it.each(['a', 'A1', 'a-b_c', '1a', '-a', 'a b', 'é', ''])('agrees with the protocol on %j', (id) => {
    const document = { ...small(), roles: [...small().roles, { id, title: 'X' }] }
    expect(IDENTIFIER.test(id)).toBe(ProcessDefinition.safeParse(document).success)
  })
})

describe('freshId', () => {
  it('returns the base when it is free, and numbers it when it is not', () => {
    expect(freshId('role', [])).toBe('role')
    expect(freshId('role', ['role', 'role2'])).toBe('role3')
  })
})

describe('identifierFrom', () => {
  it('turns a title into a camelCase identifier', () => {
    expect(identifierFrom('Make an offer', [])).toBe('makeAnOffer')
    expect(identifierFrom('Café crème', [])).toBe('cafeCreme')
  })

  it('falls back when the title has nothing usable, and avoids taken and reserved ids', () => {
    expect(identifierFrom('  42 ', [])).toBe('step')
    expect(identifierFrom('Finish', ['finish'])).toBe('finish2')
    expect(identifierFrom('Create', [])).toBe('createStep')
  })
})

describe('bumpVersion', () => {
  it('bumps the patch number, and leaves anything that is not x.y.z alone', () => {
    expect(bumpVersion('1.0.0')).toBe('1.0.1')
    expect(bumpVersion('2.3.9')).toBe('2.3.10')
    expect(bumpVersion('draft')).toBe('draft')
  })
})
