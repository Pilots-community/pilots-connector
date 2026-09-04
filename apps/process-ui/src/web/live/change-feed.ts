/**
 * When to revalidate — as a port, with polling in it.
 *
 * Call sites say *what* they need; this says *when* to go and look again. Two
 * adapters exist today: a timer, and the tab regaining focus.
 *
 * A third is designed for and deliberately not built. The connector already
 * exposes `GET /api/local/v1/events` (SSE), so a notification-driven nudge
 * becomes `sseFeed('/api/ui/changes')` and nothing else changes — no call site,
 * no query, no view. Its one prerequisite is recorded in the design record §4.1
 * and is easy to forget: the connector records a notification **only when a
 * subscription exists**, so each participant needs a seeded `sse` subscription
 * before that stream carries anything at all.
 *
 * Polling is deliberately first. A silently dead `EventSource` looks exactly
 * like a quiet one, and "a little late" is a much better failure than
 * "confidently wrong".
 */

export interface ChangeFeed {
  /** Calls `onChange` when something may have changed. Returns an unsubscribe. */
  subscribe(onChange: () => void): () => void
}

/**
 * Just enough of `document` to be testable without a DOM.
 *
 * The suite runs in vitest's `node` environment, so a feed that reached for the
 * global `document` could only be tested by adding jsdom. Taking the target as a
 * parameter is both cheaper and the same shape as every other port here.
 */
export interface FocusTarget {
  addEventListener(type: string, listener: () => void): void
  removeEventListener(type: string, listener: () => void): void
  isVisible(): boolean
}

export function pollingFeed(intervalMs: number): ChangeFeed {
  return {
    subscribe(onChange) {
      const timer = setInterval(onChange, intervalMs)
      return () => clearInterval(timer)
    },
  }
}

export function focusFeed(target: FocusTarget): ChangeFeed {
  return {
    subscribe(onChange) {
      // Only when actually visible: a background tab firing `focus` is not a
      // person looking at the screen, and refetching for it is pure waste.
      const handler = (): void => {
        if (target.isVisible()) onChange()
      }
      target.addEventListener('visibilitychange', handler)
      target.addEventListener('focus', handler)
      return () => {
        target.removeEventListener('visibilitychange', handler)
        target.removeEventListener('focus', handler)
      }
    },
  }
}

export function mergeFeeds(...feeds: readonly ChangeFeed[]): ChangeFeed {
  return {
    subscribe(onChange) {
      const stops = feeds.map((feed) => feed.subscribe(onChange))
      return () => {
        for (const stop of stops) stop()
      }
    },
  }
}
