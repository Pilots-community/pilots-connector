# Process UI Iteration 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the two-UI session collision, make the process UI refresh itself without disturbing open forms, draw each process as a state diagram with the path taken, and make offerings/quotations/processes readable.

**Architecture:** Everything happens in `apps/process-ui`; the connector, `packages/protocol` and `packages/client` are untouched. Server state moves to `@tanstack/react-query`, whose revalidation is driven by a `ChangeFeed` port (polling + window focus today, a notification nudge later). The diagram is `@xyflow/react` fed by a pure `toGraph()` that also serves the editor in Iteration 2. `App.tsx` (590 lines) splits into a shell plus views.

**Tech Stack:** React 19, Vite, Tailwind 4, `@tanstack/react-query`, `@xyflow/react` (MIT), Vitest (node environment), Playwright, Fastify BFF, better-auth.

**Spec:** [`docs/superpowers/specs/2026-09-03-process-ui-iteration-design.md`](../specs/2026-09-03-process-ui-iteration-design.md)

> **Amended after Task 0.** The spec's P12 invented a heuristic — "off-path means reached only by a
> wildcard transition" — because the definition could not say how a process ended. It can now:
> `states[].outcome` is `fulfilled` or `abandoned`, terminality is derived from it, and both the
> instance view and the notification envelope carry the computed value. **The heuristic is gone**, and
> Tasks 4 and 6 below are simpler for it. P9 (one edge per wildcard) still stands — that is about
> edges, not states.

## Global Constraints

- **Never run `git commit` or `git push`.** `CLAUDE.md` forbids it and `.claude/settings.json` blocks it. Every task ends with a **Verify** step instead; when a task is green, stop and tell the supervisor it is ready to review and commit.
- **No new dependency without saying what it buys** (`docs/STACK.md`). This plan adds exactly two: `@tanstack/react-query` (already named in STACK.md §6, never installed) and `@xyflow/react` (MIT, 1.2 MB unpacked, chosen because Iteration 2 makes this an editor).
- **The boundary rule is lint-enforced:** `apps/process-ui` may import `packages/client` and `packages/protocol`, **never** `apps/connector`.
- **Vitest for this app runs `include: ['test/**/*.test.ts']` with `environment: 'node'`.** Tests live in `apps/process-ui/test/`, not beside the source, and **there is no DOM**. Anything touching `window`/`document` must take its target as a parameter.
- **No real company names** in code, config, tests or definitions. The two orgs are `org-a` / `org-b`; display names come from `ORG_A_NAME` / `ORG_B_NAME`.
- **Never commit credentials.** `.env` is gitignored; compose carries variable *names*.
- Gate before declaring any task done: `pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm format:check`.

---

### Task 1: Give each process UI its own session cookie

Implements spec §3 and P1. This is the bug the iteration exists for: both UIs set a cookie named `better-auth.session_token`, and **cookies ignore the port**, so signing into Org B on `:4001` overwrites Org A's session on `:4000`.

**Files:**
- Modify: `apps/process-ui/src/server/config.ts` (add `cookiePrefix`)
- Modify: `apps/process-ui/src/server/auth.ts` (pass `advanced.cookiePrefix`)
- Modify: `apps/process-ui/src/web/App.tsx` (error handling so a failed session call is not a blank page)
- Modify: `docker-compose.yml` (set `PILOTS_UI_COOKIE_PREFIX` for both UIs)
- Modify: `apps/connector/.env.example` — no. **Create/modify:** `apps/process-ui/.env.example` if present; otherwise skip
- Test: `apps/process-ui/test/bff.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `ProcessUiConfig.cookiePrefix: string` (default `'pilots'`), read from `PILOTS_UI_COOKIE_PREFIX`.

- [ ] **Step 1: Write the failing test**

Add to `apps/process-ui/test/bff.test.ts`:

```ts
describe('session cookies are scoped to this UI', () => {
  it('defaults the cookie prefix, and takes it from configuration', () => {
    const base = {
      PILOTS_API_KEY: 'ak_01J0000000000000000000TEST.notarealsecret',
      PILOTS_CONNECTOR_URL: 'http://localhost:3000',
    }
    expect(loadConfig(base).cookiePrefix).toBe('pilots')
    expect(loadConfig({ ...base, PILOTS_UI_COOKIE_PREFIX: 'org-a' }).cookiePrefix).toBe('org-a')
  })

  it('names the cookie after the prefix, so two UIs on one host do not collide', async () => {
    // Cookies ignore the port: localhost:4000 and localhost:4001 share a jar.
    // Two UIs must therefore not both use better-auth's default name.
    const orgA = createAuth(
      loadConfig({ ...CONFIG_ENV, PILOTS_UI_COOKIE_PREFIX: 'org-a' }),
      'http://localhost:4000',
    )
    const response = await orgA.handler(
      new Request('http://localhost:4000/api/auth/sign-in/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'alice@org-a.example', password: 'OrgA_123' }),
      }),
    )
    const cookie = response.headers.get('set-cookie') ?? ''
    expect(cookie).toContain('org-a.session_token')
    expect(cookie).not.toContain('better-auth.session_token')
  })
})
```

`CONFIG_ENV` is the existing env object in that file; if the seeded user is not created there, call `await orgA.seed()` before signing in.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @pilots/process-ui exec vitest run test/bff.test.ts`
Expected: FAIL — `cookiePrefix` is not a property of the config, and the cookie is named `better-auth.session_token`.

- [ ] **Step 3: Add the config field**

In `apps/process-ui/src/server/config.ts`, add to the `ProcessUiConfig` schema:

```ts
  /**
   * Namespaces this UI's session cookie.
   *
   * **Cookies ignore the port.** Two process UIs on `localhost:4000` and
   * `localhost:4001` address the same cookie jar, so sharing better-auth's
   * default name means whichever signs in second silently signs the other out.
   * Two UIs on one host MUST differ here.
   */
  cookiePrefix: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/),
```

and to the `candidate` object:

```ts
    cookiePrefix: env['PILOTS_UI_COOKIE_PREFIX'] ?? 'pilots',
```

- [ ] **Step 4: Use it in better-auth**

In `apps/process-ui/src/server/auth.ts`, inside the `advanced` block:

