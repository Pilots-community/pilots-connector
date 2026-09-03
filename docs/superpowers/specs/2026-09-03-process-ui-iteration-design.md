# Process UI: sessions, live refresh, and the process diagram

*Design decision record. 2026-09-03. Iteration 1 of two. Affects `apps/process-ui` only; the connector,
the protocol and the client package are unchanged. Iteration 2 — authoring process definitions from the
UI — gets its own record, and this one is written so that it does not have to be undone first.*

Status: **accepted**, not yet implemented.

Decisions are numbered `P1…` to avoid colliding with the `D` series in the
[2026-08-26 record](2026-08-26-component-split-and-persistence-design.md).

---

## 1. What prompted this

Four pieces of feedback from driving the demo by hand, after M6:

1. **Refreshing the process UI signs you out.**
2. **When Org B starts a process with Org A, Org A's screen does not notice.** Wanted: refresh when new
   data exists, without disturbing an open form.
3. **Starting a process still feels difficult**, and there is no picture of the process — wanted: the
   state machine drawn, and progress through it visible for a demo audience.
4. **Offerings, quotations and processes deserve a friendlier viewer.**

Item 1 was reproduced before anything was designed, and the diagnosis changed the fix (§3). Item 2's
answer is shaped by a detail found while checking it: the connector records a notification **only when a
subscription exists**, which is what makes polling the right first mechanism (§4). Item 3's answer
changed after the supervisor pointed out that viewing becomes editing in Iteration 2 (§5).

M7 (publish and deploy) is **locked** until this functional iteration lands.

## 2. Decisions

| # | Decision | Alternative rejected |
|---|---|---|
| P1 | Give each process UI its own cookie name, from `PILOTS_UI_COOKIE_PREFIX`. | Deriving it at boot from `client.me()`. Rejected: a boot-order fallback that changes the cookie name silently signs everyone out — the exact bug being fixed. |
| P2 | Sessions stay in memory: restarting a UI container signs you out, and that is **intended**. | A file-backed `better-auth` adapter. Rejected: ~150 lines of store for a demo UI that deliberately has none, and a password may legitimately change across a restart. |
| P3 | Freshness by **polling plus window focus**, at 5 s. | SSE end-to-end now. Rejected: the notification path already has a first-class demonstration (the mock backoffice), so this would re-plumb machinery without demonstrating a new claim — and it adds a failure mode polling cannot have, a silently dead stream. |
| P4 | The refresh trigger is a **port**. Polling is one adapter; a notification-driven nudge is a second, added without touching callers. | Hard-wiring `refetchInterval` at each call site. Rejected: makes the upgrade in P3's note a rewrite rather than a new adapter. |
| P5 | Server state and form state are strictly separate. A refresh never touches a field you have typed in. | Blocking refresh while a form is open. Rejected: it makes the screen quietly stale, which is worse than a visible conflict. |
| P6 | A stale submit is allowed to fail. The form carries the `seq` it was opened at; the connector answers `409`, which the UI renders as "somebody moved first". | Silently re-reading `seq` and resubmitting. Rejected: that is a lost update, and it would discard the concurrency control the protocol already provides. |
| P7 | Render the diagram with **`@xyflow/react`** (React Flow), MIT. | `bpmn-js` (non-MIT, logo attribution, and our definitions are not BPMN); `mermaid` (84 MB unpacked, buys only layout); hand-rolled SVG (throws away the renderer when editing arrives). See §5. |
| P8 | **Hand-roll the layout** — BFS layering, terminal states in their own lane. | `dagre` or `elkjs`. Rejected: definitions are near-linear, and an editor wants positions that are stable and eventually persisted, not recomputed under the cursor. |
| P9 | A `from: ["*"]` transition renders as **one** edge from an "any state" marker. | One edge per source state. Rejected: `cancel` alone becomes four edges in `container-weighing` and six in `container-transport-with-terminal`, and the diagram stops being readable at exactly the point it should be. |
| P12 | ~~"Off the happy path" means **reached only by a wildcard transition**~~ — **superseded, see the amendment below.** | — |
| P10 | Add `@tanstack/react-query`. | A third hand-rolled fetch layer. Rejected: `docs/STACK.md` §6 already names it, and interval + focus refetch + cache invalidation is precisely what it does. |
| P11 | `toGraph()` lives in `apps/process-ui`, not `packages/protocol`. | Promoting it to the protocol package. Rejected: layout is presentation. The protocol is the spec, and no peer needs to agree on where a node is drawn. |

