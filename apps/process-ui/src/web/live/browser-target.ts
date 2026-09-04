/**
 * The one piece of `change-feed.ts` that needs a browser.
 *
 * Kept apart on purpose. The port and its adapters are environment-free, so the
 * test suite — which runs in vitest's `node` environment, with no DOM — can
 * import them directly. Leaving this binding in the same module would drag
 * `window` and `document` into that project and force a jsdom dependency to
 * test a `setInterval`.
 */
import type { FocusTarget } from './change-feed.js'

/** The browser's own document and window, adapted to `FocusTarget`. */
export function browserFocusTarget(): FocusTarget {
  return {
    addEventListener: (type, listener) => {
      // `visibilitychange` is a document event; `focus` only reaches the window.
      if (type === 'focus') window.addEventListener('focus', listener)
      else document.addEventListener(type, listener)
    },
    removeEventListener: (type, listener) => {
      if (type === 'focus') window.removeEventListener('focus', listener)
      else document.removeEventListener(type, listener)
    },
    isVisible: () => document.visibilityState === 'visible',
  }
}