```ts
    advanced: {
      // The BFF and the SPA are the same origin, so a cookie is the right
      // carrier and does not need to be readable by script.
      useSecureCookies: config.environment === 'production',
      // Cookies ignore the port, so two UIs on one host would otherwise share
      // one cookie and sign each other out. See config.cookiePrefix.
      cookiePrefix: config.cookiePrefix,
    },
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @pilots/process-ui exec vitest run test/bff.test.ts`
Expected: PASS

- [ ] **Step 6: Stop the blank page when the session call fails**

In `apps/process-ui/src/web/App.tsx`, the current `refresh` leaves `ready` false forever if `api.session()` rejects, rendering `null`. Add a catch:

```ts
  const refresh = useCallback(() => {
    void api
      .session()
      .then((session) => {
        setUser(session.user)
        setParticipant(session.participant)
        setDid(session.did)
        document.title = `${session.participant} — Pilots`
        setReady(true)
        if (session.user) void api.instances().then(({ instances: list }) => setInstances(list))
      })
      .catch(() => {
        // The BFF is unreachable or answered something unreadable. Show the
        // sign-in screen rather than a blank page that never resolves.
        setUser(null)
        setReady(true)
      })
  }, [])
```

- [ ] **Step 7: Configure both UIs in compose**

In `docker-compose.yml`, add to `org-a-ui`'s environment, below `PILOTS_UI_NAME`:

```yaml
      # Cookies ignore the port, so both UIs would otherwise share one cookie on
      # localhost and sign each other out. Two process UIs on one host must
      # differ here.
      PILOTS_UI_COOKIE_PREFIX: org-a
```

and to `org-b-ui`:

```yaml
      PILOTS_UI_COOKIE_PREFIX: org-b
```

- [ ] **Step 8: Verify**

```bash
pnpm --filter @pilots/process-ui exec vitest run && pnpm typecheck && pnpm lint
```

Then in containers:

```bash
pnpm demo:env && docker compose up -d --build org-a org-b org-a-ui org-b-ui
```

Sign into `:4000`, then `:4001`, then reload `:4000` — it must still be signed in. Report to the supervisor for review; do not commit.

---

### Task 2: The data layer — react-query and the ChangeFeed port

Implements spec §4 and P3, P4, P10. Polling and window focus become two adapters behind one port, so the notification-driven nudge is a third adapter rather than a rewrite.

**Files:**
- Modify: `apps/process-ui/package.json` (add `@tanstack/react-query`)
- Create: `apps/process-ui/src/web/live/change-feed.ts`
- Create: `apps/process-ui/src/web/live/useLiveSync.ts`
- Create: `apps/process-ui/src/web/queries.ts`
- Modify: `apps/process-ui/src/web/main.tsx` (mount the provider)
- Test: `apps/process-ui/test/change-feed.test.ts`

**Interfaces:**
- Consumes: `api` from `src/web/api.ts` (existing).
- Produces:
  - `ChangeFeed` — `{ subscribe(onChange: () => void): () => void }`
  - `pollingFeed(intervalMs: number, schedule?: Scheduler): ChangeFeed`
  - `focusFeed(target: FocusTarget): ChangeFeed`
  - `mergeFeeds(...feeds: ChangeFeed[]): ChangeFeed`
  - `useLiveSync(feed: ChangeFeed): void`
  - `keys` — `{ session: ['session'], instances: ['instances'], instance: (id) => ['instance', id], events: (id) => ['events', id], definitions: ['definitions'], definition: (ref) => ['definition', ref], offerings: ['offerings'], connections: ['connections'] }`

- [ ] **Step 1: Write the failing test**

Create `apps/process-ui/test/change-feed.test.ts`:

```ts
/**
 * The refresh trigger is a port, so a notification-driven nudge can be added
 * later as another adapter without touching a single call site.
 *
 * Note both adapters take their dependency as a parameter. The suite runs in
 * vitest's `node` environment — there is no `window` — and that constraint is
 * the same one the rest of the repo lives under: everything external is a port.
 */
import { describe, expect, it, vi } from 'vitest'

import { focusFeed, mergeFeeds, pollingFeed } from '../src/web/live/change-feed.js'

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
  it('fires when the tab becomes visible again, and detaches on unsubscribe', () => {
    const listeners = new Map<string, () => void>()
    const target = {
      visible: false,
      addEventListener: (type: string, fn: () => void) => listeners.set(type, fn),
      removeEventListener: (type: string) => listeners.delete(type),
      isVisible: () => target.visible,
    }
    const changed = vi.fn()
    const stop = focusFeed(target).subscribe(changed)

    // Hidden: a focus event is not a reason to refetch.
    target.visible = false
    listeners.get('visibilitychange')?.()
    expect(changed).not.toHaveBeenCalled()

    target.visible = true
    listeners.get('visibilitychange')?.()
    expect(changed).toHaveBeenCalledTimes(1)

    stop()
    expect(listeners.size).toBe(0)
  })
})

describe('mergeFeeds', () => {
  it('fans one subscription out to every feed and unsubscribes them all', () => {
    const stopA = vi.fn()
    const stopB = vi.fn()
    const a = { subscribe: vi.fn(() => stopA) }
    const b = { subscribe: vi.fn(() => stopB) }
    const changed = vi.fn()

    const stop = mergeFeeds(a, b).subscribe(changed)
    expect(a.subscribe).toHaveBeenCalledOnce()
    expect(b.subscribe).toHaveBeenCalledOnce()

    stop()
    expect(stopA).toHaveBeenCalledOnce()
    expect(stopB).toHaveBeenCalledOnce()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @pilots/process-ui exec vitest run test/change-feed.test.ts`
Expected: FAIL — cannot resolve `../src/web/live/change-feed.js`.

- [ ] **Step 3: Write the port and its two adapters**

Create `apps/process-ui/src/web/live/change-feed.ts`:

