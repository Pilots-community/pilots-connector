/**
 * The `IdGenerator` port.
 *
 * ULIDs: monotonic, lexicographically sortable, and — with a seeded PRNG —
 * reproducible, which is what keeps a failing scenario test reproducible too.
 */
import { monotonicFactory } from 'ulidx'

import type { Clock } from './clock.js'

export interface IdGenerator {
  next(): string
}

/** Monotonic ULIDs stamped from the injected clock. */
export function ulidGenerator(clock: Clock): IdGenerator {
  const ulid = monotonicFactory()
  return { next: () => ulid(clock.now()) }
}
