/**
 * The refresh trigger is a port, so a notification-driven nudge can be added
 * later as another adapter without touching a single call site.
 *
 * Note that both adapters take their dependency as a parameter. This suite runs
 * in vitest's `node` environment — there is no `window` — and that constraint
 * pushes the design the same way the rest of the repository is pushed:
 * everything external is a port, and tests stay hermetic.
 */
import { describe, expect, it, vi } from 'vitest'

import {
  focusFeed,
  mergeFeeds,
  pollingFeed,
  type ChangeFeed,
  type FocusTarget,
} from '../src/web/live/change-feed.js'

/** A `FocusTarget` whose listeners the test can fire by hand. */
function fakeTarget(): FocusTarget & { fire(type: string): void; visible: boolean; count: number } {
  const listeners = new Map<string, () => void>()
  return {
    visible: false,
    get count() {
      return listeners.size
    },
    addEventListener: (type, listener) => void listeners.set(type, listener),
    removeEventListener: (type) => void listeners.delete(type),
    isVisible() {
      return this.visible
    },
    fire: (type) => listeners.get(type)?.(),
  }
}

describe('pollingFeed', () => {
  it('fires on the interval and stops when unsubscribed', () => {
    vi.useFakeTimers()
    const changed = vi.fn()
    const stop = pollingFeed(5000).subscribe(changed)

    vi.advanceTimersByTime(12_000)
    expect(changed).toHaveBeenCalledTimes(2)

    stop()
    vi.advanceTimersByTime(20_000)
    expect(changed).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })
})

describe('focusFeed', () => {
  it('fires when the tab is visible again, and not when it is hidden', () => {
    const target = fakeTarget()
    const changed = vi.fn()
    const stop = focusFeed(target).subscribe(changed)

    // A background tab firing `focus` is not somebody looking at the screen,
    // and refetching for it is pure waste.
    target.visible = false
    target.fire('visibilitychange')
    expect(changed).not.toHaveBeenCalled()

    target.visible = true
    target.fire('visibilitychange')
    expect(changed).toHaveBeenCalledTimes(1)

    target.fire('focus')
    expect(changed).toHaveBeenCalledTimes(2)

    stop()
    expect(target.count).toBe(0)
  })
})

describe('mergeFeeds', () => {
  it('fans one subscription out to every feed and unsubscribes them all', () => {
    const stopA = vi.fn()
    const stopB = vi.fn()
    // Held in locals rather than asserted through the object, so the spy is
    // never referenced as an unbound method.
    const subscribeA = vi.fn(() => stopA)
    const subscribeB = vi.fn(() => stopB)
    const a: ChangeFeed = { subscribe: subscribeA }
    const b: ChangeFeed = { subscribe: subscribeB }
    const changed = vi.fn()

    const stop = mergeFeeds(a, b).subscribe(changed)
    expect(subscribeA).toHaveBeenCalledOnce()
    expect(subscribeB).toHaveBeenCalledOnce()

    stop()
    expect(stopA).toHaveBeenCalledOnce()
    expect(stopB).toHaveBeenCalledOnce()
  })

  it('passes the same callback through, so any feed can trigger a revalidation', () => {
    vi.useFakeTimers()
    const target = fakeTarget()
    const changed = vi.fn()
    const stop = mergeFeeds(pollingFeed(1000), focusFeed(target)).subscribe(changed)

    vi.advanceTimersByTime(1000)
    expect(changed).toHaveBeenCalledTimes(1)

    target.visible = true
    target.fire('focus')
    expect(changed).toHaveBeenCalledTimes(2)

    stop()
    vi.advanceTimersByTime(5000)
    expect(changed).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })
})