```ts
/**
 * When to revalidate — as a port, with polling in it.
 *
 * Call sites say *what* they need; this says *when* to go and look again. Two
 * adapters exist today: a timer and the tab regaining focus. A third is already
 * designed for — the connector exposes `GET /api/local/v1/events` (SSE), so a
 * notification-driven nudge becomes `sseFeed('/api/ui/changes')` and nothing
 * else changes. Its one prerequisite is recorded in the design record §4.1: the
 * connector records a notification only when a subscription exists, so each
 * participant needs a seeded `sse` subscription first.
 *
 * Polling is deliberately first. A silently dead stream looks exactly like a
 * quiet one, and "a little late" is a better failure than "confidently wrong".
 */
export interface ChangeFeed {
  /** Calls `onChange` when something may have changed. Returns an unsubscribe. */
  subscribe(onChange: () => void): () => void
}

/** Just enough of `document` to be testable without a DOM. */
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

/** The browser's own document, adapted to `FocusTarget`. */
export function browserFocusTarget(): FocusTarget {
  return {
    addEventListener: (type, listener) => {
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @pilots/process-ui exec vitest run test/change-feed.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Add react-query**

```bash
pnpm --filter @pilots/process-ui add @tanstack/react-query
```

Then record the addition in `docs/STACK.md` where the process UI's stack is described — it was named there but never installed, so change the wording from intent to fact.

- [ ] **Step 6: Write the query keys and the sync hook**

Create `apps/process-ui/src/web/queries.ts`:

```ts
/**
 * One place that names every server-state key, so an invalidation cannot miss
 * a screen by spelling a key differently.
 */
import { api } from './api.js'

export const keys = {
  session: ['session'] as const,
  instances: ['instances'] as const,
  instance: (id: string) => ['instance', id] as const,
  events: (id: string) => ['events', id] as const,
  definitions: ['definitions'] as const,
  definition: (ref: string) => ['definition', ref] as const,
  offerings: ['offerings'] as const,
  connections: ['connections'] as const,
}

export const queries = {
  session: () => ({ queryKey: keys.session, queryFn: () => api.session() }),
  instances: () => ({
    queryKey: keys.instances,
    queryFn: async () => (await api.instances()).instances,
  }),
  instance: (id: string) => ({ queryKey: keys.instance(id), queryFn: () => api.instance(id) }),
  events: (id: string) => ({ queryKey: keys.events(id), queryFn: () => api.events(id) }),
  definitions: () => ({
    queryKey: keys.definitions,
    queryFn: async () => (await api.definitions()).definitions,
  }),
  definition: (ref: string) => ({
    queryKey: keys.definition(ref),
    queryFn: () => api.definition(ref),
  }),
  offerings: () => ({
    queryKey: keys.offerings,
    queryFn: async () => (await api.offerings()).offerings,
  }),
}
```

Adjust the `api.*` call names to match `src/web/api.ts` exactly; do not invent methods.

Create `apps/process-ui/src/web/live/useLiveSync.ts`:

```ts
import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'

import { keys } from '../queries.js'
import type { ChangeFeed } from './change-feed.js'

/**
 * Revalidate the screens that can change underneath you.
 *
 * Deliberately not `invalidateQueries()` with no argument: the session and the
 * definition list do not change while you watch, and refetching them on a timer
 * would be noise.
 */
export function useLiveSync(feed: ChangeFeed): void {
  const client = useQueryClient()
  useEffect(
    () =>
      feed.subscribe(() => {
        void client.invalidateQueries({ queryKey: keys.instances })
        void client.invalidateQueries({ queryKey: ['instance'] })
        void client.invalidateQueries({ queryKey: ['events'] })
      }),
    [client, feed],
  )
}
```

- [ ] **Step 7: Mount the provider**

Rewrite `apps/process-ui/src/web/main.tsx`:

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import { App } from './App.js'
import './styles.css'

const client = new QueryClient({
  defaultOptions: {
    queries: {
      // A refetch must never blank a screen that already has data: the old
      // value stays on screen until the new one arrives.
      placeholderData: (previous: unknown) => previous,
      staleTime: 2_000,
      retry: 1,
    },
  },
})

const root = document.getElementById('root')
if (!root) throw new Error('no #root')
createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
)
```

- [ ] **Step 8: Verify**

```bash
pnpm --filter @pilots/process-ui exec vitest run && pnpm typecheck && pnpm lint && pnpm build
```

Report for review; do not commit.

---

### Task 3: Split `App.tsx` into a shell and views

Mechanical, no behaviour change, done before the views grow. `App.tsx` is 590 lines carrying shell, list, detail and start form; that is where "refresh without disturbing a form" would be hardest to get right.

**Files:**
- Modify: `apps/process-ui/src/web/App.tsx` (shrink to the shell)
- Create: `apps/process-ui/src/web/views/Processes.tsx`
- Create: `apps/process-ui/src/web/views/ProcessDetail.tsx`
- Create: `apps/process-ui/src/web/views/Start.tsx`
- Create: `apps/process-ui/src/web/views/SignIn.tsx`
- Create: `apps/process-ui/src/web/ui.ts` (the shared `input` / `ghost` / `Card` primitives currently inline)

**Interfaces:**
- Consumes: `queries`, `useLiveSync`, `api`.
- Produces:
  - `<Processes onOpen={(id: string) => void} />`
  - `<ProcessDetail id={string} onBack={() => void} />`
  - `<Start onStarted={(id: string) => void} />`
  - `<SignIn participant={string} did={string | null} onDone={() => void} />`

- [ ] **Step 1: Move the shared primitives**

Create `apps/process-ui/src/web/ui.ts` and move the existing `input`, `ghost` class constants and the `Card` component out of `App.tsx` verbatim. Export each. Do not restyle anything in this task.

- [ ] **Step 2: Move each view out verbatim**

Cut `SignIn`, the processes list, the detail panel and the start form from `App.tsx` into the four files above, changing only what the move requires: imports, and props replacing values previously closed over. **No logic changes and no styling changes** — this task must be reviewable as a pure move.

- [ ] **Step 3: Reduce `App.tsx` to the shell**

It keeps: the session query, the header (participant, DID, sign out), the tab switch, and `useLiveSync`. It should end well under 150 lines.

```tsx
export function App() {
  const feed = useMemo(
    () => mergeFeeds(pollingFeed(5_000), focusFeed(browserFocusTarget())),
    [],
  )
  useLiveSync(feed)

  const session = useQuery(queries.session())
  const [selected, setSelected] = useState<string | null>(null)
  const [tab, setTab] = useState<'processes' | 'start'>('processes')
  // …header, then the selected view
}
```