## 3. Sessions — the bug was not what it looked like

**Symptom.** "Refresh the process UI and I'm logged out."

**Reproduced.** Signing into Org B's UI on `:4001` moves Org A's UI on `:4000` from
`signed in as alice@org-a.example` to the sign-in screen. No refresh is needed; the refresh only reveals
it.

**Root cause.** **Cookies ignore the port.** Both UIs set a cookie named exactly
`better-auth.session_token`, `Path=/`, host `localhost` — so `:4000` and `:4001` address the *same*
cookie. Whichever signs in second overwrites the first. Org A's BFF then receives Org B's token, which
its own in-memory store and different `authSecret` do not recognise, so `/api/ui/session` answers
`user: null`.

The cookie itself was never wrong: `Max-Age=604800`, `HttpOnly`, `SameSite=Lax`, and a single UI
survives reload correctly. This is a **two-UI-in-one-browser** bug, and it could only appear once the
demo put two process UIs side by side — which is exactly what the M5 demo does.

**Fix (P1).** `advanced.cookiePrefix` in `createAuth`, from a new `PILOTS_UI_COOKIE_PREFIX`, defaulting
to `pilots` (compose sets `org-a` / `org-b`). The default is deliberately *not* unique: a single UI
needs no ceremony, and the `.env.example` and compose comments carry the rule that two process UIs on
the same host **must** differ here. `pnpm demo:env` does not generate it — it is configuration, not a
credential.

**Also fixed.** `/api/ui/session` failing currently leaves `ready` false forever, so the SPA renders
`null` — a blank page rather than a sign-in screen. It gets error handling.

**Deliberately not fixed (P2).** Restarting a UI container still signs everyone out, because
`better-auth`'s memory adapter holds the sessions. This is accepted, and on reflection it is the correct
behaviour for a demo: credentials can change between restarts, so re-authenticating is a feature rather
than a defect. The limitation is stated in `auth.ts` where a reader will meet it.

## 4. Freshness — a port with polling in it

### 4.1 Why not SSE first

The connector already exposes `GET /api/local/v1/events?since=<cursor>` (SSE, scope `events:read`,
which the seeded UI key holds). It is tempting, and it is not the right first move:

- **It would need a seeded subscription per org.** `NotificationService` records nothing when a
  participant has no subscription (`if (subscriptions.length === 0) continue`), so the stream is silent
  for Org A today. The demo only seeds one, for Org B's backoffice, in the automated overlay.
- **The notification path is already demonstrated** by `apps/mock-backoffice`. A second consumer of the
  same mechanism adds plumbing, not evidence.
- **A dead stream is invisible.** Polling degrades to "a little late"; a silently closed `EventSource`
  degrades to "confidently wrong".

At 5 s the demo moment — Org B acts, Org A's screen catches up unaided — is intact.

### 4.2 The port (P4)

One place decides *when* to revalidate; the call sites only say *what* they need. Polling and window
focus are the two adapters now:

```ts
// apps/process-ui/src/web/live/change-feed.ts
export interface ChangeFeed {
  /** Called when something may have changed. Returns an unsubscribe. */
  subscribe(onChange: () => void): () => void
}
```

`pollingFeed(intervalMs)` and `focusFeed()` are composed into the one `useLiveSync()` the shell mounts,
which invalidates the `instances` query key. **Adding a notification-driven nudge is then a third
adapter and nothing else changes** — `sseFeed('/api/ui/changes')`, plus a BFF route relaying the
connector's stream, plus the seeded subscription §4.1 names as the prerequisite. That prerequisite is
recorded here precisely so it is not rediscovered later.

### 4.3 Not disturbing an open form (P5, P6)

- The list and the diagram revalidate freely.
- A transition form's fields are local state. **No refresh writes to them.**
- If the instance's `seq` advances while a form is open, a non-blocking banner appears —
  "Org B weighed this — now `WEIGHED`" — with the form left alone.
- Submitting anyway sends the `seq` the form was opened at, so the connector answers `409` and the UI
  renders "somebody moved first", showing what changed.

