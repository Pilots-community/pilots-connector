import { describe, expect, it } from 'vitest'

import { FakeClock, deterministicIdGenerator, testParticipants } from '../src/testing/index.js'

describe('FakeClock', () => {
  it('starts where it is told and never moves on its own', () => {
    const clock = new FakeClock('2026-08-24T09:00:00.000Z')
    expect(clock.instant()).toBe('2026-08-24T09:00:00.000Z')
    expect(clock.now()).toBe(clock.now())
  })

  it('advances by a definition-style duration, so a PT24H deadline is one call', () => {
    const clock = new FakeClock('2026-08-24T09:00:00.000Z')
    clock.advance('PT24H')
    expect(clock.instant()).toBe('2026-08-25T09:00:00.000Z')
    clock.advance('PT30M')
    expect(clock.instant()).toBe('2026-08-25T09:30:00.000Z')
  })
})

describe('deterministicIdGenerator', () => {
  it('produces the same ids from the same seed', () => {
    const a = deterministicIdGenerator(42)
    const b = deterministicIdGenerator(42)
    expect([a.next(), a.next(), a.next()]).toEqual([b.next(), b.next(), b.next()])
  })

  it('produces different ids from different seeds', () => {
    expect(deterministicIdGenerator(1).next()).not.toBe(deterministicIdGenerator(2).next())
  })

  it('produces well-formed, sortable ULIDs', () => {
    const clock = new FakeClock()
    const ids = Array.from({ length: 5 }, () => deterministicIdGenerator(7, clock).next())
    for (const id of ids) expect(id).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/)
    const generator = deterministicIdGenerator(7, clock)
    const sequence = [generator.next(), generator.next(), generator.next()]
    expect([...sequence].sort()).toEqual(sequence)
  })
})

describe('testParticipants', () => {
  it('generates a key and a resolvable DID document per participant', async () => {
    const { signer, resolver } = await testParticipants({
      acme: 'did:web:acme-shipping.example',
      vanmoer: 'did:web:vanmoer.example',
    })
    expect(await signer.did('acme')).toBe('did:web:acme-shipping.example')
    const document = await resolver.resolve('did:web:vanmoer.example')
    expect(document?.id).toBe('did:web:vanmoer.example')
    expect(await resolver.resolve('did:web:stranger.example')).toBeNull()
  })

  it('generates fresh keys every time, so nothing can become a fixture', async () => {
    const first = await testParticipants({ acme: 'did:web:acme-shipping.example' })
    const second = await testParticipants({ acme: 'did:web:acme-shipping.example' })
    expect(await first.signer.publicJwk('acme')).not.toEqual(await second.signer.publicJwk('acme'))
  })
})