- [ ] **Step 4: Verify nothing changed**

Run: `pnpm typecheck && pnpm lint && pnpm build`
Then `docker compose up -d --build org-a-ui` and walk the existing flow by hand: sign in, list, open an instance, apply a transition. Behaviour must be identical.

- [ ] **Step 5: Verify with the existing e2e suite**

Run: `pnpm test:e2e`
Expected: the existing 8 specs still pass. Report for review; do not commit.

---

### Task 4: `toGraph` — the pure definition-to-graph function

Implements spec §5.2 and P8, P9, P11, P12. This is the load-bearing logic and it is tested without a browser.

**Files:**
- Create: `apps/process-ui/src/web/graph/to-graph.ts`
- Test: `apps/process-ui/test/to-graph.test.ts`

**Interfaces:**
- Consumes: `ProcessDefinition` and `SignedEvent` from `src/web/api.ts`.
- Produces:
  - `GraphNode` — `{ id, title, layer, lane: 'main' | 'off-path', kind: 'state' | 'any-state', terminal: boolean, reached: boolean, current: boolean }`
  - `GraphEdge` — `{ id, source, target, transition, title, by: string[], wildcard: boolean, taken: boolean }`
  - `ProcessGraph` — `{ nodes: GraphNode[]; edges: GraphEdge[] }`
  - `ANY_STATE_NODE` — `'__any__'`
  - `toGraph(definition: ProcessDefinition, options?: { history?: readonly SignedEvent[]; current?: string }): ProcessGraph`

- [ ] **Step 1: Write the failing test**

Create `apps/process-ui/test/to-graph.test.ts`:

```ts
/**
 * The picture is derived from the definition, so a new process needs no UI
 * work. These tests are the guard on that claim, and on the two traps the
 * design record records: the lane is declared by `outcome`, not inferred from
 * the graph's shape, and a wildcard transition must not be expanded.
 */
import { describe, expect, it } from 'vitest'

import { ANY_STATE_NODE, toGraph } from '../src/web/graph/to-graph.js'
import type { ProcessDefinition, SignedEvent } from '../src/web/api.js'

const WEIGHING: ProcessDefinition = {
  id: 'container-weighing',
  version: '1.0.0',
  kind: 'service',
  title: 'Container weighing',
  roles: [
    { id: 'shipper', title: 'Shipper' },
    { id: 'weigher', title: 'Weighing company' },
  ],
  hostedBy: 'weigher',
  initialState: 'ORDERED',
  states: [
    { id: 'ORDERED', title: 'Ordered' },
    { id: 'TRUCK_ANNOUNCED', title: 'Truck announced' },
    { id: 'WEIGHED', title: 'Weighed' },
    { id: 'PAID', title: 'Paid' },
    { id: 'VGM_ISSUED', title: 'VGM issued', outcome: 'fulfilled' },
    { id: 'CANCELLED', title: 'Cancelled', outcome: 'abandoned' },
  ],
  data: {},
  transitions: [
    { id: 'announceTruck', title: 'Announce truck', from: ['ORDERED'], to: 'TRUCK_ANNOUNCED', by: ['shipper'] },
    { id: 'weigh', title: 'Weigh', from: ['TRUCK_ANNOUNCED'], to: 'WEIGHED', by: ['weigher'] },
    { id: 'recordPayment', title: 'Record payment', from: ['WEIGHED'], to: 'PAID', by: ['weigher'] },
    { id: 'issueVgm', title: 'Issue VGM', from: ['PAID'], to: 'VGM_ISSUED', by: ['weigher'] },
    { id: 'cancel', title: 'Cancel', from: ['*'], to: 'CANCELLED', by: ['shipper', 'weigher'] },
  ],
}

function event(seq: number, transition: string, from: string | null, to: string): SignedEvent {
  return {
    header: {
      instance: '01J', seq, transition, actor: 'did:web:org-a.example',
      from, to, at: '2026-08-24T09:00:00.000Z', prev: null,
      payloadHash: '', genesis: '', cause: null, attachments: [],
    },
    payload: null, redacted: false, sig: '',
  }
}

describe('layering', () => {
  it('lays the happy path out left to right from the initial state', () => {
    const { nodes } = toGraph(WEIGHING)
    const layer = (id: string) => nodes.find((n) => n.id === id)?.layer
    expect(layer('ORDERED')).toBe(0)
    expect(layer('TRUCK_ANNOUNCED')).toBe(1)
    expect(layer('WEIGHED')).toBe(2)
    expect(layer('PAID')).toBe(3)
    expect(layer('VGM_ISSUED')).toBe(4)
  })
})

describe('the off-path lane', () => {
  it('puts a wildcard-only state below, and leaves the successful ending on the main line', () => {
    const { nodes } = toGraph(WEIGHING)
    const lane = (id: string) => nodes.find((n) => n.id === id)?.lane

    // Both are endings; only one is a *good* one, and the definition says which.
    expect(lane('CANCELLED')).toBe('off-path')
    expect(lane('VGM_ISSUED')).toBe('main')
    expect(nodes.find((n) => n.id === 'VGM_ISSUED')?.terminal).toBe(true)
  })
})

describe('wildcard transitions', () => {
  it('draws one edge from an any-state marker rather than one per source', () => {
    const { nodes, edges } = toGraph(WEIGHING)
    const cancels = edges.filter((e) => e.transition === 'cancel')

    // Expanded, `cancel` would be four edges here — every non-terminal state.
    expect(cancels).toHaveLength(1)
    expect(cancels[0]?.source).toBe(ANY_STATE_NODE)
    expect(cancels[0]?.wildcard).toBe(true)
    expect(nodes.find((n) => n.id === ANY_STATE_NODE)?.kind).toBe('any-state')
  })

  it('omits the any-state marker when a definition has no wildcard transition', () => {
    const linear = {
      ...WEIGHING,
      states: WEIGHING.states.filter((s) => s.id !== 'CANCELLED'),
      transitions: WEIGHING.transitions.filter((t) => t.id !== 'cancel'),
    }
    expect(toGraph(linear).nodes.some((n) => n.kind === 'any-state')).toBe(false)
  })
})

describe('the path taken', () => {
  it('marks the states reached, the edges traversed and where you are now', () => {
    const history = [
      event(1, 'create', null, 'ORDERED'),
      event(2, 'announceTruck', 'ORDERED', 'TRUCK_ANNOUNCED'),
      event(3, 'weigh', 'TRUCK_ANNOUNCED', 'WEIGHED'),
    ]
    const { nodes, edges } = toGraph(WEIGHING, { history, current: 'WEIGHED' })

    expect(nodes.find((n) => n.id === 'ORDERED')?.reached).toBe(true)
    expect(nodes.find((n) => n.id === 'WEIGHED')?.current).toBe(true)
    expect(nodes.find((n) => n.id === 'PAID')?.reached).toBe(false)

    expect(edges.find((e) => e.transition === 'weigh')?.taken).toBe(true)
    expect(edges.find((e) => e.transition === 'issueVgm')?.taken).toBe(false)
  })

  it('is a map with nothing walked when there is no history', () => {
    const { nodes, edges } = toGraph(WEIGHING)
    expect(nodes.every((n) => !n.reached)).toBe(true)
    expect(edges.every((e) => !e.taken)).toBe(true)
  })
})

describe('roles', () => {
  it('carries who may fire each transition, so the picture can say whose turn it is', () => {
    const { edges } = toGraph(WEIGHING)
    expect(edges.find((e) => e.transition === 'weigh')?.by).toEqual(['weigher'])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @pilots/process-ui exec vitest run test/to-graph.test.ts`