The UI's staleness handling and the protocol's concurrency control are therefore **the same
mechanism**, which is worth more in front of an audience than hiding the conflict.

## 5. The diagram — chosen for the editor that is coming

### 5.1 Why the first recommendation was wrong

The original recommendation was a hand-rolled SVG, on the grounds that four of the five definitions are
linear. That reasoning only holds for *viewing*. Iteration 2 makes this an editor, and rendering is the
cheap half: drag, connect-by-dragging, hit-testing, selection, pan/zoom and undo are the expensive half.
Hand-rolling now means **discarding the renderer** when editing arrives, so the switching cost is
asymmetric and the choice should be made once.

| | Unpacked | Licence | View | Edit |
|---|---|---|---|---|
| `@xyflow/react` 12.11.5 | 1.2 MB | MIT | yes | **purpose-built** |
| `bpmn-js` 18.27 | 5.3 MB | "SEE LICENSE IN LICENSE" | yes | yes |
| `mermaid` 11.17 | **84 MB** | MIT | yes | no — text only |
| hand-rolled | 0 | — | yes | all new work |

`bpmn-js` is **not MIT**: the bpmn.io licence carries a logo-attribution requirement, which matters for
a repository that assumes it becomes public and gets shown to customers. It would also mean a lossy
bidirectional mapping, because `by` roles, `guards`, JSON Schema `patch` and `deadline`/`onDeadline`
have no clean home in BPMN XML — and the definition, not the drawing, is the spec. `mermaid` at 84 MB
unpacked buys only layout, which fails this repository's own "say what it buys" test.

React Flow peer-depends on `react >=17`, so React 19 is fine. It is the boring, standard piece in its
niche.

### 5.2 What is drawn

`toGraph(definition, events?)` is pure, and therefore unit-testable without a browser:

- **Layers** by breadth-first search from `initialState`, left to right.
- **Off-path states in their own lane below**, so the happy path stays a straight line. "Off-path"
  is computed, not listed (P12): a state reached **only** by a wildcard transition. Across the five
  definitions that yields exactly `CANCELLED` or `WITHDRAWN`, and never a successful ending.

  The obvious rule — `definition.terminalStates` — is **wrong**, and worth recording as a trap. That
  array is explicit on the definition and contains the *successful* endings too: `VGM_ISSUED`,
  `AGREED`, `DELIVERED`. Using it would draw the happy ending in the abort lane. `isTerminal()` and
  `expandFromStates()` are exported from `packages/protocol` and should be used rather than
  re-derived; note that `expandFromStates` already excludes terminal states, because a `["*"]`
  cancellation must not resurrect a delivered instance.
- **`from: ["*"]` collapses to one edge** from an "any state" marker (P9). Expanded, `cancel` is four
  edges in `container-weighing` and six in `container-transport-with-terminal`; the picture stops
  being readable at exactly the point it should be.
- **Loops are drawn as loops.** The quotation definition's `OFFERED ⇄ COUNTERED` counter-offer cycle is
  the most interesting thing in the whole demo to show, and a stepper cannot express it. Of the five
  definitions, `container-transport-quotation` is the only one that genuinely branches, and it is the
  reason a graph beats a progress bar.
- **The path actually taken** comes from the instance's event log (`header.transition`, `from`, `to`)
  and is drawn bold; the current state is highlighted; unreached states are dimmed.

That single view answers both of the supervisor's asks — "the state machine visualised" and "showcase
the progress" — and because it is derived from the definition, **a new process still needs no UI work**,
which is an existing claim this must not break.

### 5.3 Mounted for viewing, wired for editing

Now: `nodesDraggable={false}`, `nodesConnectable={false}`, `fitView`, zoom controls. Iteration 2 flips
those two flags and adds `onConnect` plus a properties panel. No re-render, no second library.

## 6. Viewers

- **Processes**, grouped **Your turn / Waiting on them / Done**. This is free: `available` is already on
  the `GET /instances` response, computed by the connector from the definition — the UI does not get a
  second opinion about whose turn it is.
- Definition **titles** rather than `container-weighing@1.0.0`; counterparty by display name rather than
  DID; relative times; `3 of 5` progress.
- **Process detail**: header, the diagram, the data document as this participant may see it, available
  transitions as the primary actions, and the existing event log with its verification status.
