/**
 * The `Clock` port.
 *
 * Nothing downstream may read the wall clock directly. That is not fastidiousness:
 * deadlines are a first-class part of the definition schema, and a deadline test
 * that sleeps is a test nobody runs. With this port, advancing a `PT24H` deadline
 * is a function call.
 *
 * It is also why timers are a scan loop over stored records rather than
 * `setTimeout` — `setTimeout` cannot be driven by a fake clock, does not survive
 * a restart, and has no meaning for the file store.
 */
export interface Clock {
  /** Milliseconds since the Unix epoch. */
  now(): number
}

export const systemClock: Clock = {
  now: () => Date.now(),
}

/** The protocol's timestamp format: UTC, milliseconds, always `Z`. */
export function toInstant(epochMs: number): string {
  return new Date(epochMs).toISOString()
}

export function fromInstant(instant: string): number {
  const ms = Date.parse(instant)
  if (Number.isNaN(ms)) throw new TypeError(`not an instant: ${JSON.stringify(instant)}`)
  return ms
}

/** The current time as a protocol instant. */
export function nowInstant(clock: Clock): string {
  return toInstant(clock.now())
}