Expected: FAIL — cannot resolve `../src/web/graph/to-graph.js`.

- [ ] **Step 3: Implement `toGraph`**

Create `apps/process-ui/src/web/graph/to-graph.ts`:

```ts
/**
 * A process definition, as a graph — and an instance's history, as a path
 * through it.
 *
 * Pure and browser-free, so the rules below are unit-tested rather than
 * eyeballed. It is also the model Iteration 2's editor mutates, which is why it
 * returns plain nodes and edges rather than anything React Flow-shaped.
 *
 * Two rules are worth stating:
 *
 * - **Off-path is declared, not guessed.** A state whose `outcome` is
 *   `abandoned` goes in the lower lane; `fulfilled` stays on the main line as
 *   the happy ending. An earlier draft inferred this from "reached only by a
 *   wildcard", which got `REJECTED` and `EXPIRED` wrong in the quotation
 *   definition — both are ordinary transitions and neither is a happy ending.
 *   The definition now says so outright.
 * - **A wildcard is one edge, not many.** `from: ["*"]` expanded is four edges
 *   in `container-weighing` and six in `container-transport-with-terminal`, and
 *   the diagram stops being readable exactly where it should be clearest.
 */
import type { ProcessDefinition, SignedEvent } from '../api.js'

export const ANY_STATE_NODE = '__any__'

export interface GraphNode {
  id: string
  title: string
  layer: number
  lane: 'main' | 'off-path'
  kind: 'state' | 'any-state'
  terminal: boolean
  reached: boolean
  current: boolean
}

export interface GraphEdge {
  id: string
  source: string
  target: string
  transition: string
  title: string
  by: string[]
  wildcard: boolean
  taken: boolean
}

export interface ProcessGraph {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

export interface GraphOptions {
  history?: readonly SignedEvent[]
  current?: string
}

const isWildcard = (from: readonly string[]): boolean => from.includes('*')

export function toGraph(definition: ProcessDefinition, options: GraphOptions = {}): ProcessGraph {
  const wildcards = definition.transitions.filter((t) => isWildcard(t.from))
  const ordinary = definition.transitions.filter((t) => !isWildcard(t.from))

  // Layers: breadth-first from the initial state over ordinary edges only, so a
  // wildcard cannot drag an abort state into the middle of the happy path.
  const layers = new Map<string, number>([[definition.initialState, 0]])
  let frontier = [definition.initialState]
  while (frontier.length > 0) {
    const next: string[] = []
    for (const state of frontier) {
      for (const transition of ordinary) {
        if (!transition.from.includes(state) || !transition.to) continue
        if (layers.has(transition.to)) continue
        layers.set(transition.to, (layers.get(state) ?? 0) + 1)
        next.push(transition.to)
      }
    }
    frontier = next
  }
  const deepest = Math.max(0, ...layers.values())

  const taken = new Set<string>()
  const reached = new Set<string>()
  for (const one of options.history ?? []) {
    if (one.header.to) reached.add(one.header.to)
    if (one.header.from) reached.add(one.header.from)
    taken.add(one.header.transition)
  }

  const nodes: GraphNode[] = definition.states.map((state) => ({
    id: state.id,
    title: state.title,
    // An unreachable state still has to be drawn somewhere; the far right is
    // honest about it not being on the path from the initial state.
    layer: layers.get(state.id) ?? deepest + 1,
    // Declared by the definition, not inferred from the graph's shape.
    lane: state.outcome === 'abandoned' ? 'off-path' : 'main',
    kind: 'state',
    terminal: state.outcome !== undefined,
    reached: reached.has(state.id),
    current: options.current === state.id,
  }))

  if (wildcards.length > 0) {
    nodes.push({
      id: ANY_STATE_NODE,
      title: 'any state',
      layer: 0,
      lane: 'off-path',
      kind: 'any-state',
      terminal: false,
      reached: false,
      current: false,
    })
  }

  const edges: GraphEdge[] = definition.transitions.flatMap((transition) => {
    if (!transition.to) return []
    const wildcard = isWildcard(transition.from)
    const sources = wildcard ? [ANY_STATE_NODE] : transition.from
    return sources.map((source) => ({
      id: `${transition.id}:${source}`,
      source,
      target: transition.to as string,
      transition: transition.id,
      title: transition.title,
      by: transition.by,
      wildcard,
      taken: taken.has(transition.id),
    }))
  })

  return { nodes, edges }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @pilots/process-ui exec vitest run test/to-graph.test.ts`
Expected: PASS — 8 tests.

- [ ] **Step 5: Check it against every real definition**

