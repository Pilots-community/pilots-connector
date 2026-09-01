import { describe, expect, it } from 'vitest'

import { DURATION_SUBSET, isDuration, parseDuration } from '../src/duration.js'

describe('parseDuration', () => {
  it('accepts whole days', () => {
    expect(parseDuration('P1D')).toBe(86_400_000)
    expect(parseDuration('P14D')).toBe(14 * 86_400_000)
  })

  it('accepts whole hours', () => {
    expect(parseDuration('PT24H')).toBe(86_400_000)
    expect(parseDuration('PT1H')).toBe(3_600_000)
  })

  it('accepts whole minutes', () => {
    expect(parseDuration('PT30M')).toBe(1_800_000)
  })

  it.each([
    ['P1Y', 'years are outside the subset'],
    ['P1M', 'months are ambiguous and outside the subset'],
    ['P1W', 'weeks are outside the subset'],
    ['PT1S', 'seconds are outside the subset'],
    ['P1DT2H', 'compound durations are outside the subset'],
    ['PT1.5H', 'fractions are outside the subset'],
    ['P0D', 'a zero deadline is not a deadline'],
    ['PT0H', 'a zero deadline is not a deadline'],
    ['-P1D', 'negative durations are meaningless here'],
    ['P', 'incomplete'],
    ['PT', 'incomplete'],
    ['24H', 'missing designator'],
    ['pt24h', 'lowercase is not ISO 8601'],
    ['', 'empty'],
  ])('rejects %s (%s)', (input) => {
    expect(() => parseDuration(input)).toThrow(/duration/i)
    expect(isDuration(input)).toBe(false)
  })

  it('names the subset it accepts, for the linter to quote', () => {
    expect(DURATION_SUBSET).toMatch(/P#D/)
    expect(DURATION_SUBSET).toMatch(/PT#H/)
    expect(DURATION_SUBSET).toMatch(/PT#M/)
  })
})
