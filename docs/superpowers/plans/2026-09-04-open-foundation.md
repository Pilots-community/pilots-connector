# M6.5 Open Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the connector run anyone's valid process — author definitions from the UI or from JSON, validate them generically, refuse instances that can never succeed, and let a peer adopt a definition it has never seen.

**Architecture:** One new pure module in `packages/protocol` (`engine/reachability.ts`) computes a *fireability-aware* graph over a definition, and everything else consumes it: four new lint rules, the connector's creation check, and the process UI's "can this be started standalone?" affordance. Definitions gain a store collection and a runtime publish path; the boot directory becomes a seed rather than the authority. A peer's unknown definition is fetched over the peer surface that already serves it, held pending, and adopted once per ref.

**Tech Stack:** TypeScript strict + `noUncheckedIndexedAccess`, zod 4, Ajv 2020-12, Vitest 4, NestJS 11 + Fastify, React 19 + Vite + Tailwind 4, `@xyflow/react`.

**Spec:** [`docs/superpowers/specs/2026-09-04-open-foundation-design.md`](../specs/2026-09-04-open-foundation-design.md)

## Global Constraints

- **Never run `git add`, `git commit`, `git push`, or any other git write.** `CLAUDE.md` reserves them for the human supervisor and `.claude/settings.json` blocks them. Every task ends with a **Verify** step; when it is green, stop and report the task as ready to review and commit.
- **Gate before declaring any task done:** `pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm lint:definitions && pnpm format:check`.
- **`packages/protocol` is the spec.** Behaviour that is not schema or tested function there is not decided. New protocol code gets its tests in `packages/protocol/test/`.
- **Two validators, never unified:** zod 4 for protocol shapes, Ajv 2020-12 for JSON Schema *inside* definitions.
- **The boundary rule is lint-enforced:** `apps/process-ui` may import `packages/client` and `packages/protocol`, **never** `apps/connector`.
- **No domain vocabulary** in the connector, the protocol, the client or the base UIs — no logistics terms in identifiers, user-visible strings, or placeholder values. Test fixtures and doc comments may name the shipped example definitions.
- **No real company names.** The two orgs are `org-a` / `org-b`; display names come from `ORG_A_NAME` / `ORG_B_NAME`.
- **Never commit credentials.** Test keys are generated at test setup.
- **Tests are hermetic**: no network, no containers, no real clock, no filesystem outside a temp dir.
- **Every settings-driven weakening defaults to the safe value** and is reported by `postureOf`.
- **Editor layout never goes inside a definition document** (spec F7). `definitionHash` covers the
  document's bytes, so a node position stored there would mean *dragging a box changes the hash*,
  invalidating instances and forcing every peer to re-adopt an identical process. No layout is built
  in this milestone; this constraint exists so none is added inside the document by accident.

## File Structure

**`packages/protocol`**
- Create `src/engine/reachability.ts` — the fireability-aware graph and its analyses. Pure, no I/O. Consumed by the linter (Task 2), the connector (Task 5) and, through the API, the process UI.
- Create `test/reachability.test.ts`.
- Modify `src/lint/linter.ts` — four new rules (Task 2), pointer fixes (Task 3). Delegates all graph reasoning to `reachability.ts`; it must not grow its own copy.
- Modify `src/schemas/instance.ts` — `definitionHash` in `InstanceGenesis` (Task 4).
- Modify `src/schemas/api-key.ts` — the `definitions:write` scope and its operation mapping (Task 7).
- Create `src/lint/diff.ts` — structural diff between two definitions (Task 9). Separate from `linter.ts`: different job, different consumers.

**`apps/connector`**
- Create `src/definitions/definition-store.ts` — the `definitions` collection's document type and its queries.
- Modify `src/definitions/definition-registry.ts` — store hydration and runtime registration.
- Create `src/definitions/definition.service.ts` — lint, publish, fetch-from-peer, adopt. Keeps `local.controller.ts` and `admin.controller.ts` thin.
- Modify `src/instances/instance.service.ts` — the creation check (Task 5).
- Modify `src/api/local.controller.ts`, `src/api/admin.controller.ts` — endpoints.
- Modify `src/delivery/peer-delivery.service.ts` — the pending-adoption branch (Task 8).
- Modify `src/replication/replication.service.ts` — fetch instead of refuse (Task 8).

**`apps/process-ui`**
- Create `src/web/views/Authoring.tsx` — the JSON editor, diagnostics, live diagram.
- Modify `src/web/App.tsx`, `src/web/api.ts`, `src/web/queries.ts`, `src/server/routes.ts`.

**`apps/connector/src/admin-ui`**
- Modify `src/App.tsx` — pending definitions, the diff screen, and the definition-driven offering prefill (Task 12).

---

### Task 1: The fireability-aware graph

Implements the shared substrate for spec F1 and F2. Nothing user-visible ships in this task; everything after it depends on the vocabulary defined here.

The insight this encodes: a definition's edges are not all walkable. `by: []` means no participant may fire it, but the engine may (`auto`), the clock may (a `deadline` arming into the source state), or a linked instance may (a `links` entry naming it) — and the last of those only when the relation the link names is **anchored on the instance**.

**Files:**
- Create: `packages/protocol/src/engine/reachability.ts`
- Modify: `packages/protocol/src/index.ts` (export the new module)
- Test: `packages/protocol/test/reachability.test.ts`

**Interfaces:**
- Consumes: `ProcessDefinition`, `expandFromStates`, `parseLinkEvent`, `outcomeOf`, `terminalStates` from `../schemas/definition.js`.
- Produces:
  - `type EdgeDriver = 'participant' | 'auto' | 'deadline' | { link: string }`
  - `interface DefinitionEdge { from: string; to: string; transition: string; transitionIndex: number; drivers: EdgeDriver[] }`
  - `function definitionEdges(definition: ProcessDefinition): DefinitionEdge[]`
  - `interface ReachabilityOptions { anchoredRelations?: readonly string[] | 'all' }`
  - `interface Reachability { reachable: Set<string>; fulfilmentReachable: boolean; unlockingRelations: string[] }`
  - `function analyseReachability(definition: ProcessDefinition, options?: ReachabilityOptions): Reachability`
  - `function statesWithoutFireableExit(definition: ProcessDefinition): string[]`
  - `function statesWithoutFulfilment(definition: ProcessDefinition): string[]`

`anchoredRelations` defaults to `[]` (nothing anchored — the standalone question). `'all'` answers the definition-level question. `unlockingRelations` is empty unless `fulfilmentReachable` is false, and then lists relations that would make it true if anchored.

- [ ] **Step 1: Write the failing test**

Create `packages/protocol/test/reachability.test.ts`. `defineProcess` is a small local helper so each case reads as a graph, not as a document.