Add this test to the same file, which is the guard on "a new definition needs no UI work":

```ts
describe('every committed definition', () => {
  it('produces a graph with no orphan edges and exactly one initial layer', async () => {
    const { readFile, readdir } = await import('node:fs/promises')
    const dir = new URL('../../../docs/definitions/', import.meta.url)
    for (const file of await readdir(dir)) {
      if (!file.endsWith('.json')) continue
      const definition = JSON.parse(
        await readFile(new URL(file, dir), 'utf8'),
      ) as ProcessDefinition
      const { nodes, edges } = toGraph(definition)
      const ids = new Set(nodes.map((n) => n.id))
      for (const edge of edges) {
        expect(ids, `${file}: ${edge.id} source`).toContain(edge.source)
        expect(ids, `${file}: ${edge.id} target`).toContain(edge.target)
      }
      expect(nodes.filter((n) => n.kind === 'state' && n.layer === 0)).toHaveLength(1)
    }
  })
})
```

Run: `pnpm --filter @pilots/process-ui exec vitest run test/to-graph.test.ts`
Expected: PASS across all five definitions.

- [ ] **Step 6: Verify**

`pnpm --filter @pilots/process-ui exec vitest run && pnpm typecheck && pnpm lint`. Report for review; do not commit.

---

### Task 5: The `StateDiagram` component

Implements spec §5.3 and P7. Read-only now, two flags from editable.

**Files:**
- Modify: `apps/process-ui/package.json` (add `@xyflow/react`)
- Create: `apps/process-ui/src/web/graph/StateDiagram.tsx`
- Create: `apps/process-ui/src/web/graph/layout.ts`

**Interfaces:**
- Consumes: `toGraph`, `GraphNode`, `GraphEdge`, `ANY_STATE_NODE`.
- Produces: `<StateDiagram definition={ProcessDefinition} history={SignedEvent[]} current={string} />`; `positionOf(node: GraphNode): { x: number; y: number }`.

- [ ] **Step 1: Add the dependency**

```bash
pnpm --filter @pilots/process-ui add @xyflow/react
```

Record in `docs/STACK.md` what it buys, in the section's own voice: MIT, 1.2 MB unpacked, chosen over `bpmn-js` (not MIT — the bpmn.io licence carries a logo-attribution requirement — and our definitions are not BPMN) and `mermaid` (84 MB unpacked, and text-only so it cannot become an editor). Note that layout is ours, so no `dagre`.

- [ ] **Step 2: Write the layout**

Create `apps/process-ui/src/web/graph/layout.ts`:

```ts
import { type GraphNode } from './to-graph.js'

const COLUMN = 210
const ROW = 110

/**
 * Positions, ours rather than a layout library's.
 *
 * Definitions are near-linear, so layer-times-column is enough — and an editor
 * wants positions that are stable and eventually persisted, not recomputed
 * under the cursor. That is the reason to own this rather than add `dagre`.
 */
export function positionOf(node: GraphNode, indexInLane: number): { x: number; y: number } {
  return {
    x: node.layer * COLUMN,
    y: node.lane === 'off-path' ? ROW * 2 + indexInLane * 60 : 0,
  }
}
```

- [ ] **Step 3: Write the component**

Create `apps/process-ui/src/web/graph/StateDiagram.tsx`:

```tsx
/**
 * The process, drawn.
 *
 * Mounted read-only: `nodesDraggable` and `nodesConnectable` are off, so this
 * is a picture. Iteration 2 turns both on and adds `onConnect` plus a
 * properties panel — the model underneath (`toGraph`) is already the one an
 * editor mutates, which is why React Flow was chosen over a hand-rolled SVG.
 */
import { Background, Controls, ReactFlow, type Edge, type Node } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useMemo } from 'react'

import type { ProcessDefinition, SignedEvent } from '../api.js'
import { positionOf } from './layout.js'
import { ANY_STATE_NODE, toGraph } from './to-graph.js'

export function StateDiagram({
  definition,
  history,
  current,
}: {
  definition: ProcessDefinition
  history?: readonly SignedEvent[]
  current?: string
}) {
  const { nodes, edges } = useMemo(
    () => toGraph(definition, { ...(history ? { history } : {}), ...(current ? { current } : {}) }),
    [definition, history, current],
  )

  const flowNodes: Node[] = useMemo(() => {
    const seen = new Map<string, number>()
    return nodes.map((node) => {
      const index = seen.get(node.lane) ?? 0
      seen.set(node.lane, index + 1)
      return {
        id: node.id,
        position: positionOf(node, index),
        data: { label: node.id === ANY_STATE_NODE ? 'any state' : node.title },
        draggable: false,
        style: {
          padding: '6px 10px',
          borderRadius: 8,
          fontSize: 12,
          border: node.current ? '2px solid #0f172a' : '1px solid #cbd5e1',
          background: node.current ? '#0f172a' : node.reached ? '#e2e8f0' : '#ffffff',
          color: node.current ? '#ffffff' : node.reached ? '#0f172a' : '#64748b',
          borderStyle: node.kind === 'any-state' ? 'dashed' : 'solid',
        },
      }
    })
  }, [nodes])

  const flowEdges: Edge[] = useMemo(
    () =>
      edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        label: edge.title,
        animated: false,
        style: {
          strokeWidth: edge.taken ? 2.5 : 1,
          stroke: edge.taken ? '#0f172a' : '#94a3b8',
          strokeDasharray: edge.wildcard ? '4 4' : undefined,
        },
        labelStyle: { fontSize: 10, fill: edge.taken ? '#0f172a' : '#64748b' },
      })),
    [edges],
  )

  return (
    <div className="h-72 w-full rounded-lg border border-slate-200 dark:border-slate-800">
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        fitView
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        proOptions={{ hideAttribution: false }}
      >
        <Background />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  )
}
```

- [ ] **Step 4: Verify it renders**

`pnpm typecheck && pnpm lint && pnpm build`, then `docker compose up -d --build org-a-ui` and confirm the bundle builds and the app still loads. The component is wired into a screen in Task 7.

- [ ] **Step 5: Check the image did not blow its limit**

