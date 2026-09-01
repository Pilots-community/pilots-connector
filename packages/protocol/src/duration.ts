/**
 * A deliberately tiny subset of ISO 8601 durations.
 *
 * `deadline` is the only place a definition expresses time, and whole days,
 * hours and minutes are all one has ever needed. Accepting the full grammar
 * would mean months (ambiguous), fractions (rounding), and compound forms
 * (`P1DT2H`) — surface area with no demand behind it. The linter rejects
 * anything outside this subset, so the definition surface stays small and every
 * implementation of this protocol can parse a deadline with one regular
 * expression.
 */

/** Human-readable statement of the subset, quoted by linter diagnostics. */
export const DURATION_SUBSET = 'P#D, PT#H or PT#M with a positive whole number'

const PATTERN = /^P(?:([1-9][0-9]*)D|T(?:([1-9][0-9]*)H|([1-9][0-9]*)M))$/

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/** Milliseconds represented by a duration in the accepted subset. */
export function parseDuration(input: string): number {
  const match = PATTERN.exec(input)
  if (!match) {
    throw new RangeError(`invalid duration ${JSON.stringify(input)}: expected ${DURATION_SUBSET}`)
  }
  const [, days, hours, minutes] = match
  if (days !== undefined) return Number(days) * DAY_MS
  if (hours !== undefined) return Number(hours) * HOUR_MS
  return Number(minutes) * MINUTE_MS
}

export function isDuration(input: unknown): input is string {
  return typeof input === 'string' && PATTERN.test(input)
}