```ts
import { describe, expect, it } from 'vitest'

import { ProcessDefinition } from '../src/schemas/definition.js'
import {
  analyseReachability,
  definitionEdges,
  statesWithoutFireableExit,
  statesWithoutFulfilment,
} from '../src/engine/reachability.js'

/** A minimal valid definition, so each case shows only what it is testing. */
function defineProcess(overrides: Partial<Record<string, unknown>>): ProcessDefinition {
  return ProcessDefinition.parse({
    '@context': 'https://pilots.example/process/v1',
    id: 'p',
    version: '1.0.0',
    kind: 'service',
    title: 'P',
    roles: [
      { id: 'a', title: 'A', cardinality: 1, protocolRole: 'requester' },
      { id: 'b', title: 'B', cardinality: 1, protocolRole: 'provider' },
    ],
    hostedBy: 'b',
    initialState: 'START',
    states: [
      { id: 'START', title: 'Start' },
      { id: 'DONE', title: 'Done', outcome: 'fulfilled' },
      { id: 'GONE', title: 'Gone', outcome: 'abandoned' },
    ],
    data: { type: 'object' },
    transitions: [],
    visibility: [],
    links: [],
    ...overrides,
  })
}

describe('definitionEdges', () => {
  it('marks an edge a participant may fire', () => {
    const definition = defineProcess({
      transitions: [{ id: 'go', title: 'Go', from: ['START'], to: 'DONE', by: ['a'] }],
    })
    const edges = definitionEdges(definition)
    expect(edges).toHaveLength(1)
    expect(edges[0]?.drivers).toEqual(['participant'])
  })

  it('marks an auto edge, which no participant fires', () => {
    const definition = defineProcess({
      transitions: [{ id: 'go', title: 'Go', from: ['START'], to: 'DONE', by: [], auto: true }],
    })
    expect(definitionEdges(definition)[0]?.drivers).toEqual(['auto'])
  })

  it('marks an edge a link fires, naming the relation', () => {
    const definition = defineProcess({
      transitions: [{ id: 'go', title: 'Go', from: ['START'], to: 'DONE', by: [] }],
      links: [{ onEvent: 'quotation:AGREED', triggers: 'go' }],
    })
    expect(definitionEdges(definition)[0]?.drivers).toEqual([{ link: 'quotation' }])
  })

  it('marks an edge a deadline fires, from the state the deadline arms in', () => {
    // `arm` enters WAIT and arms PT1H; when it expires, `lapse` fires from WAIT.
    const definition = defineProcess({
      states: [
        { id: 'START', title: 'Start' },
        { id: 'WAIT', title: 'Wait' },
        { id: 'DONE', title: 'Done', outcome: 'fulfilled' },
        { id: 'GONE', title: 'Gone', outcome: 'abandoned' },
      ],
      transitions: [
        {
          id: 'arm',
          title: 'Arm',
          from: ['START'],
          to: 'WAIT',
          by: ['a'],
          deadline: 'PT1H',
          onDeadline: 'lapse',
        },
        { id: 'lapse', title: 'Lapse', from: ['WAIT'], to: 'GONE', by: [] },
        { id: 'finish', title: 'Finish', from: ['WAIT'], to: 'DONE', by: ['b'] },
      ],
    })
    const lapse = definitionEdges(definition).find((edge) => edge.transition === 'lapse')
    expect(lapse?.drivers).toEqual(['deadline'])
  })
})

describe('analyseReachability', () => {
  it('reaches fulfilment across participant edges', () => {
    const definition = defineProcess({
      transitions: [{ id: 'go', title: 'Go', from: ['START'], to: 'DONE', by: ['a'] }],
    })
    const result = analyseReachability(definition)
    expect(result.fulfilmentReachable).toBe(true)
    expect(result.unlockingRelations).toEqual([])
  })

  it('does NOT reach fulfilment when the only forward edge waits on an unanchored relation', () => {
    // The shape of container-transport: PENDING_CONTRACT is left only by a
    // link-fired transition, and cancel reaches an *abandoned* ending.
    const definition = defineProcess({
      transitions: [
        { id: 'start', title: 'Start', from: ['START'], to: 'DONE', by: [] },
        { id: 'cancel', title: 'Cancel', from: ['*'], to: 'GONE', by: ['a', 'b'] },
      ],
      links: [{ onEvent: 'quotation:AGREED', triggers: 'start' }],
    })
    const result = analyseReachability(definition)
    expect(result.fulfilmentReachable).toBe(false)
    expect(result.unlockingRelations).toEqual(['quotation'])
  })

  it('reaches fulfilment once that relation is anchored', () => {
    const definition = defineProcess({
      transitions: [
        { id: 'start', title: 'Start', from: ['START'], to: 'DONE', by: [] },
        { id: 'cancel', title: 'Cancel', from: ['*'], to: 'GONE', by: ['a', 'b'] },
      ],
      links: [{ onEvent: 'quotation:AGREED', triggers: 'start' }],
    })
    expect(
      analyseReachability(definition, { anchoredRelations: ['quotation'] }).fulfilmentReachable,
    ).toBe(true)
    expect(analyseReachability(definition, { anchoredRelations: 'all' }).fulfilmentReachable).toBe(
      true,
    )
  })

  it('treats an abandoned-only ending as not fulfilled', () => {
    const definition = defineProcess({
      transitions: [{ id: 'quit', title: 'Quit', from: ['START'], to: 'GONE', by: ['a'] }],
    })
    expect(analyseReachability(definition).fulfilmentReachable).toBe(false)
    expect(analyseReachability(definition).unlockingRelations).toEqual([])
  })
})

describe('statesWithoutFireableExit', () => {
  it('finds a state nothing at all can leave', () => {
    const definition = defineProcess({
      states: [
        { id: 'START', title: 'Start' },
        { id: 'STUCK', title: 'Stuck' },
        { id: 'DONE', title: 'Done', outcome: 'fulfilled' },
        { id: 'GONE', title: 'Gone', outcome: 'abandoned' },
      ],
      transitions: [
        { id: 'go', title: 'Go', from: ['START'], to: 'STUCK', by: ['a'] },
        { id: 'win', title: 'Win', from: ['START'], to: 'DONE', by: ['a'] },
      ],
    })
    expect(statesWithoutFireableExit(definition)).toEqual(['STUCK'])
  })

  it('does not fault a terminal state for having no exit', () => {
    const definition = defineProcess({
      transitions: [{ id: 'go', title: 'Go', from: ['START'], to: 'DONE', by: ['a'] }],
    })
    expect(statesWithoutFireableExit(definition)).toEqual([])
  })

  it('counts a link-fired exit as fireable, since the runtime can walk it', () => {
    const definition = defineProcess({
      transitions: [{ id: 'go', title: 'Go', from: ['START'], to: 'DONE', by: [] }],
      links: [{ onEvent: 'quotation:AGREED', triggers: 'go' }],
    })
    expect(statesWithoutFireableExit(definition)).toEqual([])
  })
})

describe('statesWithoutFulfilment', () => {
  it('finds a non-terminal state that can only end badly', () => {
    const definition = defineProcess({
      states: [
        { id: 'START', title: 'Start' },
        { id: 'DOOMED', title: 'Doomed' },
        { id: 'DONE', title: 'Done', outcome: 'fulfilled' },
        { id: 'GONE', title: 'Gone', outcome: 'abandoned' },
      ],
      transitions: [
        { id: 'win', title: 'Win', from: ['START'], to: 'DONE', by: ['a'] },
        { id: 'doom', title: 'Doom', from: ['START'], to: 'DOOMED', by: ['a'] },
        { id: 'quit', title: 'Quit', from: ['DOOMED'], to: 'GONE', by: ['a'] },
      ],
    })
    expect(statesWithoutFulfilment(definition)).toEqual(['DOOMED'])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @pilots/protocol test reachability`
Expected: FAIL — `Cannot find module '../src/engine/reachability.js'`.

- [ ] **Step 3: Write the implementation**

Create `packages/protocol/src/engine/reachability.ts`:

```ts
/**
 * Which parts of a definition can actually be walked, and by what.
 *
 * A definition's edges are not equally available. `by: []` means no participant
 * may fire a transition — but the engine may (`auto`), the clock may (a
 * `deadline` arming into the source state), or a linked instance may (a `links`
 * entry naming it). The last of those is the subtle one: `links` are declared
 * per definition and anchored **per instance**, so a link-fired edge is walkable
 * only when the relation it names is set on the instance in question.
 *
 * That distinction is why a definition can be perfectly valid while an instance
 * created under it can never succeed, which is the mistake this module exists to
 * make detectable.
 */
import {
  expandFromStates,
  outcomeOf,
  parseLinkEvent,
  terminalStates,
  type ProcessDefinition,
} from '../schemas/definition.js'

export type EdgeDriver = 'participant' | 'auto' | 'deadline' | { link: string }

export interface DefinitionEdge {
  from: string
  to: string
  transition: string
  transitionIndex: number
  /** Everything that could fire this edge. Empty means nothing can. */
  drivers: EdgeDriver[]
}

export interface ReachabilityOptions {
  /**
   * Link relations anchored on the instance being asked about. `'all'` asks the
   * definition-level question — is this reachable for *some* instance. The
   * default, `[]`, asks the standalone question: an instance created with no
   * relations set.
   */
  anchoredRelations?: readonly string[] | 'all'
}

export interface Reachability {
  /** States reachable from `initialState` across walkable edges. */
  reachable: Set<string>
  fulfilmentReachable: boolean
  /**
   * Relations that would make fulfilment reachable if anchored. Empty when
   * fulfilment is already reachable, and also when nothing would help.
   */
  unlockingRelations: string[]
}

/** Every edge the definition declares, each tagged with what could fire it. */
export function definitionEdges(definition: ProcessDefinition): DefinitionEdge[] {
  const declared = new Set(definition.states.map((state) => state.id))

  /** Transitions fired by a link, and the relation each link names. */
  const linkRelations = new Map<string, Set<string>>()
  for (const link of definition.links) {
    const { relation } = parseLinkEvent(link.onEvent)
    const bucket = linkRelations.get(link.triggers)
    if (bucket) bucket.add(relation)
    else linkRelations.set(link.triggers, new Set([relation]))
  }

  /**
   * A deadline arms on entry into the state its transition leads to, and fires
   * `onDeadline` from there — so the clock can drive an edge only out of that
   * state, never out of every state the fired transition lists in `from`.
   */
  const deadlineArmedIn = new Map<string, Set<string>>()
  for (const transition of definition.transitions) {
    if (transition.onDeadline === undefined || transition.to === undefined) continue
    const bucket = deadlineArmedIn.get(transition.onDeadline)
    if (bucket) bucket.add(transition.to)
    else deadlineArmedIn.set(transition.onDeadline, new Set([transition.to]))
  }

  const edges: DefinitionEdge[] = []
  for (const [transitionIndex, transition] of definition.transitions.entries()) {
    const froms = expandFromStates(definition, transition).filter((state) => declared.has(state))
    for (const from of froms) {
      const drivers: EdgeDriver[] = []
      if (transition.by.length > 0) drivers.push('participant')
      if (transition.auto) drivers.push('auto')
      if (deadlineArmedIn.get(transition.id)?.has(from)) drivers.push('deadline')
      for (const relation of linkRelations.get(transition.id) ?? []) drivers.push({ link: relation })

      edges.push({
        from,
        // A transition with no `to` is a pure data update: a self-loop that
        // moves nothing, which is exactly how the linter's edges treat it.
        to: transition.to ?? from,
        transition: transition.id,
        transitionIndex,
        drivers,
      })
    }
  }
  return edges
}

function isWalkable(edge: DefinitionEdge, anchored: readonly string[] | 'all'): boolean {
  return edge.drivers.some((driver) => {
    if (typeof driver === 'string') return true
    return anchored === 'all' || anchored.includes(driver.link)
  })
}

/** Every link relation the definition mentions, in first-seen order. */
function relationsOf(definition: ProcessDefinition): string[] {
  const seen: string[] = []
  for (const link of definition.links) {
    const { relation } = parseLinkEvent(link.onEvent)
    if (!seen.includes(relation)) seen.push(relation)
  }
  return seen
}

function walkFrom(
  definition: ProcessDefinition,
  edges: readonly DefinitionEdge[],
  seed: string,
  anchored: readonly string[] | 'all',
): Set<string> {
  const adjacency = new Map<string, Set<string>>()
  for (const edge of edges) {
    if (!isWalkable(edge, anchored)) continue
    const bucket = adjacency.get(edge.from)
    if (bucket) bucket.add(edge.to)
    else adjacency.set(edge.from, new Set([edge.to]))
  }

  const seen = new Set([seed])
  const stack = [seed]
  while (stack.length > 0) {
    const current = stack.pop()!
    for (const next of adjacency.get(current) ?? []) {
      if (!seen.has(next)) {
        seen.add(next)
        stack.push(next)
      }
    }
  }
  return seen
}

const reachesFulfilment = (definition: ProcessDefinition, states: ReadonlySet<string>): boolean =>
  [...states].some((state) => outcomeOf(definition, state) === 'fulfilled')

export function analyseReachability(
  definition: ProcessDefinition,
  options: ReachabilityOptions = {},
): Reachability {
  const anchored = options.anchoredRelations ?? []
  const edges = definitionEdges(definition)
  const reachable = walkFrom(definition, edges, definition.initialState, anchored)
  const fulfilmentReachable = reachesFulfilment(definition, reachable)

  if (fulfilmentReachable || anchored === 'all') {
    return { reachable, fulfilmentReachable, unlockingRelations: [] }
  }

  /*
   * Which single relation would unlock it. Tested one at a time rather than
   * reported as "every relation this definition mentions", because a definition
   * may name a relation that has nothing to do with the blocked path.
   */
  const unlockingRelations = relationsOf(definition)
    .filter((relation) => !anchored.includes(relation))
    .filter((relation) =>
      reachesFulfilment(
        definition,
        walkFrom(definition, edges, definition.initialState, [...anchored, relation]),
      ),
    )

  return { reachable, fulfilmentReachable, unlockingRelations }
}

/**
 * Reachable non-terminal states that nothing can leave. Terminal states are
 * meant to have no exit, so they are never faulted.
 */
export function statesWithoutFireableExit(definition: ProcessDefinition): string[] {
  const terminal = new Set(terminalStates(definition))
  const edges = definitionEdges(definition)
  const reachable = analyseReachability(definition, { anchoredRelations: 'all' }).reachable

  return [...reachable]
    .filter((state) => !terminal.has(state))
    .filter(
      (state) =>
        !edges.some(
          (edge) => edge.from === state && edge.to !== state && isWalkable(edge, 'all'),
        ),
    )
    .sort()
}

/** Reachable non-terminal states from which no fulfilled ending can be reached. */
export function statesWithoutFulfilment(definition: ProcessDefinition): string[] {
  const terminal = new Set(terminalStates(definition))
  const edges = definitionEdges(definition)
  const reachable = analyseReachability(definition, { anchoredRelations: 'all' }).reachable

  return [...reachable]
    .filter((state) => !terminal.has(state))
    .filter((state) => !reachesFulfilment(definition, walkFrom(definition, edges, state, 'all')))
    .sort()
}
```