```bash
docker compose up -d --build org-a-ui
docker stats --no-stream --format '{{.Name}} {{.MemUsage}} {{.MemPerc}}' pilots-service-org-a-ui-1
```

The UI runs under `mem_limit: 512m`. If the figure moved materially from ~44 MiB, say so — `docs/ARCHITECTURE.md` §12.1 records it and a stale number is worse than a large one. Report for review; do not commit.

---

### Task 6: The processes list, grouped by whose turn it is

Implements spec §6. `available` is already on `GET /instances`, computed by the connector from the definition — the UI does not get a second opinion.

**Files:**
- Modify: `apps/process-ui/src/web/views/Processes.tsx`
- Create: `apps/process-ui/src/web/views/grouping.ts`
- Test: `apps/process-ui/test/grouping.test.ts`

**Interfaces:**
- Consumes: `InstanceView` from `api.ts`.
- Produces: `groupInstances(instances: readonly InstanceView[]): { yours: InstanceView[]; waiting: InstanceView[]; done: InstanceView[] }`
- **Simplified by Task 0:** the connector now sends `outcome` on every instance, so this needs no definition lookup at all.

- [ ] **Step 1: Write the failing test**

Create `apps/process-ui/test/grouping.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { groupInstances } from '../src/web/views/grouping.js'
import type { InstanceView } from '../src/web/api.js'

function instance(over: Partial<InstanceView>): InstanceView {
  return {
    id: '01J', kind: 'service', definition: 'container-weighing@1.0.0',
    participants: {}, quotationId: null, offering: null,
    state: 'ORDERED', seq: 1, data: {}, createdAt: '', updatedAt: '',
    home: false, available: [], redacted: false, outcome: 'running', ...over,
  }
}

describe('grouping a process list', () => {
  it('puts an instance with an available transition under "your turn"', () => {
    const one = instance({ available: [{ transition: 'announceTruck', role: 'shipper' }] })
    expect(groupInstances([one]).yours).toEqual([one])
  })

  it('puts a live instance with nothing to do under "waiting"', () => {
    const one = instance({ state: 'TRUCK_ANNOUNCED', available: [] })
    expect(groupInstances([one]).waiting).toEqual([one])
  })

  it('puts a finished instance under "done", however it finished', () => {
    // Both endings belong in the same bucket, and neither needs a state name:
    // the connector already said whether this process is over.
    const good = instance({ id: 'a', state: 'VGM_ISSUED', outcome: 'fulfilled' })
    const bad = instance({ id: 'b', state: 'CANCELLED', outcome: 'abandoned' })
    expect(groupInstances([good, bad]).done.map((i) => i.id).sort()).toEqual(['a', 'b'])
  })

  it('orders each group by most recently updated first', () => {
    const older = instance({ id: 'a', updatedAt: '2026-08-24T09:00:00.000Z' })
    const newer = instance({ id: 'b', updatedAt: '2026-08-24T10:00:00.000Z' })
    expect(groupInstances([older, newer]).waiting.map((i) => i.id)).toEqual(['b', 'a'])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @pilots/process-ui exec vitest run test/grouping.test.ts`
Expected: FAIL — cannot resolve `grouping.js`.

- [ ] **Step 3: Implement the grouping**

Create `apps/process-ui/src/web/views/grouping.ts`:

```ts
import type { InstanceView } from '../api.js'

export interface GroupedInstances {
  yours: InstanceView[]
  waiting: InstanceView[]
  done: InstanceView[]
}

/**
 * Whose turn it is, from `available`, and whether it is over, from `outcome` —
 * both computed by the connector from the definition. The UI does not get a
 * second opinion about permission or about finality; it only decides where to
 * put the row.
 */
export function groupInstances(instances: readonly InstanceView[]): GroupedInstances {
  const recentFirst = [...instances].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  const grouped: GroupedInstances = { yours: [], waiting: [], done: [] }
  for (const one of recentFirst) {
    if (one.outcome !== 'running') grouped.done.push(one)
    else if (one.available.length > 0) grouped.yours.push(one)
    else grouped.waiting.push(one)
  }
  return grouped
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @pilots/process-ui exec vitest run test/grouping.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Render the groups**

In `views/Processes.tsx`, render three labelled sections — **Your turn**, **Waiting on them**, **Done** — hiding any that is empty. Each row shows the definition **title** (from the definitions query, falling back to the ref), the counterparty's display name (from the connections query, falling back to the DID), the state, `n of m` progress from the definition's state count, and a relative time. Give the row `data-testid="instance-row"` so the existing Playwright spec keeps working.

- [ ] **Step 6: Verify**

`pnpm --filter @pilots/process-ui exec vitest run && pnpm typecheck && pnpm lint && pnpm build && pnpm test:e2e`. Report for review; do not commit.

---

### Task 7: Process detail — the diagram, and a form that survives a refresh

Implements spec §4.3 and P5, P6. This is where the live refresh has to not hurt.

**Files:**
- Modify: `apps/process-ui/src/web/views/ProcessDetail.tsx`

**Interfaces:**
- Consumes: `StateDiagram`, `queries`, `api`, `UiError`.
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Show the diagram**

Above the data document, render `<StateDiagram definition={definition} history={events} current={instance.state} />`, using the existing definition and events queries.

- [ ] **Step 2: Keep form state out of server state**

The open transition's field values live in `useState` in the form component and are **never** written from a query result. Capture the `seq` the form was opened at:

```tsx
const [form, setForm] = useState<{ transition: string; openedAtSeq: number } | null>(null)
```

- [ ] **Step 3: Add the moved-underneath-you banner**

```tsx
{form && instance.seq !== form.openedAtSeq && (
  <div
    data-testid="moved-banner"
    className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
  >
    This process moved on while you were filling this in — it is now{' '}
    <strong>{instance.state}</strong>. Your entries are untouched; submitting may be refused.
  </div>
)}
```

Non-blocking by design: nothing is disabled and no field is cleared.

- [ ] **Step 4: Render the conflict honestly**

```tsx
onError: (cause: unknown) => {
  // The form carried the seq it was opened at, so the connector answered 409.
  // Say so rather than silently re-reading and resubmitting — that would be a
  // lost update, and it would throw away the concurrency control the protocol
  // already provides.
  if (cause instanceof UiError && cause.isConflict) {
    setConflict(`Somebody moved first — this is now at step ${cause.problem.seq ?? '?'}.`)
    return
  }
  setConflict(cause instanceof Error ? cause.message : String(cause))
},
```

- [ ] **Step 5: Verify by hand, in two browsers**

```bash
docker compose up -d --build
```

Open an instance in Org A's UI and start filling a transition form. In Org B's UI, apply a transition to the same instance. Within ~5 s Org A must show the banner **with the typed values still present**. Submitting then shows the conflict message rather than silently succeeding.

- [ ] **Step 6: Verify**

`pnpm typecheck && pnpm lint && pnpm build && pnpm test:e2e`. Report for review; do not commit.

---

### Task 8: Start from an offering, and surface quotations

Implements spec §6.

**Files:**
- Modify: `apps/process-ui/src/web/views/Start.tsx`
- Create: `apps/process-ui/src/web/views/Offerings.tsx`
- Modify: `apps/process-ui/src/web/App.tsx` (a third tab)

- [ ] **Step 1: Offerings browser**

`views/Offerings.tsx` lists offerings from the offerings query as cards: title, the peer's display name, price when present, and a **Start one** action that navigates to `Start` pre-filled with that offering's definition and the peer in the provider role.

- [ ] **Step 2: Show what you are about to start**

In `Start.tsx`, once a definition is chosen, render `<StateDiagram definition={definition} />` above the role pickers, so the shape of the process is visible before committing to it.

- [ ] **Step 3: Group quotations separately**

In `Processes.tsx`, split rows by `kind`: `quotation` rows go under a **Quotations** heading showing price and conditions from `data`, with a link to the service instance they authorise when `quotationId` is set on another instance.

- [ ] **Step 4: Verify**

`pnpm typecheck && pnpm lint && pnpm build`, then walk the flow: browse an offering, start from it, see the diagram before starting. Report for review; do not commit.

---

### Task 9: End-to-end coverage and documentation

**Files:**
- Modify: `tests/e2e/process-ui.spec.ts`
- Modify: `README.md`, `docs/ARCHITECTURE.md`, `docs/STACK.md`, `CLAUDE.md`

- [ ] **Step 1: Write the session-isolation regression test**

This is the guard on Task 1. **The existing specs could never have caught this bug**, because `browser.newPage()` creates a *new browser context* with its own cookie jar. The bug only appears when both UIs share one jar, so the test must use `context.newPage()`:

```ts
test('signing into the other org does not sign this one out', async ({ page, context }) => {
  await page.goto('/')
  await signIn(page, ORG_A)
  await expect(page.getByTestId('participant')).toHaveText(/./)

  // The same context, therefore the same cookie jar — which is the whole point.
  // Cookies ignore the port, so before the cookiePrefix fix this signed Org A
  // out. `browser.newPage()` would open a fresh jar and prove nothing.
  const other = await context.newPage()
  await other.goto(ORG_B_UI)
  await signIn(other, ORG_B)
  await other.close()

  await page.reload()
  await expect(page.getByTestId('participant')).toBeVisible()
  await expect(page.getByTestId('did')).toHaveText('did:web:org-a.example')
})
```

- [ ] **Step 2: Write the live-refresh test**

```ts
test('picks up the other side’s move without a reload', async ({ page, context }) => {
  await page.goto('/')
  await signIn(page, ORG_A)
  // …start a weighing and announce the truck, as the existing spec does…

  const other = await context.newPage()
  await other.goto(ORG_B_UI)
  await signIn(other, ORG_B)
  // …open the same instance and apply `weigh`…
  await other.close()

  // No reload: polling is the whole claim being tested here.
  await expect(page.getByTestId('state')).toHaveText('WEIGHED', { timeout: 15_000 })
})
```

- [ ] **Step 3: Write the diagram test**

Assert the diagram is present on the detail view and marks the current state — e.g. `await expect(page.locator('.react-flow__node')).toHaveCount(6)` for `container-weighing` (five states plus the any-state marker), and that the current state's node is rendered.

- [ ] **Step 4: Run the whole e2e suite**

```bash
pnpm demo:env && docker compose up -d --build
pnpm test:e2e
```
Expected: 11 specs pass (8 existing + 3 new).

- [ ] **Step 5: Update the documents**

- `README.md` — the demo guide's two-browser walkthrough gains the diagram and the fact that screens keep themselves up to date; note that two UIs on one host need different `PILOTS_UI_COOKIE_PREFIX` values.
- `docs/STACK.md` — `@tanstack/react-query` moves from named to installed; `@xyflow/react` added with what it buys.
- `docs/ARCHITECTURE.md` §12.1 — re-measure the UI container's memory and image size if they moved.
- `CLAUDE.md` — the repo structure block gains `src/web/graph/`, `src/web/live/` and `src/web/views/`.

- [ ] **Step 6: Full gate**

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm lint:definitions && pnpm format:check
pnpm test:e2e
docker compose down -v
```

Report to the supervisor for review and commit.

---

## Self-review

**Spec coverage.** §3 → Task 1. §4.2 → Task 2. §4.3 → Task 7. §5.2 → Task 4. §5.3 → Task 5. §6 → Tasks 6 and 8. §7 structure → Task 3; §7 tests → Tasks 2, 4, 6, 9. §8 (what Iteration 2 inherits) is satisfied by Task 4 returning a plain node/edge model and Task 5 mounting React Flow with the two flags off. §9 open items are deliberately not implemented.

**Type consistency.** `ChangeFeed.subscribe` returns `() => void` in Tasks 2 and 3. `toGraph(definition, options)` takes `{ history, current }` in Tasks 4, 5 and 7. `GraphEdge` uses `source`/`target` (React Flow's names) consistently in Tasks 4 and 5 — not `from`/`to`, which are the *definition's* names and would collide. `groupInstances` takes only the instances in Task 6: Task 0 put `outcome` on every instance view, so no definition lookup is needed.

**Known gap, deliberate.** Task 8's "link to the service instance a quotation authorises" needs a reverse lookup — the quotation does not point at the service, the service points back via `quotationId`. The implementer should scan the loaded instance list rather than adding an endpoint.
