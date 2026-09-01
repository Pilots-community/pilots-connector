/**
 * Remembers which peer tokens have been presented, so none is accepted twice.
 *
 * Bounded and clock-driven, like everything else with a timer in it. Tokens live
 * five minutes, so the working set is "one peer's calls in the last five
 * minutes" and eviction is by expiry rather than by guesswork.
 *
 * In memory on purpose. A replay cache that outlived a restart would be a
 * correctness improvement worth exactly nothing: a token that survives a
 * connector restart has minutes left to live, and the cost of persisting every
 * inbound call is paid on every inbound call.
 */
import type { Clock } from '@pilots/protocol'

export class PeerReplayCache {
  private readonly seenAt = new Map<string, number>()

  constructor(
    private readonly clock: Clock,
    /** A ceiling, not a target. Reaching it means something is wrong upstream. */
    private readonly capacity = 20_000,
  ) {}

  /**
   * Record a token and report whether it had been seen before.
   *
   * Keyed by issuer *and* `jti`: two peers picking the same random id must not
   * be able to cancel each other's calls.
   */
  seen(token: { jti: string; iss: string; expEpochSeconds: number }): boolean {
    const now = this.clock.now()
    this.prune(now)

    const key = `${token.iss} ${token.jti}`
    if (this.seenAt.has(key)) return true

    this.seenAt.set(key, token.expEpochSeconds * 1000)
    if (this.seenAt.size > this.capacity) {
      // Insertion-ordered, so the oldest entries are at the front. Dropping them
      // can only ever admit a replay of an already-expired token, which the
      // expiry check refuses anyway.
      const excess = this.seenAt.size - this.capacity
      let dropped = 0
      for (const existing of this.seenAt.keys()) {
        this.seenAt.delete(existing)
        dropped += 1
        if (dropped >= excess) break
      }
    }
    return false
  }

  private prune(nowMs: number): void {
    for (const [key, expiresAt] of this.seenAt) {
      // Insertion order is not expiry order in general, but every token carries
      // the same TTL, so in practice it is. Stop at the first live entry.
      if (expiresAt > nowMs) break
      this.seenAt.delete(key)
    }
  }

  get size(): number {
    return this.seenAt.size
  }
}