Then export it from `packages/protocol/src/index.ts`, beside the other `engine/` exports:

```ts
export * from './engine/reachability.js'
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @pilots/protocol test reachability`
Expected: PASS, all cases.

- [ ] **Step 5: Verify**

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm lint:definitions && pnpm format:check
```

Then stop and tell the supervisor the task is ready to review and commit.

---

### Task 2: Four lint rules that catch a process which cannot succeed

Implements spec F2. `dead-end-state` asks whether *any* terminal state is reachable; since every shipped definition has `cancel` with `from: ["*"]` to a terminal `CANCELLED`, every state passes trivially and the rule can essentially never fire. What an author needs tested is a path to a **good** ending.

**Files:**
- Modify: `packages/protocol/src/lint/linter.ts`
- Test: `packages/protocol/test/linter.test.ts`

**Interfaces:**
- Consumes: `analyseReachability`, `statesWithoutFireableExit`, `statesWithoutFulfilment` from Task 1.
- Produces: four diagnostic codes — `no-fulfilled-path` (error), `no-fireable-exit` (error), `starts-link-dependent` (warning), `unfulfillable-state` (warning).

- [ ] **Step 1: Write the failing test**

Append to `packages/protocol/test/linter.test.ts`. Reuse whatever definition-building helper that file already has; if it has none, copy `defineProcess` from Task 1's test.

```ts
describe('a definition must be able to succeed', () => {
  it('errors when no fulfilled ending is reachable at all', () => {
    const result = lintDefinition({
      ...validDefinition(),
      transitions: [{ id: 'quit', title: 'Quit', from: ['START'], to: 'GONE', by: ['a'] }],
    })
    expect(result.ok).toBe(false)
    const codes = result.diagnostics.map((one) => one.code)
    expect(codes).toContain('no-fulfilled-path')
  })

  it('does NOT error merely because cancel exists — the old dead-end rule could not tell', () => {
    // This is the regression that motivated the rule: `cancel` from `*` makes
    // every state reach *a* terminal state, so `dead-end-state` stays silent.
    const result = lintDefinition({
      ...validDefinition(),
      transitions: [
        { id: 'win', title: 'Win', from: ['START'], to: 'DONE', by: ['a'] },
        { id: 'cancel', title: 'Cancel', from: ['*'], to: 'GONE', by: ['a', 'b'] },
      ],
    })
    expect(result.diagnostics.map((one) => one.code)).not.toContain('no-fulfilled-path')
  })

  it('errors on a state nothing can leave', () => {
    const result = lintDefinition({
      ...validDefinition(),
      states: [
        { id: 'START', title: 'Start' },
        { id: 'STUCK', title: 'Stuck' },
        { id: 'DONE', title: 'Done', outcome: 'fulfilled' },
        { id: 'GONE', title: 'Gone', outcome: 'abandoned' },
      ],
      transitions: [
        { id: 'win', title: 'Win', from: ['START'], to: 'DONE', by: ['a'] },
        { id: 'stick', title: 'Stick', from: ['START'], to: 'STUCK', by: ['a'] },
      ],
    })
    expect(result.ok).toBe(false)
    const stuck = result.diagnostics.find((one) => one.code === 'no-fireable-exit')
    expect(stuck?.message).toContain('STUCK')
  })

  it('warns that a link-driven definition cannot be started standalone', () => {
    const result = lintDefinition({
      ...validDefinition(),
      transitions: [
        { id: 'start', title: 'Start', from: ['START'], to: 'DONE', by: [] },
        { id: 'cancel', title: 'Cancel', from: ['*'], to: 'GONE', by: ['a', 'b'] },
      ],
      links: [{ onEvent: 'quotation:AGREED', triggers: 'start' }],
    })
    // A warning, not an error: the definition is correct. The mistake it
    // predicts is made at instance creation, where the connector refuses it.
    expect(result.ok).toBe(true)
    const warning = result.diagnostics.find((one) => one.code === 'starts-link-dependent')
    expect(warning?.severity).toBe('warning')
    expect(warning?.message).toContain('quotation')
  })

  it('warns about a state that can only end badly', () => {
    const result = lintDefinition({
      ...validDefinition(),
      states: [
        { id: 'START', title: 'Start' },
        { id: 'DOOMED', title: 'Doomed' },
        { id: 'DONE', title: 'Done', outcome: 'fulfilled' },
        { id: 'GONE', title: 'Gone', outcome: 'abandoned' },
      ],
      transitions: [
        { id: 'win', title: 'Win', from: ['START'], to: 'DONE', by: ['a'] },
        { id: 'doom', title: 'Doom', from: ['START'], to: 'DOOMED', by: ['a'] },
        { id: 'quit', title: 'Quit', from: ['DOOMED'], to: 'GONE', by: ['a'] },
      ],
    })
    expect(result.ok).toBe(true)
    expect(result.diagnostics.find((one) => one.code === 'unfulfillable-state')?.message).toContain(
      'DOOMED',
    )
  })
})
```

Add a `validDefinition()` helper to that test file if it lacks one — the same document as Task 1's `defineProcess({})`, returned as a plain object rather than parsed.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @pilots/protocol test linter`
Expected: FAIL — the four codes are absent from `diagnostics`.

- [ ] **Step 3: Write the implementation**

In `packages/protocol/src/lint/linter.ts`, import from Task 1:

```ts
import {
  analyseReachability,
  statesWithoutFireableExit,
  statesWithoutFulfilment,
} from '../engine/reachability.js'
```

Then, immediately after the existing `dead-end-state` block and before the `return`, add:

```ts
  /*
   * — can this process succeed, and can anyone make it —
   *
   * `dead-end-state` above asks whether *a* terminal state is reachable. Every
   * definition with a `cancel` from `*` satisfies that trivially, so it cannot
   * answer the question an author actually has: is there a path to a **good**
   * ending, and can a participant walk it.
   */
  if (states.has(definition.initialState)) {
    const forSomeInstance = analyseReachability(definition, { anchoredRelations: 'all' })
    if (!forSomeInstance.fulfilmentReachable) {
      error(
        'no-fulfilled-path',
        `no state with outcome "fulfilled" is reachable from ${definition.initialState}: this process can never succeed`,
        '/states',
      )
    } else {
      // Correct, but it cannot be started on its own: every route to success
      // crosses an edge only a linked instance can fire.
      const standalone = analyseReachability(definition)
      if (!standalone.fulfilmentReachable && standalone.unlockingRelations.length > 0) {
        warn(
          'starts-link-dependent',
          `every path to fulfilment crosses a transition fired by the ${standalone.unlockingRelations
            .map((relation) => `"${relation}"`)
            .join(' or ')} relation, so an instance created without it can never succeed`,
          '/links',
        )
      }
    }

    for (const state of statesWithoutFireableExit(definition)) {
      error(
        'no-fireable-exit',
        `${state} is not terminal, and nothing can leave it: no transition out of it names a role in "by", is "auto", is fired by a link, or has a deadline arming in it`,
        `/states/${indexOfState(definition, state)}`,
      )
    }

    for (const state of statesWithoutFulfilment(definition)) {
      warn(
        'unfulfillable-state',
        `${state} can be reached, but no fulfilled ending can be reached from it`,
        `/states/${indexOfState(definition, state)}`,
      )
    }
  }
```