- **Start** is entered from an **offering** — "Org B offers container weighing → start one" — with the
  diagram shown *before* committing, so you can see what you are starting. The definition-first path
  stays for definitions nobody has published.
- **Quotations** get their own group, with price and conditions, and a link to the service instance they
  authorise (`quotationId` is already on the instance).

## 7. Structure and testing

`apps/process-ui/src/web/App.tsx` is **590 lines** carrying shell, list, detail and start form over
hand-rolled fetch state. That is where "refresh without disturbing a form" would be hardest to get
right, so it is split as part of this work rather than after it:

```
src/web/
  App.tsx                    the shell: auth gate, header, tab routing
  live/change-feed.ts        the ChangeFeed port + polling and focus adapters
  live/useLiveSync.ts        mounts the feeds, invalidates query keys
  queries.ts                 react-query keys and fetchers
  views/Processes.tsx        the grouped list
  views/ProcessDetail.tsx    header, diagram, data, transitions, log
  views/Start.tsx            offering-first start flow
  views/Offerings.tsx        the offerings browser
  graph/toGraph.ts           pure definition + events → nodes/edges
  graph/StateDiagram.tsx     the React Flow surface
  components/                SchemaForm, EventLog (existing)
```

Tests, at the tier that can actually hold the rule:

- **Vitest, pure**: `toGraph` — layering, the terminal lane, wildcard collapsing (P9), loop retention,
  path marking from an event log. Turn-grouping from `available`.
- **Playwright**: three specs, the first being the regression guard for §3 —
  1. **signing into Org B does not disturb Org A** (the bug this iteration exists for);
  2. Org B acts and Org A's list updates **without a reload**;
  3. the diagram shows the current state and the path taken.

Per `docs/TESTING.md`, no protocol behaviour moves into the e2e tier; these cover wiring and UI only.

## 8. What Iteration 2 inherits

Written down so the next record does not have to undo anything here:

- React Flow is already the surface; editing is two flags and an `onConnect` handler (§5.3).
- `toGraph` is pure and reversible in shape — nodes and edges are the same model an editor mutates.
- Layout is ours (P8), so persisted node positions have somewhere to live.
- The ChangeFeed port (P4) already exists for the notification-driven nudge.

## 9. Open, deliberately

- **Node positions are not persisted.** Layout is recomputed per render. Iteration 2 needs somewhere to
  keep them; that is a definition-authoring concern, not a viewing one.
- **The notification nudge is designed for, not built** (§4.2). It needs a seeded `sse` subscription per
  participant, which is a compose change plus a BFF route.
- **Sessions do not survive a UI restart** (P2), by choice.
- **No accessibility pass** on the diagram. A graph is the wrong primitive for a screen reader, and the
  underlying data is available as the event log and the transition list, which are ordinary DOM.

---

## Amendment, 2026-09-03 — states declare how a process ends (P13)

P12 above invented a heuristic because the definition could not answer the question. Building the
diagram exposed that as a symptom of a real gap, and the supervisor named it: a process's
**business** state (`VGM_ISSUED`) and its **generic** outcome (it finished, and it finished well) are
two different things, and only the first was expressed.

`terminalStates` said *that* a process had ended and never *how*. In `container-transport-quotation`,
`AGREED`, `REJECTED` and `EXPIRED` are all terminal and all reached by ordinary transitions, so no
amount of graph inspection separates the good ending from the bad ones. The heuristic could not have
worked; it only looked like it did because `container-weighing` is simple.

**P13.** `states[].outcome` is `fulfilled` or `abandoned`, absent means running, and its presence
**is** what makes a state terminal — `terminalStates` is derived and the schema field is gone, so two
places can no longer disagree. The computed value travels on `GET /instances` and in every
notification envelope, beside `available` and for the same reason: *the connector computed it from the
definition, so an internal system needs no state machine.* A back-office system closes its ticket on
`fulfilled` without ever learning that `VGM_ISSUED` is one particular process's good ending.

The diagram's lane rule becomes `outcome === 'abandoned'`, which is declared rather than guessed —
and which correctly puts `REJECTED` and `EXPIRED` off the happy path, where the heuristic left them on
it.

**Rejected:** reserved state ids (`ONGOING`, `FINALISED`) inside the state machine. That mixes levels
and takes vocabulary away from the business process, which is the one thing a definition exists to own.
