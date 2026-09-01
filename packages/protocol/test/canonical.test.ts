import { describe, expect, it } from 'vitest'

import {
  EMPTY_PAYLOAD_HASH,
  canonicalise,
  canonicalBytes,
  hashJson,
  sha256,
} from '../src/canonical.js'

describe('canonicalise (JCS, RFC 8785)', () => {
  it('orders object keys by UTF-16 code unit', () => {
    expect(canonicalise({ b: 1, a: 2 })).toBe('{"a":2,"b":1}')
    expect(canonicalise({ ä: 1, a: 2, Z: 3 })).toBe('{"Z":3,"a":2,"ä":1}')
  })

  it('orders keys in nested objects too', () => {
    expect(canonicalise({ outer: { z: 1, a: { y: 1, b: 2 } } })).toBe(
      '{"outer":{"a":{"b":2,"y":1},"z":1}}',
    )
  })

  it('serialises numbers per the ECMAScript rules JCS mandates', () => {
    expect(
      canonicalise({
        // Losing the tail is exactly what JCS specifies; reproducing it is the point.
        // eslint-disable-next-line no-loss-of-precision
        numbers: [333333333.33333329, 1e30, 4.5, 2e-3, 0.000000000000000000000000001],
      }),
    ).toBe('{"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27]}')
  })

  it('does not reorder array elements', () => {
    expect(canonicalise({ a: [3, 1, 2] })).toBe('{"a":[3,1,2]}')
  })

  it('preserves literals', () => {
    expect(canonicalise({ a: null, b: true, c: false })).toBe('{"a":null,"b":true,"c":false}')
  })

  it('emits UTF-8 bytes', () => {
    // '€' is three bytes in UTF-8 but one UTF-16 code unit.
    expect(canonicalBytes({ a: '€' })).toHaveLength('{"a":"'.length + 3 + '"}'.length)
  })

  it('refuses values JSON cannot represent', () => {
    expect(() => canonicalise(undefined as never)).toThrow(/not canonicalisable/i)
    expect(() => canonicalise({ a: undefined } as never)).not.toThrow()
  })
})

describe('sha256', () => {
  it('returns a prefixed lowercase hex digest', () => {
    // Well-known: sha256 of the empty input.
    expect(sha256(new Uint8Array())).toBe(
      'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
  })

  it('accepts strings as UTF-8', () => {
    expect(sha256('abc')).toBe(
      'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })
})

describe('hashJson', () => {
  it('hashes the canonical form, so key order cannot change the digest', () => {
    expect(hashJson({ a: 1, b: 2 })).toBe(hashJson({ b: 2, a: 1 }))
  })

  it('changes when a value changes', () => {
    expect(hashJson({ a: 1 })).not.toBe(hashJson({ a: 2 }))
  })

  it('exposes the hash of the empty payload', () => {
    expect(EMPTY_PAYLOAD_HASH).toBe(hashJson({}))
  })
})