And add this helper beside `reachable` at the bottom of the file:

```ts
/** Where a state sits in the document, so a diagnostic can point at that node. */
function indexOfState(definition: ProcessDefinition, id: string): number {
  return definition.states.findIndex((state) => state.id === id)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @pilots/protocol test linter`
Expected: PASS.

- [ ] **Step 5: Check the five shipped definitions still lint**

Run: `pnpm lint:definitions`
Expected: all five pass. `container-transport` and `container-transport-with-terminal` now emit a **`starts-link-dependent` warning** — that is correct and expected, and warnings do not fail a definition. If either emits an *error*, the rules are wrong; stop and re-read Task 1.

- [ ] **Step 6: Verify**

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm lint:definitions && pnpm format:check
```

Then stop and tell the supervisor the task is ready to review and commit.

---

### Task 3: Every diagnostic points at a node

Implements spec F3. A future canvas highlights the node a diagnostic names.

**Corrected while executing.** The spec claimed `invalid-json-schema` passed prose where a pointer
belongs; checked against the code, it already passes its pointer and keeps the prose in the message —
the spec's finding was an artefact of the regex used to survey the rules, not a defect. What remains is
real: the graph-level rules (`unreachable-state`, `dead-end-state`) emit **one diagnostic listing every
offending state**, pointing at `/states` collectively, so a canvas cannot tell which nodes are at fault.
A test locks the pointer invariant in place so a future rule cannot quietly break it.

**Files:**
- Modify: `packages/protocol/src/lint/linter.ts`
- Test: `packages/protocol/test/linter.test.ts`

**Interfaces:**
- Consumes: `indexOfState` from Task 2.
- Produces: no new exports. Every `LintDiagnostic.path` is a JSON Pointer.

- [ ] **Step 1: Write the failing test**

```ts
describe('diagnostics point at nodes, so an editor can highlight them', () => {
  it('gives every diagnostic a JSON pointer', () => {
    const result = lintDefinition({
      ...validDefinition(),
      data: { type: 'object', properties: { x: { type: 'not-a-type' } } },
      transitions: [
        { id: 'win', title: 'Win', from: ['NOPE'], to: 'DONE', by: ['a'] },
      ],
    })
    expect(result.diagnostics.length).toBeGreaterThan(0)
    for (const diagnostic of result.diagnostics) {
      expect(diagnostic.path, `${diagnostic.code} has no path`).toBeDefined()
      expect(diagnostic.path, `${diagnostic.code} path is not a pointer`).toMatch(/^\/[^ ]*$/)
    }
  })

  it('names one state per diagnostic rather than listing them together', () => {
    const result = lintDefinition({
      ...validDefinition(),
      states: [
        { id: 'START', title: 'Start' },
        { id: 'ISLAND_A', title: 'Island A' },
        { id: 'ISLAND_B', title: 'Island B' },
        { id: 'DONE', title: 'Done', outcome: 'fulfilled' },
        { id: 'GONE', title: 'Gone', outcome: 'abandoned' },
      ],
      transitions: [{ id: 'win', title: 'Win', from: ['START'], to: 'DONE', by: ['a'] }],
    })
    const unreachable = result.diagnostics.filter((one) => one.code === 'unreachable-state')
    expect(unreachable).toHaveLength(2)
    expect(unreachable.map((one) => one.path).sort()).toEqual(['/states/1', '/states/2'])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @pilots/protocol test linter`
Expected: FAIL — `unreachable-state` produces one diagnostic pointing at `/states` rather than one per state.

- [ ] **Step 3: Write the implementation**

Two edits in `packages/protocol/src/lint/linter.ts`.

**(a)** Split `unreachable-state` into one diagnostic per state:

```ts
  if (states.has(definition.initialState)) {
    const forward = reachable(edges, [definition.initialState], 'forward')
    for (const state of [...states].filter((one) => !forward.has(one)).sort()) {
      error(
        'unreachable-state',
        `${state} is unreachable from ${definition.initialState}`,
        `/states/${indexOfState(definition, state)}`,
      )
    }
  }
```

**(b)** The same for `dead-end-state`:

```ts
  const declaredTerminals = [...terminal]
  if (declaredTerminals.length > 0) {
    const backward = reachable(edges, declaredTerminals, 'backward')
    for (const state of [...states].filter((one) => !backward.has(one)).sort()) {
      error(
        'dead-end-state',
        `no path to any terminal state from ${state}`,
        `/states/${indexOfState(definition, state)}`,
      )
    }
  }
```

`no-terminal-state` keeps `/states`: it is a fact about the collection, not about one node.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @pilots/protocol test linter`
Expected: PASS.

- [ ] **Step 5: Check the CLI still reads well**

Run: `pnpm lint:definitions`
Expected: all five pass. Diagnostics that used to be one line listing several states are now one line each — that is the intended change.

- [ ] **Step 6: Verify**

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm lint:definitions && pnpm format:check
```

Then stop and tell the supervisor the task is ready to review and commit.

---

### Task 4: `definitionHash` in the instance genesis

Implements spec F4. `InstanceGenesis` pins `definition` as `id@version` — a **name, not the bytes** — so two connectors can hold different documents under one ref and each believe the other agrees. Its own comment says it exists so a home node cannot "quietly claim a different definition", and at ref granularity that is not quite true.

**This is a breaking change.** `genesis` is committed to by every event header, so every existing instance's chain becomes unverifiable. The supervisor has accepted this: nothing is published and M7 has not run.

**Files:**
- Modify: `packages/protocol/src/schemas/instance.ts`
- Modify: `packages/protocol/src/engine/evaluator.ts` (`CreateRequest`, `evaluateCreate`)
- Modify: `apps/connector/src/instances/instance.service.ts` (pass `registered.contentHash`)
- Modify: `apps/connector/src/replication/replication.service.ts`, `src/recovery/recovery.service.ts`, `src/delivery/peer-delivery.service.ts` (carry the field through)
- Modify: `packages/protocol/schema/*.json` via `pnpm schema:export`
- Test: `packages/protocol/test/instance.test.ts`, `apps/connector/test/*`

**Interfaces:**
- Consumes: `Sha256` from `./common.js`.
- Produces: `InstanceGenesis.definitionHash: Sha256`, `Instance.definitionHash: Sha256`, `CreateRequest.definitionHash: string`.

- [ ] **Step 1: Write the failing test**

```ts
describe('the genesis commits to the definition’s bytes, not only its name', () => {
  it('changes when the definition hash changes, at the same ref', () => {
    const base = {
      kind: 'service' as const,
      definition: 'p@1.0.0',
      participants: { a: 'did:web:a.example' },
      quotationId: null,
      offering: null,
    }
    const one = instanceGenesis({ ...base, definitionHash: `sha256:${'1'.repeat(64)}` })
    const two = instanceGenesis({ ...base, definitionHash: `sha256:${'2'.repeat(64)}` })

    // Same ref, different bytes: the genesis must not be able to say they agree.
    expect(hashJson(one)).not.toEqual(hashJson(two))
  })

  it('refuses a genesis with no definition hash', () => {
    expect(() =>
      InstanceGenesis.parse({
        kind: 'service',
        definition: 'p@1.0.0',
        participants: { a: 'did:web:a.example' },
        quotationId: null,
        offering: null,
      }),
    ).toThrow()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @pilots/protocol test instance`
Expected: FAIL — `definitionHash` is not a known key, and `strictObject` rejects it.

- [ ] **Step 3: Write the implementation**

In `packages/protocol/src/schemas/instance.ts`, add to `InstanceGenesis` directly after `definition`:

```ts
  /**
   * `sha256` of the definition document as published, so the genesis commits to
   * the **bytes** and not merely to `id@version`.
   *
   * Without it, two connectors can hold different documents under one ref and
   * each believe the other agrees — which is exactly the guarantee this object
   * exists to provide. It matters as soon as definitions are authored at runtime
   * and fetched from a peer rather than mounted from the same directory.
   */
  definitionHash: Sha256,
```

Add the same field to `Instance`, and thread it through `instanceGenesis()`:

```ts
export function instanceGenesis(instance: {
  kind: string
  definition: string
  definitionHash: string
  participants: ParticipantMap
  quotationId?: string | null
  offering?: string | null
}): InstanceGenesis {
  return InstanceGenesis.parse({
    kind: instance.kind,
    definition: instance.definition,
    definitionHash: instance.definitionHash,
    participants: instance.participants,
    quotationId: instance.quotationId ?? null,
    offering: instance.offering ?? null,
  })
}
```

Add `definitionHash: string` to `CreateRequest` in `evaluator.ts` and set it on the `Instance` that `evaluateCreate` builds. Then follow the type errors: `instance.service.ts` passes `registered.contentHash`; `replication.service.ts`, `recovery.service.ts` and `peer-delivery.service.ts` carry the field through the shapes they already rebuild.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @pilots/protocol test instance`
Expected: PASS.

- [ ] **Step 5: Regenerate the exported JSON Schemas**

Run: `pnpm schema:export`
Expected: `packages/protocol/schema/*.json` show `definitionHash` on the instance and genesis schemas. Commit the regenerated files with the task.

- [ ] **Step 6: Verify**

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm lint:definitions && pnpm format:check
```

Expect several connector tests to fail first on the missing field and then pass once it is threaded through. **Any test that still fails after that is telling you a real site was missed** — do not silence it with a cast.

Then stop and tell the supervisor the task is ready to review and commit.

---

### Task 5: Refuse an instance that can never succeed

Implements spec F1 — the check that would have prevented the dead end this milestone exists for. It is pure graph reasoning over the definition and the instance's own relations; it knows nothing about any domain.

**Files:**
- Modify: `packages/protocol/src/problems.ts` (the new problem type)
- Modify: `apps/connector/src/instances/instance.service.ts`
- Modify: `apps/connector/src/api/local.controller.ts` (expose `startableStandalone` on the definitions list)
- Test: `apps/connector/test/instances.test.ts`, `apps/connector/test/http.test.ts`

**Interfaces:**
- Consumes: `analyseReachability` (Task 1), `Problem` from `@pilots/protocol`.
- Produces: `Problem.instanceUnfulfillable = 'urn:pilots:problem:instance-unfulfillable'`; each entry of `GET /api/local/v1/definitions` gains `startableStandalone: boolean` and `requiresRelations: string[]`.

- [ ] **Step 1: Write the failing test**

```ts
describe('an instance that can never succeed is refused at creation', () => {
  it('refuses a link-driven definition created with no relation anchored', async () => {
    const result = await instances.create(caller, {
      definition: 'container-transport@1.0.0',
      participants: { shipper: orgA, transporter: orgB },
      data: { containerType: '40HC' },
      quotationId: null,
      offering: null,
    })

    expect(result.ok).toBe(false)
    expect(result.errors[0]?.type).toBe(Problem.instanceUnfulfillable)
    // The message must name what would unlock it, or the caller cannot act on it.
    expect(result.errors[0]?.detail).toContain('quotation')
  })

  it('allows the same creation once the quotation is anchored', async () => {
    const quotation = await createQuotation()
    const result = await instances.create(caller, {
      definition: 'container-transport@1.0.0',
      participants: { shipper: orgA, transporter: orgB },
      data: { containerType: '40HC' },
      quotationId: quotation.id,
      offering: null,
    })
    expect(result.ok).toBe(true)
  })

  it('allows a definition that needs no relation at all', async () => {
    const result = await instances.create(caller, {
      definition: 'container-weighing@1.0.0',
      participants: { shipper: orgA, weigher: orgB },
      data: { containerNumber: 'AAAA1234567', terminal: 'T1' },
      quotationId: null,
      offering: null,
    })
    expect(result.ok).toBe(true)
  })
})
```

And at the HTTP boundary, in `http.test.ts`:

```ts
it('tells a client which definitions can be started on their own', async () => {
  const response = await get('/api/local/v1/definitions')
  const transport = response.body.definitions.find((one) => one.ref.startsWith('container-transport@'))
  const weighing = response.body.definitions.find((one) => one.ref.startsWith('container-weighing@'))

  expect(transport.startableStandalone).toBe(false)
  expect(transport.requiresRelations).toEqual(['quotation'])
  expect(weighing.startableStandalone).toBe(true)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @pilots/connector test instances http`
Expected: FAIL — the creation succeeds, and `startableStandalone` is undefined.

- [ ] **Step 3: Write the implementation**

Add to `packages/protocol/src/problems.ts`:

```ts
  /** The instance, as asked for, has no path to any fulfilled state. */
  instanceUnfulfillable: `${PROBLEM_PREFIX}instance-unfulfillable`,
```

In `apps/connector/src/instances/instance.service.ts`, inside `create`, immediately after the `registered` lookup and **before** `evaluateCreate`:

```ts
    /*
     * Can this instance, as asked for, ever succeed?
     *
     * `links` are declared per definition and anchored per instance: a
     * link-fired transition is walkable only when the relation it names is set
     * here. An instance created without it can reach nothing but an abandoned
     * ending — and since the relation lives in the immutable genesis, it can
     * never be supplied later. So this is a refusal, not a warning.
     */
    const anchored: string[] = []
    if ((request.quotationId ?? null) !== null) anchored.push('quotation')

    const viable = analyseReachability(registered.definition, { anchoredRelations: anchored })
    if (!viable.fulfilmentReachable) {
      return fail(
        Problem.instanceUnfulfillable,
        viable.unlockingRelations.length > 0
          ? `${request.definition} reaches fulfilment only through a transition fired by the ${viable.unlockingRelations
              .map((relation) => `"${relation}"`)
              .join(' or ')} relation; create it with that relation set`
          : `${request.definition} has no path from ${registered.definition.initialState} to any fulfilled state, so this instance could only ever be abandoned`,
        '/definition',
      )
    }
```

In `apps/connector/src/api/local.controller.ts`, in the definitions listing, add the two derived fields:

```ts
      const standalone = analyseReachability(registered.definition)
      return {
        ref: registered.ref,
        title: registered.definition.title,
        kind: registered.definition.kind,
        contentHash: registered.contentHash,
        /** Whether an instance under it can succeed with no relation anchored. */
        startableStandalone: standalone.fulfilmentReachable,
        requiresRelations: standalone.fulfilmentReachable ? [] : standalone.unlockingRelations,
      }

Keep whatever fields the existing listing already returns; the two derived ones are additions, not a
replacement. Add both to `packages/client/src/types.ts` and re-run `pnpm openapi:export`.
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @pilots/connector test instances http`
Expected: PASS.

- [ ] **Step 5: Verify**

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm lint:definitions && pnpm format:check
```

Then stop and tell the supervisor the task is ready to review and commit.

---

### Task 6: Definitions in the store, and a registry that reads them

Implements the storage half of spec F5. The boot directory becomes a **seed**, not the authority: a definition loaded from disk and one published at runtime are the same kind of record afterwards.

The registry stays **synchronous**. A connector is a single process; making `get()` async would ripple through the peer server, replication, links and instances for no benefit.

**Files:**
- Create: `apps/connector/src/definitions/definition-store.ts`
- Modify: `apps/connector/src/store/store.ts` (the `definitions` collection)
- Modify: `apps/connector/src/store/conformance/suite.ts` (cover the new collection)
- Modify: `apps/connector/src/definitions/definition-registry.ts`
- Modify: `apps/connector/src/runtime.ts` (hydrate at boot)
- Test: `apps/connector/test/definitions.test.ts`

**Interfaces:**
- Produces:
  - `interface DefinitionDocument extends StoredDocument { ref: string; definitionId: string; version: string; contentHash: string; raw: JsonValue; origin: 'boot' | 'local' | 'peer'; adoption: DefinitionAdoption | null; createdAt: string }`
  - `interface DefinitionAdoption { status: 'pending' | 'accepted' | 'rejected'; peerDid: string; decidedAt: string | null; decidedBy: string | null }`
  - `DefinitionRegistry.hydrate(documents: DefinitionDocument[]): void`
  - `DefinitionRegistry.register(raw: JsonValue, source: string): RegisteredDefinition` (already exists privately — make it public)

`id` on the document is the ref, so `(participantId, ref)` is the key and a duplicate publish is a `DuplicateKeyError` rather than a silent overwrite.

- [ ] **Step 1: Write the failing test**

```ts
describe('definitions survive a restart', () => {
  it('re-registers a stored definition when the registry hydrates', async () => {
    const store = memoryStore()
    await store.definitions.insert(definitionDocument({ ref: 'p@1.0.0', origin: 'local' }))

    const registry = await DefinitionRegistry.fromDirectory(DEFINITIONS_DIR)
    registry.hydrate(await store.definitions.find('org-a'))

    expect(registry.has('p@1.0.0')).toBe(true)
    expect(registry.get('p@1.0.0')?.contentHash).toBe(definitionDocument({}).contentHash)
  })

  it('keeps definitions loaded from disk alongside stored ones', async () => {
    const registry = await DefinitionRegistry.fromDirectory(DEFINITIONS_DIR)
    registry.hydrate([definitionDocument({ ref: 'p@1.0.0', origin: 'local' })])

    expect(registry.has('container-weighing@1.0.0')).toBe(true)
    expect(registry.has('p@1.0.0')).toBe(true)
  })
})
```

`definitionDocument(overrides)` is a new helper in this test file: it lints a minimal valid document
(the same shape as Task 1's `defineProcess({})`), and returns a `DefinitionDocument` with
`participantId: 'org-a'`, `origin: 'local'`, `adoption: null`, and `id`/`ref` both set to the ref, with
`overrides` applied last.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @pilots/connector test definitions`
Expected: FAIL — `store.definitions` does not exist and `hydrate` is not a function.

- [ ] **Step 3: Write the implementation**

Create `apps/connector/src/definitions/definition-store.ts` with the document types above and a small helper `definitionDocumentOf(participantId, registered, origin, adoption)`.

Add to `Store` in `apps/connector/src/store/store.ts`:

```ts
  readonly definitions: Collection<DefinitionDocument>
```

Implement it in the memory, file and Mongo adapters the same way the other collections are implemented, and add it to the conformance suite so all three are held to one contract.

In `definition-registry.ts`, make `register` public and add:

```ts
  /**
   * Adopt definitions held in the store. Called once at boot, after the boot
   * directory has been read — a stored definition wins, because it is the one
   * this connector published or accepted, and the directory is only a seed.
   */
  hydrate(documents: readonly DefinitionDocument[]): void {
    for (const document of documents) {
      this.byRef.set(document.ref, DefinitionRegistry.register(document.raw, `store:${document.ref}`))
    }
  }
```

In `runtime.ts`, after the registry is built, hydrate it from the store for every local participant.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @pilots/connector test definitions`
Expected: PASS.

- [ ] **Step 5: Run the store conformance suite against all three adapters**

Run: `pnpm --filter @pilots/connector test store`
Then, if a replica set is available:
```bash
PILOTS_TEST_MONGO_URI='mongodb://localhost:27018/?directConnection=true' pnpm --filter @pilots/connector test store
```
Expected: PASS. If no Mongo is running, the suite skips it — say so in the report rather than claiming it passed.

- [ ] **Step 6: Verify**

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm lint:definitions && pnpm format:check
```

Then stop and tell the supervisor the task is ready to review and commit.

---

### Task 7: Lint and publish on the local surface

Implements the API half of spec F5. Authoring is an ordinary integration act, not a privileged one: anything our demo UI can do, a third party's UI can do over the same surface.

**Files:**
- Modify: `packages/protocol/src/schemas/api-key.ts` (the `definitions:write` scope and its operation mapping)
- Create: `apps/connector/src/definitions/definition.service.ts`
- Modify: `apps/connector/src/api/local.controller.ts`
- Modify: `packages/protocol/src/problems.ts` (`definitionConflict`)
- Modify: `apps/connector/src/admin-ui/src/api.ts` (the scope's label in the key-minting form)
- Modify: `packages/client/src/types.ts`, `src/openapi.ts`, then `pnpm openapi:export`
- Test: `apps/connector/test/definitions.test.ts`, `apps/connector/test/http.test.ts`

**Interfaces:**
- Consumes: `DefinitionDocument`, `DefinitionRegistry.register` (Task 6); `lintDefinition` from `@pilots/protocol`.
- Produces:
  - `Scope` gains `'definitions:write'`; the operation map gains `'definitions.lint'` and `'definitions.publish'`, both mapping to it.
  - `Problem.definitionConflict = 'urn:pilots:problem:definition-conflict'`
  - `DefinitionService.lint(raw): LintResult`
  - `DefinitionService.publish(participantId, raw): Promise<ServiceResult<RegisteredDefinition>>`

- [ ] **Step 1: Write the failing test**

```ts
describe('publishing a definition', () => {
  it('lints without storing anything', async () => {
    const before = await store.definitions.count('org-a')
    const response = await post('/api/local/v1/definitions/lint', { definition: brokenDefinition() })

    expect(response.status).toBe(200)
    expect(response.body.ok).toBe(false)
    expect(response.body.diagnostics[0].path).toMatch(/^\//)
    expect(await store.definitions.count('org-a')).toBe(before)
  })

  it('refuses to publish a definition with errors', async () => {
    const response = await post('/api/local/v1/definitions', { definition: brokenDefinition() })
    expect(response.status).toBe(422)
    expect(response.body.type).toBe('urn:pilots:problem:definition-invalid')
  })

  it('publishes a valid definition and makes it immediately usable', async () => {
    const response = await post('/api/local/v1/definitions', { definition: validDefinition() })
    expect(response.status).toBe(201)

    const created = await post('/api/local/v1/instances', {
      definition: response.body.ref,
      participants: { a: orgA, b: orgB },
      data: {},
    })
    expect(created.status).toBe(201)
  })

  it('is idempotent for identical bytes', async () => {
    await post('/api/local/v1/definitions', { definition: validDefinition() })
    const again = await post('/api/local/v1/definitions', { definition: validDefinition() })
    expect(again.status).toBe(200)
  })

  it('refuses different bytes under the same id@version', async () => {
    await post('/api/local/v1/definitions', { definition: validDefinition() })
    const conflicting = await post('/api/local/v1/definitions', {
      definition: { ...validDefinition(), title: 'Renamed' },
    })

    // A version is an identity, not a label.
    expect(conflicting.status).toBe(409)
    expect(conflicting.body.type).toBe('urn:pilots:problem:definition-conflict')
  })

  it('refuses a key without definitions:write', async () => {
    const response = await postWithScopes(['definitions:read'], '/api/local/v1/definitions', {
      definition: validDefinition(),
    })
    expect(response.status).toBe(403)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @pilots/connector test definitions`
Expected: FAIL — 404 on both routes.

- [ ] **Step 3: Write the implementation**

Add `'definitions:write'` to the `Scope` enum, and to the operation map:

```ts
  'definitions.lint': 'definitions:write',
  'definitions.publish': 'definitions:write',
```

Add `definitionConflict` to `problems.ts`. Create `definition.service.ts`:

```ts
/**
 * Authoring definitions at runtime.
 *
 * A published definition is content-addressed and never changes: publishing the
 * same bytes again is a no-op, and publishing *different* bytes under an
 * existing `id@version` is a conflict rather than an update. A version is an
 * identity, not a label — an instance pins one for life, and a peer adopts one
 * by its hash.
 */
export class DefinitionService {
  constructor(
    private readonly store: Store,
    private readonly registry: DefinitionRegistry,
    private readonly now: () => string,
  ) {}

  lint(raw: unknown): LintResult {
    return lintDefinition(raw)
  }

  async publish(participantId: string, raw: JsonValue): Promise<ServiceResult<PublishOutcome>> {
    const result = lintDefinition(raw)
    if (!result.ok || !result.definition) {
      return fail(Problem.definitionInvalid, formatDiagnostics(result.diagnostics), '/definition')
    }

    const registered = DefinitionRegistry.register(raw, 'local')
    const existing = await this.store.definitions.get(participantId, registered.ref)

    if (existing) {
      if (existing.contentHash === registered.contentHash) {
        return ok({ registered, created: false })
      }
      return fail(
        Problem.definitionConflict,
        `${registered.ref} is already published with different content; bump the version rather than changing a published definition`,
        '/definition/version',
      )
    }

    await this.store.definitions.insert(
      definitionDocumentOf(participantId, registered, 'local', null),
    )
    this.registry.adopt(registered)
    return ok({ registered, created: true })
  }
}
```

Add `adopt(registered: RegisteredDefinition): void` to the registry (a one-line `this.byRef.set`). Wire two routes in `local.controller.ts` — `POST definitions/lint` with `@RequireScope('definitions.lint')` returning `{ ok, diagnostics }` at 200 whatever the outcome, and `POST definitions` with `@RequireScope('definitions.publish')` returning 201 on create, 200 on idempotent repeat.

Add the scope to the admin UI's scope list with a neutral label (`{ value: 'definitions:write', label: 'Publish process definitions' }`), extend the client types, and run `pnpm openapi:export`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @pilots/connector test definitions`
Expected: PASS.

- [ ] **Step 5: Verify**

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm lint:definitions && pnpm format:check
```

Then stop and tell the supervisor the task is ready to review and commit.

---

### Task 8: Fetch a peer's unknown definition and hold it pending

Implements the first half of spec F6. Replication currently refuses an instance whose definition this connector does not hold. The serving half already exists — `GET /api/peer/v1/definitions/{ref}` — so this task adds the fetching half and the wait.

**The wait must not look like a fault.** The delivery path treats every non-2xx identically: it marks the connection `DEGRADED` and writes a `delivery.fail` audit entry on each attempt. For a pending adoption that is wrong twice over — nothing is faulty, and a demo would show a red connection while the other operator is being asked to click *accept*.

**Files:**
- Modify: `packages/protocol/src/problems.ts` (`definitionPending`)
- Modify: `apps/connector/src/replication/replication.service.ts`
- Modify: `apps/connector/src/definitions/definition.service.ts` (`fetchFromPeer`)
- Modify: `apps/connector/src/delivery/peer-delivery.service.ts` (the non-degrading branch)
- Modify: `apps/connector/src/store/store.ts` (`ConnectionDocument.waitingOn`)
- Test: `apps/connector/test/replication.test.ts`, `apps/connector/test/peer-delivery.test.ts`

**Interfaces:**
- Consumes: `PeerClient.call`, `DefinitionService.publish` shape from Task 7.
- Produces:
  - `Problem.definitionPending = 'urn:pilots:problem:definition-pending'`
  - `DefinitionService.fetchFromPeer(participantId, ref, expectedHash, peer): Promise<ServiceResult<DefinitionDocument>>`
  - `ConnectionDocument.waitingOn: string | null`

- [ ] **Step 1: Write the failing test**

```ts
describe('a definition this connector has never seen', () => {
  it('is fetched from the peer and held pending, not refused outright', async () => {
    const result = await replication.apply(orgBContext, deliveryOf(instanceUnderNewDefinition))

    expect(result.ok).toBe(false)
    expect(result.errors[0]?.type).toBe(Problem.definitionPending)

    const held = await store.definitions.get('org-b', 'p@1.0.0')
    expect(held?.adoption?.status).toBe('pending')
    expect(held?.adoption?.peerDid).toBe('did:web:org-a.example')
  })

  it('refuses a fetched definition whose bytes do not match the pinned hash', async () => {
    peer.serveDefinition('p@1.0.0', tamperedDefinition())

    const result = await replication.apply(orgBContext, deliveryOf(instanceUnderNewDefinition))
    expect(result.errors[0]?.type).toBe(Problem.definitionInvalid)
    expect(await store.definitions.get('org-b', 'p@1.0.0')).toBeUndefined()
  })

  it('does not ask again once the definition is accepted', async () => {
    await definitions.decide('org-b', 'p@1.0.0', 'accepted', 'admin')
    peer.failNextDefinitionFetch()

    const result = await replication.apply(orgBContext, deliveryOf(secondInstanceSameDefinition))
    expect(result.ok).toBe(true)
  })
})

describe('waiting for a peer to adopt is not a delivery failure', () => {
  it('leaves the connection ACTIVE and writes no delivery.fail entry', async () => {
    peer.answerWith(422, { type: Problem.definitionPending, detail: 'awaiting adoption of p@1.0.0' })
    const auditBefore = await store.audit.count('org-a')

    await delivery.pump()

    const connection = await store.connections.get('org-a', connectionId)
    expect(connection?.status).toBe('ACTIVE')
    expect(connection?.waitingOn).toBe('p@1.0.0')
    expect(await store.audit.count('org-a')).toBe(auditBefore)
  })

  it('still backs off, so it does not spin', async () => {
    peer.answerWith(422, { type: Problem.definitionPending, detail: 'awaiting adoption of p@1.0.0' })
    await delivery.pump()
    const calls = peer.callCount

    clock.advance(100)
    await delivery.pump()
    expect(peer.callCount).toBe(calls)
  })

  it('clears waitingOn and delivers once the peer accepts', async () => {
    peer.answerWith(422, { type: Problem.definitionPending, detail: 'awaiting adoption of p@1.0.0' })
    await delivery.pump()

    peer.answerWith(200, {})
    clock.advance(60_000)
    await delivery.pump()

    const connection = await store.connections.get('org-a', connectionId)
    expect(connection?.waitingOn).toBeNull()
    expect(connection?.status).toBe('ACTIVE')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @pilots/connector test replication peer-delivery`
Expected: FAIL — replication refuses with `definition-invalid`, and the delivery path degrades the connection.

- [ ] **Step 3: Write the implementation**

Add `definitionPending` to `problems.ts`.

In `definition.service.ts`, add `fetchFromPeer`: call `GET /api/peer/v1/definitions/{ref}` through the peer client, lint the returned document, **compare `hashJson(raw)` against the `definitionHash` the instance genesis pins** (Task 4), and store it with `origin: 'peer'` and `adoption: { status: 'pending', peerDid, decidedAt: null, decidedBy: null }`. A hash mismatch stores nothing and fails with `Problem.definitionInvalid`.

In `replication.service.ts`, replace the "this connector does not hold" refusal: look up any adoption record first. `accepted` proceeds; `rejected` refuses with `definitionInvalid` and the recorded reason; `pending` refuses with `definitionPending`; absent triggers `fetchFromPeer` and then refuses with `definitionPending`.

In `peer-delivery.service.ts`, branch in the `catch` before the existing failure handling:

```ts
      /*
       * A pending adoption is a wait, not a fault. The counterparty's operator
       * has been asked to accept a definition; nothing is broken, so the
       * connection must not go DEGRADED and this must not fill the audit log
       * with one delivery.fail per attempt. Back off, say what we are waiting
       * for, and try again.
       */
      if (isPendingAdoption(cause)) {
        const attempt = (this.attempts.get(connection.id) ?? 0) + 1
        this.attempts.set(connection.id, attempt)
        this.retryAfter.set(
          connection.id,
          this.clock.now() + (BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length) - 1] ?? 600_000),
        )
        const current = await this.store.connections.get(participant.id, connection.id)
        if (current) {
          await this.store.connections.replace({ ...current, waitingOn: refFrom(cause) })
        }
        this.log.info(
          { peer: connection.peerDid, definition: refFrom(cause) },
          'peer has not yet adopted this definition; delivery is waiting, not failing',
        )
        return { delivered: 0, failed: 0 }
      }
```

`isPendingAdoption` needs the problem body, so `peer-client.ts` must surface the parsed problem on the thrown error rather than only the status code. Add `waitingOn: string | null` to `ConnectionDocument` (defaulting to `null`) and clear it on the success path beside the cursor write.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @pilots/connector test replication peer-delivery`
Expected: PASS.

- [ ] **Step 5: Verify**

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm lint:definitions && pnpm format:check
```

Then stop and tell the supervisor the task is ready to review and commit.

---

### Task 9: Adopt once, diff on change

Implements the second half of spec F6. **Adoption is a decision about a definition, not about an instance**: an operator decides once per ref, and every later instance under it flows without asking.

**Files:**
- Create: `packages/protocol/src/lint/diff.ts`
- Create: `packages/protocol/test/diff.test.ts`
- Modify: `apps/connector/src/definitions/definition.service.ts` (`decide`, `pending`)
- Modify: `apps/connector/src/api/admin.controller.ts`
- Test: `apps/connector/test/definitions.test.ts`, `apps/connector/test/scenarios/definition-adoption.test.ts`

**Interfaces:**
- Produces:
  - `interface DefinitionChange { kind: 'role' | 'state' | 'transition' | 'visibility' | 'link' | 'metadata'; change: 'added' | 'removed' | 'changed'; id: string; detail: string }`
  - `function diffDefinitions(before: ProcessDefinition, after: ProcessDefinition): DefinitionChange[]`
  - `DefinitionService.pending(participantId): Promise<PendingDefinition[]>` where `PendingDefinition = { document: DefinitionDocument; diffAgainst: string | null; changes: DefinitionChange[] }`
  - `DefinitionService.decide(participantId, ref, status: 'accepted' | 'rejected', decidedBy: string): Promise<ServiceResult<DefinitionDocument>>`

- [ ] **Step 1: Write the failing test**

`packages/protocol/test/diff.test.ts`:

```ts
describe('diffDefinitions', () => {
  it('reports an added state by id', () => {
    const before = defineProcess({})
    const after = defineProcess({
      states: [...before.states, { id: 'EXTRA', title: 'Extra' }],
    })
    expect(diffDefinitions(before, after)).toContainEqual(
      expect.objectContaining({ kind: 'state', change: 'added', id: 'EXTRA' }),
    )
  })

  it('reports a transition whose permissions changed', () => {
    const before = defineProcess({
      transitions: [{ id: 'go', title: 'Go', from: ['START'], to: 'DONE', by: ['a'] }],
    })
    const after = defineProcess({
      transitions: [{ id: 'go', title: 'Go', from: ['START'], to: 'DONE', by: ['a', 'b'] }],
    })
    const change = diffDefinitions(before, after).find((one) => one.id === 'go')
    expect(change?.change).toBe('changed')
    // An operator approving a new version is asking "what am I agreeing to now",
    // so the detail has to say what moved, not merely that something did.
    expect(change?.detail).toContain('by')
  })

  it('is empty for identical definitions', () => {
    expect(diffDefinitions(defineProcess({}), defineProcess({}))).toEqual([])
  })
})
```

`apps/connector/test/definitions.test.ts`:

```ts
describe('adoption is decided once per definition', () => {
  it('lists a pending definition with its origin peer', async () => {
    const response = await adminGet('/api/admin/v1/definitions/pending')
    expect(response.body.pending[0].document.ref).toBe('p@1.0.0')
    expect(response.body.pending[0].document.adoption.peerDid).toBe('did:web:org-a.example')
    expect(response.body.pending[0].diffAgainst).toBeNull()
  })

  it('diffs a new version against the highest already accepted', async () => {
    await adminPost('/api/admin/v1/definitions/p@1.0.0/accept', {})
    await holdPending('p@1.1.0')

    const response = await adminGet('/api/admin/v1/definitions/pending')
    const entry = response.body.pending.find((one) => one.document.ref === 'p@1.1.0')
    expect(entry.diffAgainst).toBe('p@1.0.0')
    expect(entry.changes.length).toBeGreaterThan(0)
  })

  it('records the decision in the audit log, since it produces no event', async () => {
    await adminPost('/api/admin/v1/definitions/p@1.0.0/accept', {})
    const audit = await adminGet('/api/admin/v1/audit')
    expect(audit.body.entries.map((one) => one.action)).toContain('definition.accept')
  })

  it('keeps refusing instances under a rejected definition', async () => {
    await adminPost('/api/admin/v1/definitions/p@1.0.0/reject', {})
    const result = await replication.apply(orgBContext, deliveryOf(instanceUnderNewDefinition))
    expect(result.errors[0]?.type).toBe(Problem.definitionInvalid)
  })
})
```

`apps/connector/test/scenarios/definition-adoption.test.ts` — two connectors, in-process transport, no containers:

```ts
it('authors on A, adopts on B, and only asks once', async () => {
  const { a, b } = await twoConnectors()

  await a.local.publishDefinition(customDefinition)
  const first = await a.local.createInstance({ definition: 'p@1.0.0', participants: { x: a.did, y: b.did } })

  await pumpUntilQuiet(a, b)
  expect(await b.definitions.pending()).toHaveLength(1)
  expect(await b.local.getInstance(first.id)).toBeUndefined()

  await b.admin.acceptDefinition('p@1.0.0')
  await pumpUntilQuiet(a, b)
  expect((await b.local.getInstance(first.id))?.state).toBe('START')

  // The decision was about the definition, so a second instance must not ask.
  const second = await a.local.createInstance({ definition: 'p@1.0.0', participants: { x: a.did, y: b.did } })
  await pumpUntilQuiet(a, b)
  expect(await b.definitions.pending()).toHaveLength(0)
  expect(await b.local.getInstance(second.id)).toBeDefined()
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @pilots/protocol test diff && pnpm --filter @pilots/connector test definitions definition-adoption`
Expected: FAIL — `diffDefinitions` does not exist; the admin routes 404.

- [ ] **Step 3: Write the implementation**

Create `packages/protocol/src/lint/diff.ts`. Compare `roles`, `states`, `transitions`, `visibility` and `links` **by id** (visibility by `path`, links by `onEvent`), and `title` / `description` / `hostedBy` / `initialState` / `defaultVisibility` as `metadata`. For a changed entry, list the keys whose canonicalised values differ, so `detail` reads `by, deadline`. Sort by kind then id, so two runs give the same order.

In `definition.service.ts`, add `pending()` — every document whose `adoption.status` is `pending`, each paired with the highest **accepted** document sharing its `definitionId`, and `diffDefinitions` between them — and `decide()`, which sets `status`, `decidedAt`, `decidedBy`, and on `accepted` calls `registry.adopt`.

In `admin.controller.ts`, add the three routes. Each decision writes an audit entry — `definition.accept` / `definition.reject`, category `admin`, subject the ref — because these are decisions that produce no event and would otherwise leave no record.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @pilots/protocol test diff && pnpm --filter @pilots/connector test definitions definition-adoption`
Expected: PASS.

- [ ] **Step 5: Verify**

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm lint:definitions && pnpm format:check
```

Then stop and tell the supervisor the task is ready to review and commit.

---

### Task 10: Author a definition in the process UI

Implements the editor half of spec F5: a JSON editor, diagnostics from the dry-run endpoint as you type, and the existing read-only diagram re-rendering live beside it.

**Files:**
- Create: `apps/process-ui/src/web/views/Authoring.tsx`
- Modify: `apps/process-ui/src/web/App.tsx` (a third tab), `src/web/api.ts`, `src/web/queries.ts`
- Modify: `apps/process-ui/src/server/routes.ts` (`/api/ui/definitions/lint`, `/api/ui/definitions`)
- Modify: `apps/process-ui/src/web/views/Start.tsx` (disable definitions that cannot be started standalone)
- Test: `apps/process-ui/test/bff.test.ts`

**Interfaces:**
- Consumes: `startableStandalone` / `requiresRelations` (Task 5), the lint and publish routes (Task 7), `toGraph` and `StateDiagram` (existing).
- Produces: nothing other modules consume.

- [ ] **Step 1: Write the failing test**

`apps/process-ui/test/bff.test.ts` — the BFF is where the node-environment tests live:

```ts
describe('the authoring routes relay to the connector', () => {
  it('relays a lint request and returns diagnostics unchanged', async () => {
    connector.reply('/api/local/v1/definitions/lint', 200, {
      ok: false,
      diagnostics: [{ severity: 'error', code: 'no-fulfilled-path', message: 'x', path: '/states' }],
    })

    const response = await ui.post('/api/ui/definitions/lint', { definition: {} })
    expect(response.status).toBe(200)
    expect(response.body.diagnostics[0].code).toBe('no-fulfilled-path')
  })

  it('relays a publish and passes the problem through on conflict', async () => {
    connector.reply('/api/local/v1/definitions', 409, {
      type: 'urn:pilots:problem:definition-conflict',
      title: 'Conflict',
      status: 409,
      detail: 'already published',
    })

    const response = await ui.post('/api/ui/definitions', { definition: {} })
    expect(response.status).toBe(409)
    expect(response.body.type).toBe('urn:pilots:problem:definition-conflict')
  })

  it('requires a signed-in user, like every other UI route', async () => {
    const response = await ui.postAnonymous('/api/ui/definitions', { definition: {} })
    expect(response.status).toBe(401)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @pilots/process-ui test bff`
Expected: FAIL — 404 on both routes.

- [ ] **Step 3: Write the implementation**

Add the two BFF routes beside the existing ones, using the same `actingClient` + `relay` pattern so problems pass through untouched.

Create `Authoring.tsx`: a `<textarea>` holding the document text, a debounced (300 ms) lint call whose diagnostics render as a list — errors first, each showing `code`, `message` and `path` — and, when the text parses and lints without errors, `<StateDiagram definition={parsed} />` beside it. A file input imports a `.json`; a download button exports the current text. **Publish is disabled while any diagnostic has severity `error`.** Keep the working copy in component state: the connector holds no drafts, by decision.

Gate the tab on the `definitions:write` scope being present in the session response, so a UI whose key cannot publish does not show a button that will 403.

In `Start.tsx`, render a definition with `startableStandalone === false` as a disabled option, with the reason beside the select:

```tsx
{definition && !definition.startableStandalone && (
  <p className="text-xs text-amber-700 dark:text-amber-400">
    This process is started by another one reaching an agreement — it needs
    {' '}{definition.requiresRelations.join(' or ')}{' '}
    and cannot be started on its own.
  </p>
)}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @pilots/process-ui test bff`
Expected: PASS.

- [ ] **Step 5: Verify**

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm lint:definitions && pnpm format:check
```

Then stop and tell the supervisor the task is ready to review and commit.

---

### Task 11: Pending definitions and the diff in the admin UI

Implements the operator half of spec F6, and the admin-UI half of spec F8.

**Files:**
- Modify: `apps/connector/src/admin-ui/src/App.tsx`
- Modify: `apps/connector/src/admin-ui/src/api.ts`
- Test: `tests/e2e/admin-ui.spec.ts`

**Interfaces:**
- Consumes: `GET /api/admin/v1/definitions/pending`, the accept and reject routes (Task 9).

- [ ] **Step 1: Write the failing test**

```ts
test('an operator adopts a definition a peer sent', async ({ page }) => {
  await signInToAdmin(page, 'org-b')
  await page.getByTestId('tab-definitions').click()

  const pending = page.getByTestId('pending-definition').first()
  await expect(pending).toContainText('did:web:org-a.example')

  await pending.getByTestId('accept').click()
  await expect(page.getByTestId('pending-definition')).toHaveCount(0)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `docker compose up -d --build && pnpm test:e2e admin-ui`
Expected: FAIL — no definitions tab.

- [ ] **Step 3: Write the implementation**

Add a **Definitions** tab listing held definitions and, above them, pending ones. Each pending entry shows the ref, the peer DID, the lint warnings, and — when `diffAgainst` is set — the structural changes as a list (`state added: DISPUTED`, `transition changed: go (by)`), with the raw JSON diff behind a disclosure. Accept and Reject post to Task 9's routes and refetch.

**Fix the offering prefill in the same pass (spec F8).** Replace the hardcoded `urn:offering:example:container-weighing` / `Container weighing` with values drawn from the definitions this connector holds: default the quotation and service selects to the first held definition of each kind, and leave the id and title fields empty with neutral placeholders (`urn:offering:<your-org>:<name>`). This is both the de-domaining fix and the more useful behaviour.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test:e2e admin-ui`
Expected: PASS.

- [ ] **Step 5: Verify**

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm lint:definitions && pnpm format:check
```

Then stop and tell the supervisor the task is ready to review and commit.

---

### Task 12: Neutral vocabulary, and the documents that describe all this

Finishes spec F8 and records the milestone. The connector, protocol and client contain **no code branching on a domain term** — this is about two remaining strings and the documents.

**Files:**
- Modify: `packages/protocol/src/schemas/common.ts:78`
- Modify: `packages/client/src/openapi.ts:551`, then `pnpm openapi:export`
- Modify: `README.md`, `docs/ARCHITECTURE.md`, `docs/DEFINITIONS.md`, `docs/ROADMAP.md`, `CLAUDE.md`, `AGENT.md`
- Test: `tests/e2e/process-ui.spec.ts`

**Interfaces:** none.

- [ ] **Step 1: Write the failing test**

```ts
test('a definition authored in the UI can be started immediately', async ({ page }) => {
  await signIn(page, 'org-a')
  await page.getByTestId('tab-authoring').click()

  await page.getByTestId('definition-source').fill(JSON.stringify(minimalDefinition, null, 2))
  await expect(page.getByTestId('diagnostics')).toContainText('No problems')
  await page.getByTestId('publish').click()

  await page.getByTestId('tab-start').click()
  await expect(page.locator('select[name="definition"]')).toContainText('Minimal')
})

test('a definition that cannot be started on its own says so', async ({ page }) => {
  await signIn(page, 'org-a')
  await page.getByTestId('tab-start').click()
  await page.locator('select[name="definition"]').selectOption({ label: /road transport \(service\)/ })

  await expect(page.getByTestId('start')).toBeDisabled()
  await expect(page.getByText(/cannot be started on its own/)).toBeVisible()
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `docker compose up -d --build && pnpm test:e2e process-ui`
Expected: FAIL if Task 10 is incomplete; otherwise PASS. If it passes immediately, confirm the assertions are real by breaking one deliberately, then restoring it.

- [ ] **Step 3: Make the two string fixes**

`common.ts:78` — replace `'expected a dotted path into the data document, e.g. grossMass.value'` with a neutral example: `'expected a dotted path into the data document, e.g. total.amount'`.

`openapi.ts:551` — replace the `VGM_ISSUED` example with a neutral phrasing: `Close a ticket on \`fulfilled\` rather than hardcoding one process's own name for its good ending.` Then run `pnpm openapi:export`.

- [ ] **Step 4: Update the documents**

- `docs/ROADMAP.md` — add M6.5 with its exit criteria, and add the deferred topics as named future work: **the audit split** (spec §10) and **migration**. Record migration with the framing that makes it tractable: completed instances are already handled, because the event log is the record and `rebuild` regenerates the materialised instance from it; the hard half is in-flight migration to a new definition version, which is a **protocol** question rather than an ops one, since `definition` and `definitionHash` sit in the immutable genesis and pin an instance to `id@version` for life. Note that a schema-version marker, if one is ever wanted, belongs on the unsigned `StoredEvent` wrapper, where it can be added at any time with no chain break.
- `docs/ARCHITECTURE.md` — a section on definition authoring and adoption, and the `definitionHash` addition to the genesis.
- `docs/DEFINITIONS.md` — the four new lint rules, with an explanation of why `dead-end-state` was not enough.
- `README.md` — how to author a definition in the demo, and what the other side sees.
- `CLAUDE.md` and `AGENT.md` — the milestone table, and the standing rule that no domain vocabulary belongs in the connector, protocol, client or base UIs.

- [ ] **Step 5: Verify**

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm lint:definitions && pnpm format:check
docker compose up -d --build && pnpm test:e2e
```

Confirm all e2e specs pass and the four containers reach healthy. Then stop and tell the supervisor the task is ready to review and commit.

---

## Notes for whoever executes this

- **Tasks 1–5 are independently valuable.** They deliver the check that would have caught the bug that prompted the milestone, with no authoring UI at all. If the milestone is cut short, cut after Task 5.
- **Task 4 is the breaking one.** Expect connector tests to fail on a missing field until it is threaded through every service that rebuilds an instance shape. A test still failing after that is telling you a site was missed — do not silence it with a cast.
- **Do not let the linter grow its own graph reasoning.** Every reachability question belongs in `engine/reachability.ts`, because the connector (Task 5) and the process UI (Task 10) ask the same questions and must get the same answers.
