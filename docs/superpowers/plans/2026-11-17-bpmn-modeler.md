# BPMN Modeler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user draw a multi-participant process in BPMN notation in the process UI, with every edit
translated losslessly into the process definition the connector already runs.

**Architecture:** A new pure package, `packages/bpmn`, projects a definition into a BPMN-style diagram
model (`toDiagram`) and expresses every edit as a typed command on the definition (`applyCommand`). The
diagram is never parsed back, so the round trip is lossless by construction. `apps/process-ui` gets a
Diagram tab beside the existing JSON editor, on one shared draft, drawn with React Flow (already a
dependency). The connector, the protocol and the client do not change.

**Tech Stack:** TypeScript (strict), pnpm workspace, tsup (dual ESM+CJS), Vitest, React 19,
`@xyflow/react` 12, Tailwind, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-17-bpmn-modeler-design.md` — read it before starting. Decision
ids `B1…B7` below refer to it.

## Global Constraints

- **No new npm dependencies.** `@pilots/bpmn` is a new workspace package; `zod` 4.5.4 and
  `@pilots/protocol` are its only dependencies, and both are imported **as types only**.
- **`packages/bpmn` is browser-safe:** no runtime import from `@pilots/protocol` or `zod` (the protocol's
  `canonical.ts` imports `node:crypto`), and no `node:` import anywhere under `packages/bpmn/src`. Tests
  may import the protocol at runtime.
- **Commands edit the document as written** — `z.input<typeof ProcessDefinition>`, never the parsed
  output. Parsing adds defaults (`auto: false`, `cardinality: 1`, …) and the `definitionHash` covers the
  bytes, so writing back the parsed form would change the identity of every process merely opened.
- **A patch key set to `undefined` removes the key**; commands never leave an explicit `undefined`.
- **Commands guarantee referential integrity** (no dangling reference, no duplicate id, identifier syntax
  for new ids, the reserved transition id `create` refused). **Values** — a version string, a duration,
  a link's `onEvent` — are the linter's job (B6).
- **Layout never enters the definition** (B4). It lives in the browser.
- **No domain vocabulary** in labels, placeholders, palette names, test ids or test fixtures of the
  package and the UI (non-negotiable 11). Neutral fixture names only: `alpha`, `beta`, `OPEN`, `DONE`.
- **No new endpoint.** The editor uses the existing `lint` and `publish` calls through the BFF.
- **The palette offers only:** Lane, Task, State, End (fulfilled), End (abandoned), Timer, Message. No
  parallel gateway, subprocess, loop, data object or second pool.
- **Import boundaries:** `packages/bpmn` → `packages/protocol` only. `apps/process-ui` may import
  `packages/bpmn`. `apps/connector/test` may import `packages/bpmn`; `apps/connector/src` may not.
- **Never run a git write** (`git add`, `git commit`, `git push`, …). This repo reserves them for the
  supervisor and `.claude/settings.json` blocks them. Every task ends with **Verify**, then stop and
  report the task as ready to review and commit.
- Comments follow the repo's style: say *why*, in full sentences, at the density of the surrounding code.

## File map

```
packages/bpmn/                         NEW
  package.json, tsconfig.json, tsup.config.ts, vitest.config.ts
  src/index.ts                         public surface
  src/document.ts                      DefinitionDocument and friends (types only), ANY_STATE
  src/model.ts                         DiagramModel, ElementRef, node/edge keys
  src/project.ts                       toDiagram
  src/layout.ts                        DiagramLayout, autoLayout, withLayout, laneAt, renameLayoutKeys
  src/commands/types.ts                Command, CommandError, CommandResult
  src/commands/ids.ts                  IDENTIFIER, freshId, identifierFrom, bumpVersion
  src/commands/checks.ts               shared guards: fail/done/unknown/idsOf/checkNewId/assign
  src/commands/pointer.ts              RFC 6901 get/set, pointerOf
  src/commands/references.ts           dependentsOf, renameElement, removeElement
  src/commands/apply.ts                applyCommand
  src/forms/fields.ts                  field builder ⇄ data schema
  src/forms/task-fields.ts             "fills in" / "must be present" ⇄ patch / guards
  src/forms/visibility.ts              field × role access ⇄ visibility grants
  src/diagnostics.ts                   linter JSON Pointer → diagram key
  test/helpers/examples.ts, test/helpers/small.ts
  test/*.test.ts
apps/process-ui/src/web/modeler/       NEW
  draft.ts, storage.ts, flow.ts        pure, unit-tested
  shapes.tsx, Canvas.tsx, Palette.tsx, NewElement.tsx, Properties.tsx,
  properties/*.tsx, fields.tsx, Modeler.tsx
apps/process-ui/src/web/views/Authoring.tsx   MODIFIED: tabs over one draft
apps/process-ui/test/modeler-*.test.ts        NEW
apps/connector/test/drawn-process.test.ts     NEW scenario test
tests/e2e/modeler.spec.ts                     NEW; process-ui.spec.ts MODIFIED (one line)
eslint.config.mjs, package.json, apps/process-ui/{package.json,vitest.config.mts,Dockerfile},
apps/connector/{package.json,vitest.config.mts}, CLAUDE.md, docs/DEFINITIONS.md   MODIFIED
```

---

### Task 1: `packages/bpmn` scaffold, document types, and the projection of roles, states and tasks

**Files:**
- Create: `packages/bpmn/package.json`, `packages/bpmn/tsconfig.json`, `packages/bpmn/tsup.config.ts`,
  `packages/bpmn/vitest.config.ts`
- Create: `packages/bpmn/src/index.ts`, `src/document.ts`, `src/model.ts`, `src/project.ts`
- Create: `packages/bpmn/test/helpers/examples.ts`, `test/helpers/small.ts`, `test/project.test.ts`,
  `test/browser-safe.test.ts`
- Modify: `eslint.config.mjs` (element + policy), root `package.json` (`typecheck` builds bpmn)

**Interfaces:**
- Produces: `DefinitionDocument`, `RoleDocument`, `StateDocument`, `TransitionDocument`,
  `VisibilityDocument`, `LinkDocument`, `SchemaDocument`, `ANY_STATE`; `DiagramModel`, `DiagramLane`,
  `DiagramNode`, `DiagramEdge`, `ElementRef`, `NodeKind`, `Marker`, `Layer`; key helpers `laneKey(role)`,
  `stateKey(state)`, `taskKey(transition, role?)`, `timerKey(transition)`,
  `messageKey(transition, occurrence)`, `gatewayKey(state)`; `toDiagram(document): DiagramModel`.
- Test helpers: `examples(): { name: string; document: DefinitionDocument }[]`,
  `example(name): DefinitionDocument`, `small(): DefinitionDocument`.

- [ ] **Step 1: Create the package files**

`packages/bpmn/package.json`:

```json
{
  "name": "@pilots/bpmn",
  "version": "0.1.0",
  "description": "A process definition as a BPMN-style diagram, and every edit to it as a command on the definition. Pure and browser-safe.",
  "license": "UNLICENSED",
  "type": "module",
  "main": "./dist/index.cjs",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "import": {
        "types": "./dist/index.d.ts",
        "default": "./dist/index.js"
      },
      "require": {
        "types": "./dist/index.d.cts",
        "default": "./dist/index.cjs"
      }
    }
  },
  "files": [
    "dist"
  ],
  "scripts": {
    "build": "tsup",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@pilots/protocol": "workspace:*",
    "zod": "4.5.4"
  }
}
```

`packages/bpmn/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "module": "preserve",
    "moduleResolution": "bundler",
    "types": ["node"],
    "noEmit": true,
    "rootDir": "."
  },
  "include": ["src", "test", "*.ts"]
}
```

`packages/bpmn/tsup.config.ts`:

```ts
import { defineConfig } from 'tsup'

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'node24',
  // Drawn in a browser, tested in Node: nothing here may assume either. The
  // protocol and zod are imported as types only, so neither reaches the bundle.
  platform: 'neutral',
})
```

`packages/bpmn/vitest.config.ts`:

```ts
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

const here = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      // Tests use the spec at runtime — the linter, the schema, the hash — and
      // against its source, so a schema change needs no build step to be seen.
      '@pilots/protocol': resolve(here, '../protocol/src/index.ts'),
    },
  },
  test: { name: 'bpmn', include: ['test/**/*.test.ts'], environment: 'node' },
})
```

- [ ] **Step 2: Register the package in the workspace gates**

In `eslint.config.mjs`, add the element after `client`:

```js
        { type: 'bpmn', pattern: 'packages/bpmn/*' },
```

and the policy after the `client` policy:

```js
            // The diagram is a projection of the spec and depends on nothing else.
            {
              from: { element: { type: 'bpmn' } },
              allow: { to: { element: { types: { anyOf: ['bpmn', 'protocol'] } } } },
            },
```

In the root `package.json`, make `typecheck` build the new package before checking every project:

```json
    "typecheck": "pnpm --filter @pilots/protocol build && pnpm --filter @pilots/client build && pnpm --filter @pilots/bpmn build && pnpm -r typecheck",
```

Run: `pnpm install`
Expected: the lockfile gains the `packages/bpmn` importer; no new external package is downloaded.

- [ ] **Step 3: Write the document types and the model**

`packages/bpmn/src/document.ts`:

```ts
/**
 * The definition as its author wrote it — before the schema fills in defaults.
 *
 * Every command edits this shape and never the parsed one. `ProcessDefinition`
 * adds `auto: false`, `cardinality: 1`, `visibility: []` and more when it
 * parses, and the `definitionHash` covers the document's bytes: an editor that
 * wrote back the parsed form would change the identity of every process it
 * merely opened.
 *
 * Types only. The protocol imports `node:crypto` at runtime, and this package is
 * drawn in a browser.
 */
import type { ProcessDefinition } from '@pilots/protocol'
import type { z } from 'zod'

export type DefinitionDocument = z.input<typeof ProcessDefinition>
export type RoleDocument = DefinitionDocument['roles'][number]
export type StateDocument = DefinitionDocument['states'][number]
export type TransitionDocument = DefinitionDocument['transitions'][number]
export type VisibilityDocument = NonNullable<DefinitionDocument['visibility']>[number]
export type LinkDocument = NonNullable<DefinitionDocument['links']>[number]
export type SchemaDocument = DefinitionDocument['data']

/** `from: ["*"]` — any non-terminal state. Mirrors `ANY_STATE` in the protocol. */
export const ANY_STATE = '*'
```

`packages/bpmn/src/model.ts`:

```ts
/**
 * A definition, as a BPMN-style diagram.
 *
 * Plain data, nothing React Flow-shaped, so the projection is unit-tested and a
 * third party's UI can draw it with whatever it likes.
 *
 * Every node and edge carries a `ref` to the definition element behind it, and
 * a `layer`. Only `shared` exists today; a participant's private tasks arrive as
 * `private` nodes from a separate artefact, without touching the definition
 * (B7 in the design record).
 */
export type Layer = 'shared' | 'private'

export type ElementRef =
  | { kind: 'role'; id: string }
  | { kind: 'state'; id: string }
  | { kind: 'transition'; id: string }
  | { kind: 'link'; index: number }

export type NodeKind = 'start' | 'state' | 'end' | 'task' | 'timer' | 'message' | 'gateway'

export type Marker = 'fulfilled' | 'abandoned' | 'auto' | 'any-state' | 'update' | 'unfireable'

export interface DiagramLane {
  key: string
  roleId: string
  title: string
  /** `cardinality > 1`: several participants fill this role. */
  multiple: boolean
}

export interface DiagramNode {
  key: string
  kind: NodeKind
  label: string
  /** The role whose lane this is in. `null` for states and events: their lane is layout only. */
  lane: string | null
  /** `null` only for derived nodes — gateways — which have nothing behind them to edit. */
  ref: ElementRef | null
  layer: Layer
  markers: Marker[]
}

export interface DiagramEdge {
  key: string
  source: string
  target: string
  label: string | null
  ref: ElementRef | null
  layer: Layer
  markers: Marker[]
}

export interface DiagramModel {
  lanes: DiagramLane[]
  nodes: DiagramNode[]
  edges: DiagramEdge[]
}

/*
 * Keys are derived from ids, so they are stable across renders and a saved
 * layout survives an edit. A rename rewrites them (`renameLayoutKeys`).
 */
export const laneKey = (role: string): string => `lane:${role}`
export const stateKey = (state: string): string => `state:${state}`
export const taskKey = (transition: string, role?: string): string =>
  role === undefined ? `task:${transition}` : `task:${transition}@${role}`
export const timerKey = (transition: string): string => `timer:${transition}`
export const messageKey = (transition: string, occurrence: number): string =>
  `message:${transition}#${occurrence}`
export const gatewayKey = (state: string): string => `gateway:${state}`
```

- [ ] **Step 4: Write the test helpers**

`packages/bpmn/test/helpers/examples.ts`:

```ts
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { DefinitionDocument } from '../../src/document.js'

const DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../../docs/definitions')

export interface Example {
  name: string
  document: DefinitionDocument
}

/** The five committed definitions, exactly as written — never parsed, so defaults stay absent. */
export function examples(): Example[] {
  return readdirSync(DIR)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => ({
      name,
      document: JSON.parse(readFileSync(join(DIR, name), 'utf8')) as DefinitionDocument,
    }))
}

export function example(name: string): DefinitionDocument {
  const found = examples().find((one) => one.name === `${name}.json`)
  if (!found) throw new Error(`no example called ${name}`)
  return found.document
}
```

`packages/bpmn/test/helpers/small.ts`:

```ts
import type { DefinitionDocument } from '../../src/document.js'

/** Two roles, three states, one ordinary task and one wildcard. Neutral names on purpose. */
export function small(): DefinitionDocument {
  return {
    '@context': 'https://pilots.example/process/v1',
    id: 'small',
    version: '1.0.0',
    kind: 'service',
    title: 'Small',
    roles: [
      { id: 'alpha', title: 'Alpha' },
      { id: 'beta', title: 'Beta' },
    ],
    hostedBy: 'beta',
    initialState: 'OPEN',
    states: [
      { id: 'OPEN', title: 'Open' },
      { id: 'DONE', title: 'Done', outcome: 'fulfilled' },
      { id: 'DROPPED', title: 'Dropped', outcome: 'abandoned' },
    ],
    data: { type: 'object', properties: { note: { type: 'string' } } },
    transitions: [
      { id: 'finish', title: 'Finish', from: ['OPEN'], to: 'DONE', by: ['beta'] },
      { id: 'drop', title: 'Drop', from: ['*'], to: 'DROPPED', by: ['alpha', 'beta'] },
    ],
    visibility: [],
    links: [],
  }
}
```

- [ ] **Step 5: Write the failing tests**

`packages/bpmn/test/project.test.ts`:

```ts
/**
 * The projection: a definition, drawn.
 *
 * The rule under test throughout is that the diagram is derived and never the
 * source — so every element of the definition must be findable in it, and
 * drawing must never change the document.
 */
import { describe, expect, it } from 'vitest'

import { toDiagram } from '../src/project.js'
import { small } from './helpers/small.js'

const keys = (items: { key: string }[]): string[] => items.map((one) => one.key)

describe('roles and states', () => {
  it('draws one lane per role, in the order the definition lists them', () => {
    const model = toDiagram(small())
    expect(model.lanes.map((lane) => lane.roleId)).toEqual(['alpha', 'beta'])
    expect(model.lanes[0]).toMatchObject({ key: 'lane:alpha', title: 'Alpha', multiple: false })
  })

  it('marks a role several participants fill', () => {
    const document = small()
    document.roles[0]!.cardinality = 3
    expect(toDiagram(document).lanes[0]!.multiple).toBe(true)
  })

  it('draws the initial state as a start, an ending as an end carrying its outcome', () => {
    const nodes = toDiagram(small()).nodes
    expect(nodes.find((n) => n.key === 'state:OPEN')).toMatchObject({ kind: 'start', lane: null })
    expect(nodes.find((n) => n.key === 'state:DONE')).toMatchObject({ kind: 'end', markers: ['fulfilled'] })
    expect(nodes.find((n) => n.key === 'state:DROPPED')).toMatchObject({ kind: 'end', markers: ['abandoned'] })
  })

  it('draws any other state as an intermediate event', () => {
    const document = small()
    document.states.push({ id: 'WAITING', title: 'Waiting' })
    expect(toDiagram(document).nodes.find((n) => n.key === 'state:WAITING')?.kind).toBe('state')
  })
})

describe('tasks', () => {
  it('draws one task per role that may fire the transition, in that role’s lane', () => {
    const nodes = toDiagram(small()).nodes.filter((n) => n.kind === 'task')
    expect(keys(nodes)).toEqual(['task:finish@beta', 'task:drop@alpha', 'task:drop@beta'])
    expect(nodes[1]).toMatchObject({ lane: 'alpha', ref: { kind: 'transition', id: 'drop' } })
  })

  it('draws a wildcard as one marker, not an arrow from every state', () => {
    const model = toDiagram(small())
    expect(model.nodes.find((n) => n.key === 'task:drop@alpha')?.markers).toContain('any-state')
    expect(model.edges.filter((e) => e.target === 'task:drop@alpha')).toEqual([])
  })

  it('connects a state straight to its only way out, and the task to where it leads', () => {
    const edges = toDiagram(small()).edges.map((e) => `${e.source}->${e.target}`)
    expect(edges).toContain('state:OPEN->task:finish@beta')
    expect(edges).toContain('task:finish@beta->state:DONE')
  })

  it('draws a pure data update as an arrow back to where it came from', () => {
    const document = small()
    document.transitions.push({ id: 'annotate', title: 'Annotate', from: ['OPEN'], by: ['alpha'] })
    const model = toDiagram(document)
    expect(model.nodes.find((n) => n.key === 'task:annotate@alpha')?.markers).toContain('update')
    expect(model.edges.map((e) => `${e.source}->${e.target}`)).toContain('task:annotate@alpha->state:OPEN')
  })

  it('puts a derived gateway after a state with more than one way out', () => {
    const document = small()
    document.transitions.push({ id: 'review', title: 'Review', from: ['OPEN'], to: 'DONE', by: ['alpha'] })
    const model = toDiagram(document)
    const gateway = model.nodes.find((n) => n.key === 'gateway:OPEN')
    expect(gateway).toMatchObject({ kind: 'gateway', ref: null })
    const out = model.edges.filter((e) => e.source === 'gateway:OPEN').map((e) => e.target)
    expect(out).toEqual(['task:finish@beta', 'task:review@alpha'])
    expect(model.edges.map((e) => `${e.source}->${e.target}`)).toContain('state:OPEN->gateway:OPEN')
  })

  it('marks every node and edge as shared — the only layer that exists today', () => {
    const model = toDiagram(small())
    expect(new Set([...model.nodes, ...model.edges].map((one) => one.layer))).toEqual(new Set(['shared']))
  })

  it('never changes the document it draws', () => {
    const document = small()
    const before = JSON.stringify(document)
    toDiagram(deepFreeze(document))
    expect(JSON.stringify(document)).toBe(before)
  })
})

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}
```

`packages/bpmn/test/browser-safe.test.ts`:

```ts
/**
 * This package is drawn in a browser. The protocol imports `node:crypto`, so a
 * single value import from it would break the process UI's bundle — and would
 * only show up there, not in any test of this package. So it is checked here.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '../src')

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? sources(path) : path.endsWith('.ts') ? [path] : []
  })
}

describe('browser safety', () => {
  it('imports the protocol and zod as types only, and nothing from node', () => {
    const offenders = sources(SRC).filter((path) => {
      const text = readFileSync(path, 'utf8')
      return (
        /^import\s+(?!type\b)[^;]*from\s+'(@pilots\/protocol|zod)'/m.test(text) ||
        /from\s+'node:/.test(text)
      )
    })
    expect(offenders).toEqual([])
  })
})
```

- [ ] **Step 6: Run the tests to see them fail**

Run: `pnpm --filter @pilots/bpmn exec vitest run`
Expected: FAIL — `../src/project.js` does not exist (the browser-safety test passes).

- [ ] **Step 7: Implement the projection of roles, states and participant tasks**

`packages/bpmn/src/project.ts`:

```ts
/**
 * A definition, drawn as BPMN — states as events, transitions as tasks.
 *
 * BPMN is task-centric and a definition is state-centric, so the mapping is:
 * a role is a lane, a transition is a task in the lane of each role allowed to
 * fire it, a state is an event between tasks, and an ending is an end event
 * carrying its outcome. More than one way out of a state gets an event-based
 * gateway — "whoever acts first" — which is derived and never stored.
 *
 * Nothing here is ever parsed back: edits are commands on the definition, and
 * the diagram is projected again. That is what keeps the round trip lossless.
 */
import { ANY_STATE, type DefinitionDocument, type TransitionDocument } from './document.js'
import {
  gatewayKey,
  laneKey,
  stateKey,
  taskKey,
  type DiagramEdge,
  type DiagramModel,
  type DiagramNode,
  type ElementRef,
  type Marker,
} from './model.js'

/** A way out of a state, collected first so a state with several gets a gateway. */
interface Exit {
  state: string
  target: string
  ref: ElementRef
  label: string | null
  markers: Marker[]
}

export function toDiagram(document: DefinitionDocument): DiagramModel {
  const lanes = document.roles.map((role) => ({
    key: laneKey(role.id),
    roleId: role.id,
    title: role.title,
    multiple: (role.cardinality ?? 1) > 1,
  }))

  const nodes: DiagramNode[] = document.states.map((state) => ({
    key: stateKey(state.id),
    kind:
      state.id === document.initialState ? 'start' : state.outcome === undefined ? 'state' : 'end',
    label: state.title,
    lane: null,
    ref: { kind: 'state', id: state.id },
    layer: 'shared',
    markers: state.outcome === undefined ? [] : [state.outcome],
  }))

  const exits: Exit[] = []
  const edges: DiagramEdge[] = []
  const edge = (
    source: string,
    target: string,
    ref: ElementRef | null,
    label: string | null = null,
    markers: Marker[] = [],
  ): void => {
    edges.push({ key: `${source}->${target}`, source, target, label, ref, layer: 'shared', markers })
  }

  for (const transition of document.transitions) {
    if (transition.by.length === 0) continue
    const markers = markersOf(transition)
    for (const role of transition.by) {
      const key = taskKey(transition.id, role)
      nodes.push({
        key,
        kind: 'task',
        label: transition.title,
        lane: role,
        ref: refOf(transition),
        layer: 'shared',
        markers,
      })
      for (const state of sourcesOf(transition)) {
        exits.push({ state, target: key, ref: refOf(transition), label: null, markers: [] })
      }
      for (const state of targetsOf(transition)) edge(key, stateKey(state), refOf(transition))
    }
  }

  connectExits(exits, nodes, edge)
  return { lanes, nodes, edges: settle(nodes, edges) }
}

export function refOf(transition: TransitionDocument): ElementRef {
  return { kind: 'transition', id: transition.id }
}

/** Where a transition may be applied. A wildcard has no arrows: it is a marker instead. */
export function sourcesOf(transition: TransitionDocument): string[] {
  return transition.from.includes(ANY_STATE) ? [] : transition.from
}

/** Where a transition leads: its `to`, or back where it came from for a pure data update. */
export function targetsOf(transition: TransitionDocument): string[] {
  return transition.to === undefined ? sourcesOf(transition) : [transition.to]
}

function markersOf(transition: TransitionDocument): Marker[] {
  const markers: Marker[] = []
  if (transition.from.includes(ANY_STATE)) markers.push('any-state')
  if (transition.auto === true) markers.push('auto')
  if (transition.to === undefined) markers.push('update')
  return markers
}

/** One way out: a straight arrow. More: a derived gateway that fans out. */
function connectExits(
  exits: Exit[],
  nodes: DiagramNode[],
  edge: (s: string, t: string, r: ElementRef | null, l?: string | null, m?: Marker[]) => void,
): void {
  const byState = new Map<string, Exit[]>()
  for (const exit of exits) byState.set(exit.state, [...(byState.get(exit.state) ?? []), exit])
  for (const [state, list] of byState) {
    const only = list.length === 1 ? list[0] : undefined
    if (only !== undefined) {
      edge(stateKey(state), only.target, only.ref, only.label, only.markers)
      continue
    }
    const gateway = gatewayKey(state)
    nodes.push({ key: gateway, kind: 'gateway', label: '', lane: null, ref: null, layer: 'shared', markers: [] })
    edge(stateKey(state), gateway, null)
    for (const exit of list) edge(gateway, exit.target, exit.ref, exit.label, exit.markers)
  }
}

/**
 * Drop edges to nodes that do not exist and make keys unique.
 *
 * A draft may name a state nobody declared — the JSON tab allows it, and the
 * linter reports it. Drawing must not fail on a draft the linter would explain.
 */
function settle(nodes: DiagramNode[], edges: DiagramEdge[]): DiagramEdge[] {
  const present = new Set(nodes.map((node) => node.key))
  const seen = new Map<string, number>()
  return edges
    .filter((one) => present.has(one.source) && present.has(one.target))
    .map((one) => {
      const count = seen.get(one.key) ?? 0
      seen.set(one.key, count + 1)
      return count === 0 ? one : { ...one, key: `${one.key}#${count}` }
    })
}
```

`packages/bpmn/src/index.ts`:

```ts
/**
 * `@pilots/bpmn` — a process definition as a BPMN-style diagram.
 *
 * The definition is the only source of truth. `toDiagram` projects it, and every
 * edit is a command on the definition; the drawing is never parsed back.
 */
export {
  ANY_STATE,
  type DefinitionDocument,
  type LinkDocument,
  type RoleDocument,
  type SchemaDocument,
  type StateDocument,
  type TransitionDocument,
  type VisibilityDocument,
} from './document.js'
export {
  gatewayKey,
  laneKey,
  messageKey,
  stateKey,
  taskKey,
  timerKey,
  type DiagramEdge,
  type DiagramLane,
  type DiagramModel,
  type DiagramNode,
  type ElementRef,
  type Layer,
  type Marker,
  type NodeKind,
} from './model.js'
export { toDiagram } from './project.js'
```

- [ ] **Step 8: Run the tests to see them pass**

Run: `pnpm --filter @pilots/bpmn exec vitest run`
Expected: PASS, all tests in `project.test.ts` and `browser-safe.test.ts`.

- [ ] **Step 9: Verify**

```bash
pnpm typecheck && pnpm lint && pnpm test
```

Expected: all green. Then prove the boundary rule bites: temporarily add
`import '../../client/src/index.js'` to `packages/bpmn/src/index.ts`, run `pnpm lint`, see a
`boundaries/dependencies` error, and remove the line. Stop and tell the supervisor the task is ready to
review and commit.

---

### Task 2: Runtime-fired transitions — timers, messages, `auto`, and the unfireable

**Files:**
- Modify: `packages/bpmn/src/project.ts`
- Modify: `packages/bpmn/src/index.ts`
- Create: `packages/bpmn/test/project-triggers.test.ts`, `packages/bpmn/test/project-examples.test.ts`

**Interfaces:**
- Consumes: `toDiagram`, `refOf`, `sourcesOf`, `targetsOf`, key helpers (Task 1).
- Produces: `toDiagram` now also emits `timer` nodes (`timer:<arming transition>`, `ref` = the arming
  transition), `message` nodes (`message:<triggered>#<n>`, `ref` = `{ kind: 'link', index }`), `auto`
  arrows, and unfireable tasks (`task:<id>`, `lane: null`).

- [ ] **Step 1: Write the failing tests**

`packages/bpmn/test/project-triggers.test.ts`:

```ts
/**
 * Transitions the runtime fires: no lane, because the connector is not a
 * participant. A timer or a message *is* the transition when nobody may fire it
 * by hand, and points at the task when somebody also may (B3).
 */
import { describe, expect, it } from 'vitest'

import type { DefinitionDocument } from '../src/document.js'
import { toDiagram } from '../src/project.js'
import { small } from './helpers/small.js'

const arrows = (document: DefinitionDocument): string[] =>
  toDiagram(document).edges.map((e) => `${e.source}->${e.target}`)

/** OPEN → (propose) → WAITING; a deadline on `propose` lapses into DROPPED. */
function withDeadline(): DefinitionDocument {
  const document = small()
  document.states.push({ id: 'WAITING', title: 'Waiting' })
  document.transitions.push(
    { id: 'propose', title: 'Propose', from: ['OPEN'], to: 'WAITING', by: ['beta'], deadline: 'PT1H', onDeadline: 'lapse' },
    { id: 'settle', title: 'Settle', from: ['WAITING'], to: 'DONE', by: ['alpha'] },
    { id: 'lapse', title: 'Lapse', from: ['WAITING'], to: 'DROPPED', by: [] },
  )
  return document
}

describe('timers', () => {
  it('waits in the state the deadline arms in and is the transition it fires', () => {
    const model = toDiagram(withDeadline())
    expect(model.nodes.find((n) => n.key === 'timer:propose')).toMatchObject({
      kind: 'timer',
      label: 'PT1H',
      lane: null,
      ref: { kind: 'transition', id: 'propose' },
    })
    expect(model.nodes.some((n) => n.key.startsWith('task:lapse'))).toBe(false)
    const lapse = model.edges.find((e) => e.source === 'timer:propose')
    expect(lapse).toMatchObject({ target: 'state:DROPPED', ref: { kind: 'transition', id: 'lapse' } })
  })

  it('races the people who may act there, behind one gateway', () => {
    const out = toDiagram(withDeadline()).edges.filter((e) => e.source === 'gateway:WAITING')
    expect(out.map((e) => e.target)).toEqual(['task:settle@alpha', 'timer:propose'])
  })

  it('points at the task when the transition it fires is one people may also fire', () => {
    const document = withDeadline()
    document.transitions[2]!.onDeadline = 'drop'
    expect(arrows(document)).toContain('timer:propose->task:drop@alpha')
  })
})

describe('messages', () => {
  function linked(): DefinitionDocument {
    const document = small()
    document.transitions.push({ id: 'begin', title: 'Begin', from: ['OPEN'], to: 'DONE', by: [] })
    document.links = [
      { onEvent: 'quotation:AGREED', triggers: 'begin' },
      { onEvent: 'quotation:REJECTED', triggers: 'drop' },
    ]
    return document
  }

  it('is the transition a link fires when nobody may fire it by hand', () => {
    const model = toDiagram(linked())
    expect(model.nodes.find((n) => n.key === 'message:begin#0')).toMatchObject({
      kind: 'message',
      label: 'quotation:AGREED',
      ref: { kind: 'link', index: 0 },
    })
    expect(arrows(linked())).toContain('message:begin#0->state:DONE')
  })

  it('points at the task when people may fire it too, and carries the wildcard', () => {
    const model = toDiagram(linked())
    expect(model.nodes.find((n) => n.key === 'message:drop#0')?.markers).toContain('any-state')
    expect(arrows(linked())).toContain('message:drop#0->task:drop@alpha')
  })
})

describe('automatic and unfireable', () => {
  it('draws an automatic step nobody fires as an arrow, not a task', () => {
    const document = small()
    document.transitions.push({ id: 'skip', title: 'Skip', from: ['OPEN'], to: 'DONE', by: [], auto: true })
    const model = toDiagram(document)
    expect(model.nodes.some((n) => n.key.startsWith('task:skip'))).toBe(false)
    const arrow = model.edges.find((e) => e.ref?.kind === 'transition' && e.ref.id === 'skip')
    expect(arrow).toMatchObject({ label: 'Skip', markers: ['auto'] })
  })

  it('marks an automatic task somebody may also fire', () => {
    const document = small()
    document.transitions[0]!.auto = true
    expect(toDiagram(document).nodes.find((n) => n.key === 'task:finish@beta')?.markers).toContain('auto')
  })

  it('still draws a transition nothing can fire, outside every lane, rather than dropping it', () => {
    const document = small()
    document.transitions.push({ id: 'stuck', title: 'Stuck', from: ['OPEN'], to: 'DONE', by: [] })
    expect(toDiagram(document).nodes.find((n) => n.key === 'task:stuck')).toMatchObject({
      lane: null,
      markers: ['unfireable'],
    })
  })
})
```

`packages/bpmn/test/project-examples.test.ts`:

```ts
/**
 * The five committed definitions, drawn — the proof nothing is dropped.
 *
 * Every element must be findable in the diagram by its `ref`, and drawing must
 * leave the document byte-identical, so its `definitionHash` cannot move.
 */
import { hashJson, type JsonValue } from '@pilots/protocol'
import { describe, expect, it } from 'vitest'

import type { DiagramModel, ElementRef } from '../src/model.js'
import { toDiagram } from '../src/project.js'
import { examples } from './helpers/examples.js'

const refers = (model: DiagramModel, match: (ref: ElementRef) => boolean): boolean =>
  [...model.nodes, ...model.edges].some((one) => one.ref !== null && match(one.ref))

describe.each(examples())('$name', ({ document }) => {
  const model = toDiagram(document)

  it('draws every role as a lane', () => {
    expect(model.lanes.map((lane) => lane.roleId)).toEqual(document.roles.map((role) => role.id))
  })

  it('draws every state', () => {
    for (const state of document.states) {
      expect(refers(model, (ref) => ref.kind === 'state' && ref.id === state.id)).toBe(true)
    }
  })

  it('draws every transition, as a task, an event or an arrow', () => {
    for (const transition of document.transitions) {
      expect(refers(model, (ref) => ref.kind === 'transition' && ref.id === transition.id), transition.id).toBe(true)
    }
  })

  it('draws every deadline as a timer and every link as a message', () => {
    for (const transition of document.transitions.filter((one) => one.deadline !== undefined)) {
      expect(model.nodes.some((n) => n.key === `timer:${transition.id}`)).toBe(true)
    }
    for (const [index] of (document.links ?? []).entries()) {
      expect(refers(model, (ref) => ref.kind === 'link' && ref.index === index)).toBe(true)
    }
  })

  it('marks every automatic transition and every wildcard', () => {
    for (const transition of document.transitions) {
      const drawn = [...model.nodes, ...model.edges].filter(
        (one) => one.ref?.kind === 'transition' && one.ref.id === transition.id,
      )
      if (transition.auto === true) expect(drawn.some((one) => one.markers.includes('auto'))).toBe(true)
      if (transition.from.includes('*') && transition.by.length > 0) {
        expect(drawn.some((one) => one.markers.includes('any-state'))).toBe(true)
      }
    }
  })

  it('leaves the document — and therefore its hash — exactly as it was', () => {
    const before = hashJson(document as unknown as JsonValue)
    toDiagram(document)
    expect(hashJson(document as unknown as JsonValue)).toBe(before)
  })
})
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `pnpm --filter @pilots/bpmn exec vitest run test/project-triggers.test.ts test/project-examples.test.ts`
Expected: FAIL — no `timer:`/`message:` nodes yet; example coverage fails for `expire`,
`startExecution` and `agree`.

- [ ] **Step 3: Implement triggers**

In `packages/bpmn/src/project.ts`, import the extra keys:

```ts
import {
  gatewayKey,
  laneKey,
  messageKey,
  stateKey,
  taskKey,
  timerKey,
  type DiagramEdge,
  type DiagramModel,
  type DiagramNode,
  type ElementRef,
  type Marker,
} from './model.js'
```

Replace the transitions loop and what follows it, up to `connectExits(…)`, with:

```ts
  const links = document.links ?? []
  const byId = new Map(document.transitions.map((one) => [one.id, one]))
  const isTriggered = (transition: TransitionDocument): boolean =>
    document.transitions.some((one) => one.onDeadline === transition.id && one.deadline !== undefined) ||
    links.some((link) => link.triggers === transition.id)

  for (const transition of document.transitions) {
    const markers = markersOf(transition)
    const wildcard = transition.from.includes(ANY_STATE)

    if (transition.by.length > 0) {
      for (const role of transition.by) {
        const key = taskKey(transition.id, role)
        nodes.push({ key, kind: 'task', label: transition.title, lane: role, ref: refOf(transition), layer: 'shared', markers })
        for (const state of sourcesOf(transition)) {
          exits.push({ state, target: key, ref: refOf(transition), label: null, markers: [] })
        }
        for (const state of targetsOf(transition)) edge(key, stateKey(state), refOf(transition))
      }
      continue
    }

    const to = transition.to
    if (transition.auto === true && !wildcard && to !== undefined) {
      // A step nobody takes: the arrow is the transition.
      for (const state of sourcesOf(transition)) {
        exits.push({ state, target: stateKey(to), ref: refOf(transition), label: transition.title, markers: ['auto'] })
      }
      continue
    }

    if (transition.auto === true || !isTriggered(transition)) {
      // Outside every lane, because no role fires it. If nothing fires it at all
      // the linter says so; it is still drawn, because a projection that drops
      // what it cannot place is not lossless.
      const key = taskKey(transition.id)
      nodes.push({
        key,
        kind: 'task',
        label: transition.title,
        lane: null,
        ref: refOf(transition),
        layer: 'shared',
        markers: transition.auto === true ? markers : [...markers, 'unfireable'],
      })
      for (const state of sourcesOf(transition)) {
        exits.push({ state, target: key, ref: refOf(transition), label: null, markers: [] })
      }
      for (const state of targetsOf(transition)) edge(key, stateKey(state), refOf(transition))
    }
    // Otherwise a timer or a message fires it, and the event nodes below are the transition.
  }

  // Timers. A deadline belongs to the transition that *enters* a state: it arms on
  // entry into `to`, so the timer waits there, keyed by the transition that armed it.
  for (const arming of document.transitions) {
    if (arming.deadline === undefined) continue
    const key = timerKey(arming.id)
    nodes.push({ key, kind: 'timer', label: arming.deadline, lane: null, ref: refOf(arming), layer: 'shared', markers: [] })
    if (arming.to !== undefined) {
      exits.push({ state: arming.to, target: key, ref: refOf(arming), label: null, markers: [] })
    }
    const fired = arming.onDeadline === undefined ? undefined : byId.get(arming.onDeadline)
    if (fired === undefined) continue
    const firstRole = fired.by[0]
    if (firstRole !== undefined) {
      edge(key, taskKey(fired.id, firstRole), refOf(fired))
      continue
    }
    const lands = fired.to ?? arming.to
    if (lands !== undefined) edge(key, stateKey(lands), refOf(fired))
  }

  // Messages: a signed event in a linked instance.
  const occurrences = new Map<string, number>()
  links.forEach((link, index) => {
    const occurrence = occurrences.get(link.triggers) ?? 0
    occurrences.set(link.triggers, occurrence + 1)
    const key = messageKey(link.triggers, occurrence)
    const fired = byId.get(link.triggers)
    nodes.push({
      key,
      kind: 'message',
      label: link.onEvent,
      lane: null,
      ref: { kind: 'link', index },
      layer: 'shared',
      markers: fired?.from.includes(ANY_STATE) === true ? ['any-state'] : [],
    })
    if (fired === undefined) return
    const firstRole = fired.by[0]
    if (firstRole !== undefined) {
      edge(key, taskKey(fired.id, firstRole), refOf(fired))
      return
    }
    // Nobody fires it by hand, so the message is the transition: it waits where
    // the transition may be applied, and leads where it leads.
    for (const state of sourcesOf(fired)) {
      exits.push({ state, target: key, ref: refOf(fired), label: null, markers: [] })
    }
    for (const state of targetsOf(fired)) edge(key, stateKey(state), refOf(fired))
  })
```

Keep `connectExits(exits, nodes, edge)` and the `return` after it unchanged.

In `packages/bpmn/src/index.ts`, extend the projection export:

```ts
export { refOf, sourcesOf, targetsOf, toDiagram } from './project.js'
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `pnpm --filter @pilots/bpmn exec vitest run`
Expected: PASS — all of `project.test.ts`, `project-triggers.test.ts`, `project-examples.test.ts`
(five examples × six assertions), `browser-safe.test.ts`.

- [ ] **Step 5: Verify**

```bash
pnpm typecheck && pnpm lint && pnpm test
```

Stop and tell the supervisor the task is ready to review and commit.

---

### Task 3: Layout

**Files:**
- Create: `packages/bpmn/src/layout.ts`, `packages/bpmn/test/layout.test.ts`
- Modify: `packages/bpmn/src/index.ts`

**Interfaces:**
- Consumes: `DiagramModel` (Task 1).
- Produces: `type DiagramLayout = Record<string, { x: number; y: number }>`; `COLUMN_WIDTH`, `LANE_HEIGHT`,
  `LANE_GUTTER`; `autoLayout(model): DiagramLayout`; `withLayout(model, saved?): DiagramLayout`;
  `laneAt(model, y): string | null`; `renameLayoutKeys(layout, kind: 'role' | 'state' | 'transition', from, to): DiagramLayout`.

- [ ] **Step 1: Write the failing tests**

`packages/bpmn/test/layout.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { LANE_HEIGHT, autoLayout, laneAt, renameLayoutKeys, withLayout } from '../src/layout.js'
import { toDiagram } from '../src/project.js'
import { examples } from './helpers/examples.js'
import { small } from './helpers/small.js'

describe('autoLayout', () => {
  it.each(examples())('places every node of $name', ({ document }) => {
    const model = toDiagram(document)
    const layout = autoLayout(model)
    for (const node of model.nodes) expect(layout[node.key], node.key).toBeDefined()
  })

  it('puts a task inside its own lane', () => {
    const model = toDiagram(small())
    const layout = autoLayout(model)
    const beta = model.lanes.findIndex((lane) => lane.roleId === 'beta')
    const y = layout['task:finish@beta']!.y
    expect(y).toBeGreaterThanOrEqual(beta * LANE_HEIGHT)
    expect(y).toBeLessThan((beta + 1) * LANE_HEIGHT)
  })

  it('starts on the left and moves right along the flow', () => {
    const layout = autoLayout(toDiagram(small()))
    expect(layout['state:OPEN']!.x).toBeLessThan(layout['task:finish@beta']!.x)
    expect(layout['task:finish@beta']!.x).toBeLessThan(layout['state:DONE']!.x)
  })
})

describe('withLayout', () => {
  it('keeps what the author placed and fills in the rest', () => {
    const model = toDiagram(small())
    const layout = withLayout(model, { 'state:OPEN': { x: 7, y: 9 }, 'state:GONE': { x: 1, y: 1 } })
    expect(layout['state:OPEN']).toEqual({ x: 7, y: 9 })
    expect(layout['state:GONE']).toBeUndefined()
    expect(layout['state:DONE']).toEqual(autoLayout(model)['state:DONE'])
  })
})

describe('laneAt', () => {
  it('names the role whose lane a height falls in, or nothing below the last', () => {
    const model = toDiagram(small())
    expect(laneAt(model, 10)).toBe('alpha')
    expect(laneAt(model, LANE_HEIGHT + 10)).toBe('beta')
    expect(laneAt(model, 5 * LANE_HEIGHT)).toBeNull()
  })
})

describe('renameLayoutKeys', () => {
  const layout = {
    'lane:beta': { x: 0, y: 0 },
    'task:finish@beta': { x: 1, y: 1 },
    'state:OPEN': { x: 2, y: 2 },
    'gateway:OPEN': { x: 3, y: 3 },
    'timer:finish': { x: 4, y: 4 },
    'message:finish#0': { x: 5, y: 5 },
    'task:finishing@alpha': { x: 6, y: 6 },
  }

  it('follows a role', () => {
    const next = renameLayoutKeys(layout, 'role', 'beta', 'gamma')
    expect(next['lane:gamma']).toEqual({ x: 0, y: 0 })
    expect(next['task:finish@gamma']).toEqual({ x: 1, y: 1 })
  })

  it('follows a state and its gateway', () => {
    const next = renameLayoutKeys(layout, 'state', 'OPEN', 'READY')
    expect(next['state:READY']).toEqual({ x: 2, y: 2 })
    expect(next['gateway:READY']).toEqual({ x: 3, y: 3 })
  })

  it('follows a transition and leaves one that merely starts with the same letters', () => {
    const next = renameLayoutKeys(layout, 'transition', 'finish', 'close')
    expect(next['task:close@beta']).toEqual({ x: 1, y: 1 })
    expect(next['timer:close']).toEqual({ x: 4, y: 4 })
    expect(next['message:close#0']).toEqual({ x: 5, y: 5 })
    expect(next['task:finishing@alpha']).toEqual({ x: 6, y: 6 })
  })
})
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `pnpm --filter @pilots/bpmn exec vitest run test/layout.test.ts`
Expected: FAIL — `../src/layout.js` does not exist.

- [ ] **Step 3: Implement**

`packages/bpmn/src/layout.ts`:

```ts
/**
 * Positions — ours, and never inside the definition.
 *
 * The `definitionHash` covers the document's bytes, so moving a box must not
 * change a process's identity: layout is a separate map keyed by the stable
 * node keys of `model.ts`. Lanes are rows; columns are breadth-first from the
 * start, which suits definitions that are near-linear (the same reasoning as
 * the process UI's `layout.ts`, and the same refusal of a layout library).
 */
import type { DiagramModel } from './model.js'

export type DiagramLayout = Record<string, { x: number; y: number }>

export const COLUMN_WIDTH = 190
export const LANE_HEIGHT = 170
/** Room on the left of every lane for its title. */
export const LANE_GUTTER = 150
const ROW_SLOT = 52
const SLOTS_PER_ROW = 3

export function autoLayout(model: DiagramModel): DiagramLayout {
  const outgoing = new Map<string, string[]>()
  const incoming = new Map<string, string[]>()
  for (const edge of model.edges) {
    outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge.target])
    incoming.set(edge.target, [...(incoming.get(edge.target) ?? []), edge.source])
  }

  const column = new Map<string, number>()
  let frontier = model.nodes.filter((node) => node.kind === 'start').map((node) => node.key)
  for (const key of frontier) column.set(key, 0)
  while (frontier.length > 0) {
    const next: string[] = []
    for (const key of frontier) {
      for (const target of outgoing.get(key) ?? []) {
        if (column.has(target)) continue
        column.set(target, (column.get(key) ?? 0) + 1)
        next.push(target)
      }
    }
    frontier = next
  }
  // Nothing leads to a wildcard task or an unanchored message, so they sit past the end.
  const beyond = Math.max(0, ...column.values()) + 1

  const byKey = new Map(model.nodes.map((node) => [node.key, node]))
  const laneIndex = new Map(model.lanes.map((lane, index) => [lane.roleId, index]))
  const outside = model.lanes.length
  const rowOfLane = (lane: string | null | undefined): number | undefined =>
    lane === null || lane === undefined ? undefined : laneIndex.get(lane)

  /** A state or an event has no lane of its own: it sits with whoever leads to it, else with whoever leaves it. */
  const rowOf = (key: string): number => {
    const own = rowOfLane(byKey.get(key)?.lane)
    if (own !== undefined) return own
    for (const neighbour of [...(incoming.get(key) ?? []), ...(outgoing.get(key) ?? [])]) {
      const row = rowOfLane(byKey.get(neighbour)?.lane)
      if (row !== undefined) return row
    }
    return outside
  }

  const used = new Map<string, number>()
  const layout: DiagramLayout = {}
  for (const node of model.nodes) {
    const col = column.get(node.key) ?? beyond
    const row = rowOf(node.key)
    const cell = `${col}:${row}`
    const slot = used.get(cell) ?? 0
    used.set(cell, slot + 1)
    layout[node.key] = {
      x: LANE_GUTTER + col * COLUMN_WIDTH + Math.floor(slot / SLOTS_PER_ROW) * 40,
      y: row * LANE_HEIGHT + 24 + (slot % SLOTS_PER_ROW) * ROW_SLOT,
    }
  }
  return layout
}

/** What the author placed, where it still exists; the automatic layout for the rest. */
export function withLayout(model: DiagramModel, saved: DiagramLayout = {}): DiagramLayout {
  const layout = autoLayout(model)
  for (const key of Object.keys(layout)) {
    const placed = saved[key]
    if (placed !== undefined) layout[key] = placed
  }
  return layout
}

/** The role whose lane a height falls in. Dropping a task there changes who fires it. */
export function laneAt(model: DiagramModel, y: number): string | null {
  const index = Math.floor(y / LANE_HEIGHT)
  return model.lanes[index]?.roleId ?? null
}

/** Keys are derived from ids, so a rename must carry the author's positions with it. */
export function renameLayoutKeys(
  layout: DiagramLayout,
  kind: 'role' | 'state' | 'transition',
  from: string,
  to: string,
): DiagramLayout {
  const rewrite = (key: string): string => {
    const colon = key.indexOf(':')
    const prefix = key.slice(0, colon)
    const rest = key.slice(colon + 1)
    switch (kind) {
      case 'role':
        if (prefix === 'lane' && rest === from) return `lane:${to}`
        if (prefix === 'task' && rest.endsWith(`@${from}`)) {
          return `task:${rest.slice(0, -from.length - 1)}@${to}`
        }
        return key
      case 'state':
        return (prefix === 'state' || prefix === 'gateway') && rest === from ? `${prefix}:${to}` : key
      case 'transition':
        if (prefix === 'timer' && rest === from) return `timer:${to}`
        if (prefix === 'task' && (rest === from || rest.startsWith(`${from}@`))) {
          return `task:${to}${rest.slice(from.length)}`
        }
        if (prefix === 'message' && rest.startsWith(`${from}#`)) {
          return `message:${to}${rest.slice(from.length)}`
        }
        return key
    }
  }
  return Object.fromEntries(Object.entries(layout).map(([key, value]) => [rewrite(key), value]))
}
```

In `packages/bpmn/src/index.ts`, add:

```ts
export {
  COLUMN_WIDTH,
  LANE_GUTTER,
  LANE_HEIGHT,
  autoLayout,
  laneAt,
  renameLayoutKeys,
  withLayout,
  type DiagramLayout,
} from './layout.js'
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `pnpm --filter @pilots/bpmn exec vitest run`
Expected: PASS.

- [ ] **Step 5: Verify**

```bash
pnpm typecheck && pnpm lint && pnpm test
```

Stop and tell the supervisor the task is ready to review and commit.

---

### Task 4: Commands — the structured edits

**Files:**
- Create: `packages/bpmn/src/commands/types.ts`, `commands/ids.ts`, `commands/checks.ts`,
  `commands/pointer.ts`, `commands/references.ts` (stubs filled in Task 5), `commands/apply.ts`
- Create: `packages/bpmn/test/commands.test.ts`, `packages/bpmn/test/ids.test.ts`
- Modify: `packages/bpmn/src/index.ts`

**Interfaces:**
- Consumes: `DefinitionDocument` and the element document types (Task 1).
- Produces:
  - `type ElementKind = 'role' | 'state' | 'transition'`
  - `type Command` — the union in Step 3, including `rename`, `remove` and `setFragment` (implemented in Task 5)
  - `interface CommandError { code: CommandErrorCode; message: string; dependents?: string[] }`
  - `type CommandResult = { ok: true; document: DefinitionDocument } | { ok: false; error: CommandError }`
  - `applyCommand(document, command): CommandResult` — never mutates its input
  - `IDENTIFIER`, `RESERVED_TRANSITION`, `freshId(base, taken)`, `identifierFrom(title, taken, fallback?)`,
    `bumpVersion(version)`

- [ ] **Step 1: Write the failing tests**

`packages/bpmn/test/ids.test.ts`:

```ts
import { ProcessDefinition } from '@pilots/protocol'
import { describe, expect, it } from 'vitest'

import { IDENTIFIER, bumpVersion, freshId, identifierFrom } from '../src/commands/ids.js'
import { small } from './helpers/small.js'

describe('IDENTIFIER', () => {
  // This package may not import the protocol at runtime, so it mirrors the
  // pattern — and this test pins the mirror to the spec.
  it.each(['a', 'A1', 'a-b_c', '1a', '-a', 'a b', 'é', ''])('agrees with the protocol on %j', (id) => {
    const document = { ...small(), roles: [...small().roles, { id, title: 'X' }] }
    expect(IDENTIFIER.test(id)).toBe(ProcessDefinition.safeParse(document).success)
  })
})

describe('freshId', () => {
  it('returns the base when it is free, and numbers it when it is not', () => {
    expect(freshId('role', [])).toBe('role')
    expect(freshId('role', ['role', 'role2'])).toBe('role3')
  })
})

describe('identifierFrom', () => {
  it('turns a title into a camelCase identifier', () => {
    expect(identifierFrom('Make an offer', [])).toBe('makeAnOffer')
    expect(identifierFrom('Café crème', [])).toBe('cafeCreme')
  })

  it('falls back when the title has nothing usable, and avoids taken and reserved ids', () => {
    expect(identifierFrom('  42 ', [])).toBe('step')
    expect(identifierFrom('Finish', ['finish'])).toBe('finish2')
    expect(identifierFrom('Create', [])).toBe('createStep')
  })
})

describe('bumpVersion', () => {
  it('bumps the patch number, and leaves anything that is not x.y.z alone', () => {
    expect(bumpVersion('1.0.0')).toBe('1.0.1')
    expect(bumpVersion('2.3.9')).toBe('2.3.10')
    expect(bumpVersion('draft')).toBe('draft')
  })
})
```

`packages/bpmn/test/commands.test.ts`:

```ts
/**
 * Commands: every gesture in the editor is one of these, applied to the
 * definition. Two properties carry the design: a command never leaves a
 * dangling reference, and a command followed by its inverse gives back the same
 * bytes — which is what "lossless" means for an editor.
 */
import { canonicalise, lintDefinition, ProcessDefinition, type JsonValue } from '@pilots/protocol'
import { describe, expect, it } from 'vitest'

import { applyCommand } from '../src/commands/apply.js'
import type { Command } from '../src/commands/types.js'
import type { DefinitionDocument } from '../src/document.js'
import { examples } from './helpers/examples.js'
import { small } from './helpers/small.js'

function apply(document: DefinitionDocument, ...commands: Command[]): DefinitionDocument {
  return commands.reduce((current, command) => {
    const result = applyCommand(current, command)
    if (!result.ok) throw new Error(`${command.type}: ${result.error.message}`)
    return result.document
  }, document)
}

const refused = (document: DefinitionDocument, command: Command): string => {
  const result = applyCommand(document, command)
  if (result.ok) throw new Error(`${command.type} was accepted`)
  return result.error.code
}

const bytes = (document: DefinitionDocument): string => canonicalise(document as unknown as JsonValue)

describe('applyCommand', () => {
  it('never changes the document it is given', () => {
    const document = small()
    const before = bytes(document)
    apply(document, { type: 'addState', state: { id: 'NEW', title: 'New' } })
    expect(bytes(document)).toBe(before)
  })

  it('adds a role, a state and a transition', () => {
    const next = apply(
      small(),
      { type: 'addRole', role: { id: 'gamma', title: 'Gamma' } },
      { type: 'addState', state: { id: 'HELD', title: 'Held' } },
      { type: 'addTransition', transition: { id: 'hold', title: 'Hold', from: ['OPEN'], to: 'HELD', by: ['gamma'] } },
    )
    expect(next.roles.map((r) => r.id)).toEqual(['alpha', 'beta', 'gamma'])
    expect(next.transitions.at(-1)).toEqual({ id: 'hold', title: 'Hold', from: ['OPEN'], to: 'HELD', by: ['gamma'] })
  })

  it('refuses a duplicate, malformed or reserved id', () => {
    expect(refused(small(), { type: 'addRole', role: { id: 'alpha', title: 'Again' } })).toBe('duplicate-id')
    expect(refused(small(), { type: 'addState', state: { id: '1st', title: 'First' } })).toBe('invalid-id')
    expect(
      refused(small(), { type: 'addTransition', transition: { id: 'create', title: 'C', from: ['OPEN'], by: ['alpha'] } }),
    ).toBe('reserved-id')
  })

  it('refuses a transition that names a state or role nobody declared', () => {
    const base = { id: 'go', title: 'Go', from: ['OPEN'], by: ['alpha'] }
    expect(refused(small(), { type: 'addTransition', transition: { ...base, to: 'NOWHERE' } })).toBe('unknown-reference')
    expect(refused(small(), { type: 'addTransition', transition: { ...base, by: ['nobody'] } })).toBe('unknown-reference')
    expect(refused(small(), { type: 'updateTransition', id: 'finish', patch: { from: ['GHOST'] } })).toBe('unknown-reference')
  })

  it('removes a key when an update sets it to undefined, rather than writing undefined', () => {
    const next = apply(small(), { type: 'updateState', id: 'DONE', patch: { outcome: undefined } })
    expect('outcome' in next.states[1]!).toBe(false)
  })

  it('checks references in a process-level update', () => {
    expect(refused(small(), { type: 'setProcess', patch: { hostedBy: 'nobody' } })).toBe('unknown-reference')
    expect(refused(small(), { type: 'setProcess', patch: { initialState: 'NOWHERE' } })).toBe('unknown-reference')
    expect(apply(small(), { type: 'setProcess', patch: { hostedBy: 'alpha' } }).hostedBy).toBe('alpha')
  })

  it('moves a task to another lane by changing who fires it', () => {
    const next = apply(small(), { type: 'moveTask', transition: 'finish', fromRole: 'beta', toRole: 'alpha' })
    expect(next.transitions[0]!.by).toEqual(['alpha'])
    expect(refused(small(), { type: 'moveTask', transition: 'drop', fromRole: 'alpha', toRole: 'beta' })).toBe('not-allowed')
  })

  it('sets a deadline only on a transition that leads somewhere, and only to fire a real one', () => {
    const next = apply(small(), { type: 'setDeadline', transition: 'finish', deadline: 'PT1H', onDeadline: 'drop' })
    expect(next.transitions[0]).toMatchObject({ deadline: 'PT1H', onDeadline: 'drop' })
    const update = apply(small(), {
      type: 'addTransition',
      transition: { id: 'annotate', title: 'Annotate', from: ['OPEN'], by: ['alpha'] },
    })
    expect(refused(update, { type: 'setDeadline', transition: 'annotate', deadline: 'PT1H', onDeadline: 'drop' })).toBe('not-allowed')
    expect(refused(small(), { type: 'setDeadline', transition: 'finish', deadline: 'PT1H', onDeadline: 'ghost' })).toBe('unknown-reference')
  })

  it('adds a link only to a transition that exists', () => {
    expect(refused(small(), { type: 'addLink', link: { onEvent: 'quotation:AGREED', triggers: 'ghost' } })).toBe('unknown-reference')
    const next = apply(small(), { type: 'addLink', link: { onEvent: 'quotation:AGREED', triggers: 'finish' } })
    expect(next.links).toEqual([{ onEvent: 'quotation:AGREED', triggers: 'finish' }])
    expect(refused(next, { type: 'removeLink', index: 4 })).toBe('not-allowed')
  })

  it('produces a document the schema accepts and the linter passes, from structured commands alone', () => {
    const next = apply(
      small(),
      { type: 'addRole', role: { id: 'gamma', title: 'Gamma' } },
      { type: 'addState', state: { id: 'HELD', title: 'Held' } },
      { type: 'addTransition', transition: { id: 'hold', title: 'Hold', from: ['OPEN'], to: 'HELD', by: ['gamma'] } },
      { type: 'addTransition', transition: { id: 'release', title: 'Release', from: ['HELD'], to: 'DONE', by: ['beta'] } },
      { type: 'setDeadline', transition: 'hold', deadline: 'P2D', onDeadline: 'release' },
      { type: 'moveTask', transition: 'finish', fromRole: 'beta', toRole: 'gamma' },
      { type: 'addLink', link: { onEvent: 'quotation:AGREED', triggers: 'drop' } },
    )
    expect(ProcessDefinition.safeParse(next).success).toBe(true)
    expect(lintDefinition(next).diagnostics.filter((d) => d.severity === 'error')).toEqual([])
  })
})

describe.each(examples())('lossless on $name', ({ document }) => {
  const same = (...commands: Command[]): void => {
    expect(bytes(apply(document, ...commands))).toBe(bytes(document))
  }
  const first = document.transitions[0]!
  const firstState = document.states[0]!

  it('add, then remove, gives back the same bytes', () => {
    same({ type: 'addState', state: { id: 'ZZ_NEW', title: 'New' } }, { type: 'remove', kind: 'state', id: 'ZZ_NEW' })
    same({ type: 'addRole', role: { id: 'zzNew', title: 'New' } }, { type: 'remove', kind: 'role', id: 'zzNew' })
    same(
      { type: 'addTransition', transition: { id: 'zzNew', title: 'New', from: [firstState.id], by: [] } },
      { type: 'remove', kind: 'transition', id: 'zzNew' },
    )
    same({ type: 'addLink', link: { onEvent: 'quotation:AGREED', triggers: first.id } }, {
      type: 'removeLink',
      index: (document.links ?? []).length,
    })
  })

  it('an update, then its reverse, gives back the same bytes', () => {
    same(
      { type: 'updateState', id: firstState.id, patch: { title: 'Changed' } },
      { type: 'updateState', id: firstState.id, patch: { title: firstState.title } },
    )
    const role = first.by[0]
    const other = document.roles.find((one) => !first.by.includes(one.id))
    if (role !== undefined && other !== undefined) {
      same(
        { type: 'moveTask', transition: first.id, fromRole: role, toRole: other.id },
        { type: 'moveTask', transition: first.id, fromRole: other.id, toRole: role },
      )
    }
  })

  it('a deadline set and cleared on a transition that had none gives back the same bytes', () => {
    const plain = document.transitions.find((one) => one.deadline === undefined && one.to !== undefined)
    if (plain === undefined) return
    same(
      { type: 'setDeadline', transition: plain.id, deadline: 'PT1H', onDeadline: plain.id },
      { type: 'clearDeadline', transition: plain.id },
    )
  })
})
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `pnpm --filter @pilots/bpmn exec vitest run test/ids.test.ts test/commands.test.ts`
Expected: FAIL — `../src/commands/*.js` do not exist.

- [ ] **Step 3: Write the command types and id helpers**

`packages/bpmn/src/commands/types.ts`:

```ts
/**
 * Every edit the editor can make, as data.
 *
 * A patch key set to `undefined` removes that key. `rename` and `remove` cascade
 * through every reference so a draft never holds a dangling one; `setFragment`
 * is the Advanced tab's escape hatch and is judged by the linter, not here.
 */
import type { JsonValue } from '@pilots/protocol'

import type {
  DefinitionDocument,
  LinkDocument,
  RoleDocument,
  StateDocument,
  TransitionDocument,
} from '../document.js'

export type ElementKind = 'role' | 'state' | 'transition'

export type ProcessPatch = Partial<Omit<DefinitionDocument, 'roles' | 'states' | 'transitions' | 'links'>>

export type Command =
  | { type: 'setProcess'; patch: ProcessPatch }
  | { type: 'addRole'; role: RoleDocument }
  | { type: 'updateRole'; id: string; patch: Partial<Omit<RoleDocument, 'id'>> }
  | { type: 'addState'; state: StateDocument }
  | { type: 'updateState'; id: string; patch: Partial<Omit<StateDocument, 'id'>> }
  | { type: 'addTransition'; transition: TransitionDocument }
  | { type: 'updateTransition'; id: string; patch: Partial<Omit<TransitionDocument, 'id'>> }
  | { type: 'moveTask'; transition: string; fromRole: string; toRole: string }
  | { type: 'setDeadline'; transition: string; deadline: string; onDeadline: string }
  | { type: 'clearDeadline'; transition: string }
  | { type: 'addLink'; link: LinkDocument }
  | { type: 'removeLink'; index: number }
  | { type: 'rename'; kind: ElementKind; from: string; to: string }
  | { type: 'remove'; kind: ElementKind; id: string; cascade?: boolean }
  | { type: 'setFragment'; pointer: string; value: JsonValue | undefined }

export type CommandErrorCode =
  | 'invalid-id'
  | 'reserved-id'
  | 'duplicate-id'
  | 'unknown-reference'
  | 'has-dependents'
  | 'not-allowed'
  | 'invalid-pointer'

export interface CommandError {
  code: CommandErrorCode
  message: string
  /** For `has-dependents`: what still refers to the element, in words. */
  dependents?: string[]
}

export type CommandResult =
  | { ok: true; document: DefinitionDocument }
  | { ok: false; error: CommandError }
```

`packages/bpmn/src/commands/ids.ts`:

```ts
/**
 * Mirrors `Identifier` in packages/protocol. This package may not import the
 * protocol at runtime (it is drawn in a browser), so the pattern is repeated —
 * and `ids.test.ts` pins it to the spec so the two cannot drift.
 */
export const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_-]*$/

/** Event `seq` 1 is recorded under this id, so no transition may use it. */
export const RESERVED_TRANSITION = 'create'

export function freshId(base: string, taken: Iterable<string>): string {
  const used = new Set(taken)
  if (!used.has(base)) return base
  for (let n = 2; ; n++) {
    const candidate = `${base}${n}`
    if (!used.has(candidate)) return candidate
  }
}

/** A camelCase identifier from a title: "Make an offer" → `makeAnOffer`. */
export function identifierFrom(title: string, taken: Iterable<string>, fallback = 'step'): string {
  const words = title
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9 ]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((word) => word !== '')
  const camel = words
    .map((word, index) =>
      index === 0 ? word.toLowerCase() : `${word.charAt(0).toUpperCase()}${word.slice(1).toLowerCase()}`,
    )
    .join('')
  const base = IDENTIFIER.test(camel) ? camel : fallback
  return freshId(base === RESERVED_TRANSITION ? `${base}Step` : base, taken)
}

/** The next patch version, for "New version" and for a publish that met a conflict. */
export function bumpVersion(version: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  return match === null ? version : `${match[1]}.${match[2]}.${Number(match[3]) + 1}`
}
```

- [ ] **Step 4: Write the shared checks, the pointer helpers and the reference stubs**

`packages/bpmn/src/commands/checks.ts`:

```ts
import type { DefinitionDocument } from '../document.js'
import { IDENTIFIER, RESERVED_TRANSITION } from './ids.js'
import type { CommandError, CommandResult, ElementKind } from './types.js'

export const done = (document: DefinitionDocument): CommandResult => ({ ok: true, document })
export const fail = (error: CommandError): CommandResult => ({ ok: false, error })
export const unknown = (kind: string, id: string): CommandError => ({
  code: 'unknown-reference',
  message: `there is no ${kind} called ${id}`,
})

export function idsOf(document: DefinitionDocument, kind: ElementKind): string[] {
  switch (kind) {
    case 'role':
      return document.roles.map((one) => one.id)
    case 'state':
      return document.states.map((one) => one.id)
    case 'transition':
      return document.transitions.map((one) => one.id)
  }
}

export function checkNewId(document: DefinitionDocument, kind: ElementKind, id: string): CommandError | null {
  if (!IDENTIFIER.test(id)) {
    return { code: 'invalid-id', message: `${JSON.stringify(id)} is not an identifier: a letter, then letters, digits, - or _` }
  }
  if (kind === 'transition' && id === RESERVED_TRANSITION) {
    return { code: 'reserved-id', message: '`create` is reserved: it is the event that starts every instance' }
  }
  if (idsOf(document, kind).includes(id)) {
    return { code: 'duplicate-id', message: `there is already a ${kind} called ${id}` }
  }
  return null
}

/** Copy a patch onto an element. A key set to `undefined` is removed, never written. */
export function assign(target: object, patch: object): void {
  const record = target as Record<string, unknown>
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete record[key]
    else record[key] = structuredClone(value)
  }
}
```

`packages/bpmn/src/commands/pointer.ts`:

```ts
/** RFC 6901 JSON Pointers — how the linter names a place, and how the Advanced tab edits one. */
import type { JsonValue } from '@pilots/protocol'

import type { DefinitionDocument } from '../document.js'
import type { ElementRef } from '../model.js'
import { done, fail } from './checks.js'
import type { CommandResult } from './types.js'

export function parsePointer(pointer: string): string[] | null {
  if (pointer === '') return []
  if (!pointer.startsWith('/')) return null
  return pointer
    .slice(1)
    .split('/')
    .map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'))
}

function step(value: unknown, segment: string): unknown {
  if (Array.isArray(value)) return value[Number(segment)]
  if (value !== null && typeof value === 'object') return (value as Record<string, unknown>)[segment]
  return undefined
}

export function getPointer(document: unknown, pointer: string): unknown {
  const segments = parsePointer(pointer)
  if (segments === null) return undefined
  return segments.reduce(step, document)
}

/** Set (or, with `undefined`, remove) the value at a pointer. Mutates `document`: callers pass a clone. */
export function setPointer(
  document: DefinitionDocument,
  pointer: string,
  value: JsonValue | undefined,
): CommandResult {
  const invalid = fail({ code: 'invalid-pointer', message: `${pointer} does not point inside the document` })
  const segments = parsePointer(pointer)
  if (segments === null || segments.length === 0) return invalid
  const last = segments[segments.length - 1]!
  const parent = segments.slice(0, -1).reduce<unknown>(step, document)

  if (Array.isArray(parent)) {
    const index = last === '-' ? parent.length : Number(last)
    if (!Number.isInteger(index) || index < 0 || index > parent.length) return invalid
    if (value === undefined) parent.splice(index, 1)
    else parent[index] = structuredClone(value)
    return done(document)
  }
  if (parent !== null && typeof parent === 'object') {
    const record = parent as Record<string, unknown>
    if (value === undefined) delete record[last]
    else record[last] = structuredClone(value)
    return done(document)
  }
  return invalid
}

/** Where an element lives in the document — what the Advanced tab edits. */
export function pointerOf(document: DefinitionDocument, ref: ElementRef): string | null {
  switch (ref.kind) {
    case 'role': {
      const index = document.roles.findIndex((one) => one.id === ref.id)
      return index < 0 ? null : `/roles/${index}`
    }
    case 'state': {
      const index = document.states.findIndex((one) => one.id === ref.id)
      return index < 0 ? null : `/states/${index}`
    }
    case 'transition': {
      const index = document.transitions.findIndex((one) => one.id === ref.id)
      return index < 0 ? null : `/transitions/${index}`
    }
    case 'link':
      return ref.index < (document.links ?? []).length ? `/links/${ref.index}` : null
  }
}
```

`packages/bpmn/src/commands/references.ts` (stubs, completed in Task 5 — Task 4's tests only use
`remove` without dependents, which the stub supports):

```ts
import type { DefinitionDocument } from '../document.js'
import { done, fail, idsOf, unknown } from './checks.js'
import type { CommandResult, ElementKind } from './types.js'

export function renameElement(
  _document: DefinitionDocument,
  _kind: ElementKind,
  _from: string,
  _to: string,
): CommandResult {
  return fail({ code: 'not-allowed', message: 'rename is not implemented yet' })
}

export function removeElement(
  document: DefinitionDocument,
  kind: ElementKind,
  id: string,
  _cascade: boolean,
): CommandResult {
  if (!idsOf(document, kind).includes(id)) return fail(unknown(kind, id))
  switch (kind) {
    case 'role':
      document.roles = document.roles.filter((one) => one.id !== id)
      break
    case 'state':
      document.states = document.states.filter((one) => one.id !== id)
      break
    case 'transition':
      document.transitions = document.transitions.filter((one) => one.id !== id)
      break
  }
  return done(document)
}
```

- [ ] **Step 5: Write `applyCommand`**

`packages/bpmn/src/commands/apply.ts`:

```ts
/**
 * The one way the editor changes a definition.
 *
 * Commands guarantee **referential integrity** — no dangling reference, no
 * duplicate id, a well-formed id for anything new — and nothing more. Whether a
 * version string, a duration or a link's event is acceptable is the linter's
 * call: a second set of rules here would drift from the one that matters (B6).
 *
 * The input is never mutated: each command works on a clone, so undo is simply
 * keeping the previous document.
 */
import { ANY_STATE, type DefinitionDocument, type TransitionDocument } from '../document.js'
import { assign, checkNewId, done, fail, idsOf, unknown } from './checks.js'
import { setPointer } from './pointer.js'
import { removeElement, renameElement } from './references.js'
import type { Command, CommandError, CommandResult } from './types.js'

export function applyCommand(document: DefinitionDocument, command: Command): CommandResult {
  const next = structuredClone(document)
  switch (command.type) {
    case 'setProcess': {
      const { hostedBy, initialState, createdBy } = command.patch
      const roles = idsOf(next, 'role')
      if (hostedBy !== undefined && !roles.includes(hostedBy)) return fail(unknown('role', hostedBy))
      if (initialState !== undefined && !idsOf(next, 'state').includes(initialState)) {
        return fail(unknown('state', initialState))
      }
      const stranger = (createdBy ?? []).find((role) => !roles.includes(role))
      if (stranger !== undefined) return fail(unknown('role', stranger))
      assign(next, command.patch)
      return done(next)
    }

    case 'addRole': {
      const invalid = checkNewId(next, 'role', command.role.id)
      if (invalid) return fail(invalid)
      next.roles.push(structuredClone(command.role))
      return done(next)
    }
    case 'updateRole': {
      const role = next.roles.find((one) => one.id === command.id)
      if (role === undefined) return fail(unknown('role', command.id))
      assign(role, command.patch)
      return done(next)
    }

    case 'addState': {
      const invalid = checkNewId(next, 'state', command.state.id)
      if (invalid) return fail(invalid)
      next.states.push(structuredClone(command.state))
      return done(next)
    }
    case 'updateState': {
      const state = next.states.find((one) => one.id === command.id)
      if (state === undefined) return fail(unknown('state', command.id))
      assign(state, command.patch)
      return done(next)
    }

    case 'addTransition': {
      const invalid =
        checkNewId(next, 'transition', command.transition.id) ?? checkTransitionRefs(next, command.transition)
      if (invalid) return fail(invalid)
      next.transitions.push(structuredClone(command.transition))
      return done(next)
    }
    case 'updateTransition': {
      const transition = next.transitions.find((one) => one.id === command.id)
      if (transition === undefined) return fail(unknown('transition', command.id))
      const invalid = checkTransitionRefs(next, command.patch)
      if (invalid) return fail(invalid)
      assign(transition, command.patch)
      return done(next)
    }

    case 'moveTask': {
      const transition = next.transitions.find((one) => one.id === command.transition)
      if (transition === undefined) return fail(unknown('transition', command.transition))
      if (!transition.by.includes(command.fromRole)) {
        return fail({ code: 'not-allowed', message: `${command.fromRole} does not fire ${transition.id}` })
      }
      if (!idsOf(next, 'role').includes(command.toRole)) return fail(unknown('role', command.toRole))
      if (transition.by.includes(command.toRole)) {
        return fail({ code: 'not-allowed', message: `${command.toRole} already fires ${transition.id}` })
      }
      transition.by = transition.by.map((role) => (role === command.fromRole ? command.toRole : role))
      return done(next)
    }

    case 'setDeadline': {
      const transition = next.transitions.find((one) => one.id === command.transition)
      if (transition === undefined) return fail(unknown('transition', command.transition))
      if (transition.to === undefined) {
        return fail({
          code: 'not-allowed',
          message: `a deadline arms on entry into the state a transition leads to, and ${transition.id} leads nowhere`,
        })
      }
      if (!idsOf(next, 'transition').includes(command.onDeadline)) {
        return fail(unknown('transition', command.onDeadline))
      }
      transition.deadline = command.deadline
      transition.onDeadline = command.onDeadline
      return done(next)
    }
    case 'clearDeadline': {
      const transition = next.transitions.find((one) => one.id === command.transition)
      if (transition === undefined) return fail(unknown('transition', command.transition))
      delete transition.deadline
      delete transition.onDeadline
      return done(next)
    }

    case 'addLink': {
      if (!idsOf(next, 'transition').includes(command.link.triggers)) {
        return fail(unknown('transition', command.link.triggers))
      }
      next.links = [...(next.links ?? []), structuredClone(command.link)]
      return done(next)
    }
    case 'removeLink': {
      const links = next.links ?? []
      if (!Number.isInteger(command.index) || command.index < 0 || command.index >= links.length) {
        return fail({ code: 'not-allowed', message: `there is no link at position ${command.index}` })
      }
      next.links = links.filter((_, index) => index !== command.index)
      return done(next)
    }

    case 'rename':
      return renameElement(next, command.kind, command.from, command.to)
    case 'remove':
      return removeElement(next, command.kind, command.id, command.cascade ?? false)
    case 'setFragment':
      return setPointer(next, command.pointer, command.value)
  }
}

/** The references a transition (or part of one) makes must all exist. */
function checkTransitionRefs(
  document: DefinitionDocument,
  transition: Partial<TransitionDocument>,
): CommandError | null {
  const states = idsOf(document, 'state')
  const roles = idsOf(document, 'role')
  const stray = (transition.from ?? []).find((state) => state !== ANY_STATE && !states.includes(state))
  if (stray !== undefined) return unknown('state', stray)
  if (transition.to !== undefined && !states.includes(transition.to)) return unknown('state', transition.to)
  const stranger = (transition.by ?? []).find((role) => !roles.includes(role))
  if (stranger !== undefined) return unknown('role', stranger)
  if (transition.onDeadline !== undefined && !idsOf(document, 'transition').includes(transition.onDeadline)) {
    return unknown('transition', transition.onDeadline)
  }
  return null
}
```

In `packages/bpmn/src/index.ts`, add:

```ts
export { applyCommand } from './commands/apply.js'
export { IDENTIFIER, RESERVED_TRANSITION, bumpVersion, freshId, identifierFrom } from './commands/ids.js'
export { getPointer, parsePointer, pointerOf } from './commands/pointer.js'
export type {
  Command,
  CommandError,
  CommandErrorCode,
  CommandResult,
  ElementKind,
  ProcessPatch,
} from './commands/types.js'
```

- [ ] **Step 6: Run the tests to see them pass**

Run: `pnpm --filter @pilots/bpmn exec vitest run`
Expected: PASS. (The lossless suite's `remove` calls succeed because the added elements have no
dependents.)

- [ ] **Step 7: Verify**

```bash
pnpm typecheck && pnpm lint && pnpm test
```

Stop and tell the supervisor the task is ready to review and commit.

---

### Task 5: Rename and remove, cascading; the Advanced edit

**Files:**
- Modify: `packages/bpmn/src/commands/references.ts` (replace the stubs)
- Modify: `packages/bpmn/src/index.ts`
- Create: `packages/bpmn/test/references.test.ts`, `packages/bpmn/test/pointer.test.ts`

**Interfaces:**
- Consumes: `checks.ts` helpers, `applyCommand` (Task 4).
- Produces: `dependentsOf(document, kind, id): string[]`; `renameElement`, `removeElement` with full
  cascade semantics; `setFragment` exercised.

- [ ] **Step 1: Write the failing tests**

`packages/bpmn/test/references.test.ts`:

```ts
/**
 * Renaming by hand in JSON is exactly where a definition breaks: one `from`
 * forgotten and the linter is the first to notice. A rename here follows every
 * reference; a removal either refuses and says what still depends on it, or —
 * when asked — removes those too, never leaving a dangling reference and never
 * widening who may read what.
 */
import { canonicalise, type JsonValue } from '@pilots/protocol'
import { describe, expect, it } from 'vitest'

import { applyCommand } from '../src/commands/apply.js'
import type { Command } from '../src/commands/types.js'
import type { DefinitionDocument } from '../src/document.js'
import { examples } from './helpers/examples.js'
import { small } from './helpers/small.js'

function apply(document: DefinitionDocument, command: Command): DefinitionDocument {
  const result = applyCommand(document, command)
  if (!result.ok) throw new Error(result.error.message)
  return result.document
}

/** small(), with a reference of every kind to rename through. */
function rich(): DefinitionDocument {
  const document = small()
  document.createdBy = ['alpha']
  document.states.push({ id: 'WAITING', title: 'Waiting' })
  document.transitions.push(
    { id: 'wait', title: 'Wait', from: ['OPEN'], to: 'WAITING', by: ['alpha'], deadline: 'PT1H', onDeadline: 'lapse' },
    { id: 'lapse', title: 'Lapse', from: ['WAITING'], to: 'DROPPED', by: [] },
    { id: 'resume', title: 'Resume', from: ['WAITING', 'OPEN'], to: 'DONE', by: ['beta'] },
  )
  document.visibility = [
    { path: 'note', roles: ['alpha'], whenState: ['WAITING'] },
    { path: 'note', roles: ['alpha', 'beta'] },
  ]
  document.links = [{ onEvent: 'quotation:AGREED', triggers: 'lapse' }]
  return document
}

describe('rename', () => {
  it('follows a role through hostedBy, createdBy, by and visibility', () => {
    const next = apply(rich(), { type: 'rename', kind: 'role', from: 'alpha', to: 'gamma' })
    const text = JSON.stringify(next)
    expect(text).not.toContain('"alpha"')
    expect(next.createdBy).toEqual(['gamma'])
    expect(next.transitions.find((t) => t.id === 'wait')?.by).toEqual(['gamma'])
    expect(next.visibility?.[1]?.roles).toEqual(['gamma', 'beta'])
  })

  it('follows a state through initialState, from, to and whenState — but not a linked instance’s event', () => {
    const renamed = apply(rich(), { type: 'rename', kind: 'state', from: 'WAITING', to: 'PAUSED' })
    expect(renamed.transitions.find((t) => t.id === 'resume')?.from).toEqual(['PAUSED', 'OPEN'])
    expect(renamed.visibility?.[0]?.whenState).toEqual(['PAUSED'])
    const initial = apply(rich(), { type: 'rename', kind: 'state', from: 'OPEN', to: 'READY' })
    expect(initial.initialState).toBe('READY')
    // `onEvent` names a state of *another* definition; it is not ours to rename.
    expect(apply(rich(), { type: 'rename', kind: 'state', from: 'DONE', to: 'AGREED' }).links?.[0]?.onEvent).toBe(
      'quotation:AGREED',
    )
  })

  it('follows a transition through onDeadline and links', () => {
    const next = apply(rich(), { type: 'rename', kind: 'transition', from: 'lapse', to: 'expire' })
    expect(next.transitions.find((t) => t.id === 'wait')?.onDeadline).toBe('expire')
    expect(next.links?.[0]?.triggers).toBe('expire')
  })

  it('refuses a name already taken or malformed, and accepts the same name as a no-op', () => {
    expect(applyCommand(rich(), { type: 'rename', kind: 'role', from: 'alpha', to: 'beta' }).ok).toBe(false)
    expect(applyCommand(rich(), { type: 'rename', kind: 'state', from: 'OPEN', to: '9' }).ok).toBe(false)
    expect(applyCommand(rich(), { type: 'rename', kind: 'state', from: 'OPEN', to: 'OPEN' }).ok).toBe(true)
  })

  it.each(examples())('renamed and renamed back, $name is byte-identical', ({ document }) => {
    const bytes = (d: DefinitionDocument): string => canonicalise(d as unknown as JsonValue)
    for (const [kind, id] of [
      ['role', document.roles[0]!.id],
      ['state', document.states[0]!.id],
      ['transition', document.transitions[0]!.id],
    ] as const) {
      const there = apply(document, { type: 'rename', kind, from: id, to: 'zzRenamed' })
      expect(bytes(apply(there, { type: 'rename', kind, from: 'zzRenamed', to: id }))).toBe(bytes(document))
    }
  })
})

describe('remove', () => {
  it('refuses while something depends on the element, and says what', () => {
    const result = applyCommand(rich(), { type: 'remove', kind: 'transition', id: 'lapse' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('has-dependents')
    expect(result.error.dependents).toEqual(['deadline of wait', 'link quotation:AGREED'])
  })

  it('never removes the host or the initial state, even when asked to cascade', () => {
    expect(applyCommand(rich(), { type: 'remove', kind: 'role', id: 'beta', cascade: true }).ok).toBe(false)
    expect(applyCommand(rich(), { type: 'remove', kind: 'state', id: 'OPEN', cascade: true }).ok).toBe(false)
  })

  it('cascades a transition: deadlines that fired it are cleared, links to it are removed', () => {
    const next = apply(rich(), { type: 'remove', kind: 'transition', id: 'lapse', cascade: true })
    const wait = next.transitions.find((t) => t.id === 'wait')!
    expect('deadline' in wait || 'onDeadline' in wait).toBe(false)
    expect(next.links).toEqual([])
  })

  it('cascades a role: out of every by, createdBy and grant — dropping a grant left with nobody', () => {
    const next = apply(rich(), { type: 'remove', kind: 'role', id: 'alpha', cascade: true })
    expect(next.transitions.find((t) => t.id === 'wait')?.by).toEqual([])
    expect('createdBy' in next).toBe(false)
    expect(next.visibility).toEqual([{ path: 'note', roles: ['beta'] }])
  })

  it('cascades a state: transitions that only lived there go, others lose it from `from`, and a grant is never widened', () => {
    const next = apply(rich(), { type: 'remove', kind: 'state', id: 'WAITING', cascade: true })
    expect(next.transitions.map((t) => t.id)).toEqual(['finish', 'drop', 'resume'])
    expect(next.transitions.find((t) => t.id === 'resume')?.from).toEqual(['OPEN'])
    // The grant that applied only in WAITING is gone, not turned into "always".
    expect(next.visibility).toEqual([{ path: 'note', roles: ['alpha', 'beta'] }])
  })

  it('refuses to leave a process with no transition at all', () => {
    const lonely = small()
    lonely.transitions = [lonely.transitions[0]!]
    expect(applyCommand(lonely, { type: 'remove', kind: 'transition', id: 'finish' }).ok).toBe(false)
  })
})
```

`packages/bpmn/test/pointer.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { applyCommand } from '../src/commands/apply.js'
import { getPointer, pointerOf } from '../src/commands/pointer.js'
import { small } from './helpers/small.js'

describe('setFragment', () => {
  it('sets, replaces and removes a value by JSON Pointer', () => {
    const set = applyCommand(small(), {
      type: 'setFragment',
      pointer: '/data/properties/note/maxLength',
      value: 10,
    })
    expect(set.ok && getPointer(set.document, '/data/properties/note/maxLength')).toBe(10)
    const removed = applyCommand(small(), { type: 'setFragment', pointer: '/transitions/1', value: undefined })
    expect(removed.ok && removed.document.transitions.map((t) => t.id)).toEqual(['finish'])
  })

  it('refuses a pointer that leads nowhere, and the root itself', () => {
    expect(applyCommand(small(), { type: 'setFragment', pointer: '/nope/deeper', value: 1 }).ok).toBe(false)
    expect(applyCommand(small(), { type: 'setFragment', pointer: '', value: 1 }).ok).toBe(false)
    expect(applyCommand(small(), { type: 'setFragment', pointer: 'data', value: 1 }).ok).toBe(false)
  })
})

describe('pointerOf', () => {
  it('names where an element lives', () => {
    expect(pointerOf(small(), { kind: 'state', id: 'DONE' })).toBe('/states/1')
    expect(pointerOf(small(), { kind: 'transition', id: 'drop' })).toBe('/transitions/1')
    expect(pointerOf(small(), { kind: 'role', id: 'nobody' })).toBeNull()
  })
})
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `pnpm --filter @pilots/bpmn exec vitest run test/references.test.ts test/pointer.test.ts`
Expected: FAIL — rename returns "not implemented yet"; removals do not cascade or refuse.

- [ ] **Step 3: Implement**

Replace `packages/bpmn/src/commands/references.ts` with:

```ts
/**
 * Who still refers to what — and what a rename or a removal has to follow.
 *
 * `links[].onEvent` is deliberately never touched: it names a state or a
 * transition of the *linked* definition, not of this one.
 */
import type { DefinitionDocument } from '../document.js'
import { checkNewId, done, fail, idsOf, unknown } from './checks.js'
import type { CommandResult, ElementKind } from './types.js'

export function dependentsOf(document: DefinitionDocument, kind: ElementKind, id: string): string[] {
  const out: string[] = []
  switch (kind) {
    case 'role':
      if (document.hostedBy === id) out.push('hostedBy')
      if (document.createdBy?.includes(id) === true) out.push('createdBy')
      for (const t of document.transitions) if (t.by.includes(id)) out.push(`transition ${t.id} (by)`)
      for (const g of document.visibility ?? []) if (g.roles.includes(id)) out.push(`visibility of ${g.path}`)
      break
    case 'state':
      if (document.initialState === id) out.push('initialState')
      for (const t of document.transitions) {
        if (t.from.includes(id)) out.push(`transition ${t.id} (from)`)
        if (t.to === id) out.push(`transition ${t.id} (to)`)
      }
      for (const g of document.visibility ?? []) {
        if (g.whenState?.includes(id) === true) out.push(`visibility of ${g.path}`)
      }
      break
    case 'transition':
      for (const t of document.transitions) if (t.onDeadline === id) out.push(`deadline of ${t.id}`)
      for (const l of document.links ?? []) if (l.triggers === id) out.push(`link ${l.onEvent}`)
      break
  }
  return out
}

/** Mutates `document` (a clone, from `applyCommand`). */
export function renameElement(
  document: DefinitionDocument,
  kind: ElementKind,
  from: string,
  to: string,
): CommandResult {
  if (!idsOf(document, kind).includes(from)) return fail(unknown(kind, from))
  if (from === to) return done(document)
  const invalid = checkNewId(document, kind, to)
  if (invalid) return fail(invalid)
  const swap = (value: string): string => (value === from ? to : value)

  switch (kind) {
    case 'role':
      for (const role of document.roles) role.id = swap(role.id)
      document.hostedBy = swap(document.hostedBy)
      if (document.createdBy !== undefined) document.createdBy = document.createdBy.map(swap)
      for (const t of document.transitions) t.by = t.by.map(swap)
      for (const g of document.visibility ?? []) g.roles = g.roles.map(swap)
      break
    case 'state':
      for (const state of document.states) state.id = swap(state.id)
      document.initialState = swap(document.initialState)
      for (const t of document.transitions) {
        t.from = t.from.map(swap)
        if (t.to !== undefined) t.to = swap(t.to)
      }
      for (const g of document.visibility ?? []) {
        if (g.whenState !== undefined) g.whenState = g.whenState.map(swap)
      }
      break
    case 'transition':
      for (const t of document.transitions) {
        t.id = swap(t.id)
        if (t.onDeadline !== undefined) t.onDeadline = swap(t.onDeadline)
      }
      for (const l of document.links ?? []) l.triggers = swap(l.triggers)
      break
  }
  return done(document)
}

/** Mutates `document` (a clone, from `applyCommand`). */
export function removeElement(
  document: DefinitionDocument,
  kind: ElementKind,
  id: string,
  cascade: boolean,
): CommandResult {
  if (!idsOf(document, kind).includes(id)) return fail(unknown(kind, id))
  if (kind === 'role' && document.hostedBy === id) {
    return fail({ code: 'not-allowed', message: `${id} hosts this process; choose another host before removing it` })
  }
  if (kind === 'state' && document.initialState === id) {
    return fail({
      code: 'not-allowed',
      message: `${id} is where the process starts; choose another initial state before removing it`,
    })
  }
  const dependents = dependentsOf(document, kind, id)
  if (dependents.length > 0 && !cascade) {
    return fail({ code: 'has-dependents', message: `${id} is still used in ${dependents.length} place(s)`, dependents })
  }

  switch (kind) {
    case 'role':
      removeRole(document, id)
      break
    case 'state':
      removeState(document, id)
      break
    case 'transition':
      removeTransition(document, id)
      break
  }
  if (document.transitions.length === 0) {
    return fail({ code: 'not-allowed', message: 'a process needs at least one transition' })
  }
  return done(document)
}

function removeRole(document: DefinitionDocument, id: string): void {
  document.roles = document.roles.filter((one) => one.id !== id)
  for (const t of document.transitions) t.by = t.by.filter((role) => role !== id)
  if (document.createdBy !== undefined) {
    const left = document.createdBy.filter((role) => role !== id)
    if (left.length === 0) delete document.createdBy
    else document.createdBy = left
  }
  if (document.visibility !== undefined) {
    document.visibility = document.visibility.flatMap((grant) => {
      if (!grant.roles.includes(id)) return [grant]
      const roles = grant.roles.filter((role) => role !== id)
      return roles.length === 0 ? [] : [{ ...grant, roles }]
    })
  }
}

function removeState(document: DefinitionDocument, id: string): void {
  document.states = document.states.filter((one) => one.id !== id)
  const doomed: string[] = []
  for (const t of document.transitions) {
    if (t.to === id) {
      doomed.push(t.id)
      continue
    }
    if (!t.from.includes(id)) continue
    const from = t.from.filter((state) => state !== id)
    if (from.length === 0) doomed.push(t.id)
    else t.from = from
  }
  for (const transition of doomed) removeTransition(document, transition)
  if (document.visibility !== undefined) {
    document.visibility = document.visibility.flatMap((grant) => {
      if (grant.whenState?.includes(id) !== true) return [grant]
      const whenState = grant.whenState.filter((state) => state !== id)
      // Never widen a grant: one that applied only in this state goes with it,
      // rather than losing its condition and applying always.
      return whenState.length === 0 ? [] : [{ ...grant, whenState }]
    })
  }
}

function removeTransition(document: DefinitionDocument, id: string): void {
  document.transitions = document.transitions.filter((one) => one.id !== id)
  for (const t of document.transitions) {
    if (t.onDeadline !== id) continue
    delete t.deadline
    delete t.onDeadline
  }
  if (document.links !== undefined) document.links = document.links.filter((link) => link.triggers !== id)
}
```

In `packages/bpmn/src/index.ts`, add:

```ts
export { dependentsOf } from './commands/references.js'
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `pnpm --filter @pilots/bpmn exec vitest run`
Expected: PASS — including Task 4's lossless suite, now running against the real `remove`.

- [ ] **Step 5: Verify**

```bash
pnpm typecheck && pnpm lint && pnpm test
```

Stop and tell the supervisor the task is ready to review and commit.

---

### Task 6: Forms — the field builder

**Files:**
- Create: `packages/bpmn/src/forms/fields.ts`, `packages/bpmn/test/fields.test.ts`
- Modify: `packages/bpmn/src/index.ts`

**Interfaces:**
- Produces: `type FieldType = 'text' | 'number' | 'datetime' | 'choice' | 'boolean' | 'group'`;
  `interface FieldView { name; required; type: FieldType | null; options: string[]; fields: FieldView[] }`
  (`type: null` = shown read-only, *edited in JSON*); `classify(schema): FieldType | null`;
  `readFields(schema): FieldView[]`; `schemaFor(type, options?)`;
  `setField(root, path: string[], edit: { type: FieldType; options?: string[]; required: boolean }): FieldResult`;
  `removeField(root, path): FieldResult`;
  `type FieldResult = { ok: true; schema: Record<string, unknown> } | { ok: false; message: string }`;
  internal helpers `isRecord`, `isStrings` exported for Task 7.

- [ ] **Step 1: Write the failing tests**

`packages/bpmn/test/fields.test.ts`:

```ts
/**
 * The field builder: a business user's view of the `data` schema.
 *
 * It must never drop what it cannot show — a `pattern`, a `minimum` — so such a
 * field is classified `null` and shown read-only, and every write leaves the
 * rest of the schema exactly as it was.
 */
import { describe, expect, it } from 'vitest'

import { classify, readFields, removeField, setField } from '../src/forms/fields.js'
import { example } from './helpers/examples.js'

describe('classify', () => {
  it.each([
    [{ type: 'string' }, 'text'],
    [{ type: 'number' }, 'number'],
    [{ type: 'string', format: 'date-time' }, 'datetime'],
    [{ type: 'string', enum: ['a', 'b'] }, 'choice'],
    [{ type: 'boolean' }, 'boolean'],
    [{ type: 'object', properties: {}, required: [] }, 'group'],
  ])('recognises %j as %s', (schema, type) => {
    expect(classify(schema)).toBe(type)
  })

  it.each([
    { type: 'string', pattern: '^[A-Z]+$' },
    { type: 'number', minimum: 0 },
    { type: 'string', format: 'email' },
    { type: 'array' },
    { type: 'object', additionalProperties: false },
  ])('leaves %j to the JSON tab', (schema) => {
    expect(classify(schema)).toBeNull()
  })
})

describe('readFields on a committed definition', () => {
  const fields = readFields(example('container-transport-quotation').data)

  it('shows a group the form can edit in full', () => {
    const pickup = fields.find((field) => field.name === 'pickup')!
    expect(pickup).toMatchObject({ type: 'group', required: true })
    expect(pickup.fields.map((f) => [f.name, f.type])).toEqual([
      ['location', 'text'],
      ['earliest', 'datetime'],
      ['latest', 'datetime'],
    ])
  })

  it('flags what it cannot show rather than guessing', () => {
    expect(fields.find((field) => field.name === 'containerNumber')?.type).toBeNull()
    const price = fields.find((field) => field.name === 'price')!
    expect(price.fields.find((f) => f.name === 'value')?.type).toBeNull()
  })
})

describe('setField and removeField', () => {
  const root = {
    type: 'object',
    additionalProperties: false,
    required: ['a'],
    properties: {
      a: { type: 'string' },
      code: { type: 'string', pattern: '^X' },
      group: { type: 'object', properties: { inner: { type: 'number' } } },
    },
  }

  it('adds a field and its required flag without touching anything else', () => {
    const result = setField(root, ['b'], { type: 'choice', options: ['x', 'y'], required: true })
    expect(result.ok && result.schema).toEqual({
      ...root,
      required: ['a', 'b'],
      properties: { ...root.properties, b: { type: 'string', enum: ['x', 'y'] } },
    })
  })

  it('changes a field’s type, and drops `required` once nothing is left in it', () => {
    const result = setField(root, ['a'], { type: 'number', required: false })
    expect(result.ok && result.schema['required']).toBeUndefined()
    expect(result.ok && (result.schema['properties'] as Record<string, unknown>)['a']).toEqual({ type: 'number' })
  })

  it('edits inside a group, and keeps a group’s children when only its flag changes', () => {
    const inner = setField(root, ['group', 'more'], { type: 'boolean', required: false })
    expect(inner.ok && JSON.stringify(inner.schema)).toContain('"more":{"type":"boolean"}')
    const flag = setField(root, ['group'], { type: 'group', required: true })
    expect(flag.ok && JSON.stringify(flag.schema)).toContain('"inner":{"type":"number"}')
  })

  it('refuses to overwrite what it cannot show', () => {
    expect(setField(root, ['code'], { type: 'text', required: false }).ok).toBe(false)
  })

  it('removes a field and its required flag', () => {
    const result = removeField(root, ['a'])
    expect(result.ok && result.schema['required']).toBeUndefined()
    expect(result.ok && Object.keys(result.schema['properties'] as object)).toEqual(['code', 'group'])
  })
})
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `pnpm --filter @pilots/bpmn exec vitest run test/fields.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

`packages/bpmn/src/forms/fields.ts`:

```ts
/**
 * The field builder — the `data` schema, as a business user edits it.
 *
 * Six kinds of field and nothing else. Anything richer is classified `null`:
 * the form shows it read-only, marked *edited in JSON*, and every write here
 * replaces only the one field it names, so what the form cannot express is
 * never dropped on the way through.
 */
export type FieldType = 'text' | 'number' | 'datetime' | 'choice' | 'boolean' | 'group'

export interface FieldView {
  name: string
  required: boolean
  /** `null` when the form cannot show this field faithfully. */
  type: FieldType | null
  options: string[]
  fields: FieldView[]
}

export interface FieldEdit {
  type: FieldType
  options?: string[]
  required: boolean
}

export type FieldResult = { ok: true; schema: Record<string, unknown> } | { ok: false; message: string }

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
export const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((one) => typeof one === 'string')

const ALLOWED: Record<FieldType, readonly string[]> = {
  text: ['type'],
  number: ['type'],
  datetime: ['type', 'format'],
  choice: ['type', 'enum'],
  boolean: ['type'],
  group: ['type', 'properties', 'required'],
}

export function classify(schema: unknown): FieldType | null {
  if (!isRecord(schema)) return null
  const fits = (type: FieldType): boolean => Object.keys(schema).every((key) => ALLOWED[type].includes(key))
  switch (schema['type']) {
    case 'string':
      if (schema['format'] === 'date-time') return fits('datetime') ? 'datetime' : null
      if (schema['enum'] !== undefined) return isStrings(schema['enum']) && fits('choice') ? 'choice' : null
      return fits('text') ? 'text' : null
    case 'number':
      return fits('number') ? 'number' : null
    case 'boolean':
      return fits('boolean') ? 'boolean' : null
    case 'object':
      return fits('group') &&
        (schema['properties'] === undefined || isRecord(schema['properties'])) &&
        (schema['required'] === undefined || isStrings(schema['required']))
        ? 'group'
        : null
    default:
      return null
  }
}

export function readFields(schema: unknown): FieldView[] {
  if (!isRecord(schema) || !isRecord(schema['properties'])) return []
  const required = isStrings(schema['required']) ? schema['required'] : []
  return Object.entries(schema['properties']).map(([name, child]) => {
    const type = classify(child)
    return {
      name,
      required: required.includes(name),
      type,
      options: type === 'choice' && isRecord(child) && isStrings(child['enum']) ? child['enum'] : [],
      fields: type === 'group' ? readFields(child) : [],
    }
  })
}

export function schemaFor(type: FieldType, options: string[] = []): Record<string, unknown> {
  switch (type) {
    case 'text':
      return { type: 'string' }
    case 'number':
      return { type: 'number' }
    case 'datetime':
      return { type: 'string', format: 'date-time' }
    case 'choice':
      return { type: 'string', enum: [...options] }
    case 'boolean':
      return { type: 'boolean' }
    case 'group':
      return { type: 'object', properties: {} }
  }
}

/** Set one field at `path` — group names, then the field's own. The root is never replaced. */
export function setField(root: unknown, path: string[], edit: FieldEdit): FieldResult {
  const next = structuredClone(isRecord(root) ? root : { type: 'object' })
  const name = path[path.length - 1]
  if (name === undefined || name.trim() === '') return { ok: false, message: 'a field needs a name' }
  const parent = groupAt(next, path.slice(0, -1))
  if (parent === null) return { ok: false, message: `there is no group at ${path.slice(0, -1).join('.')}` }
  if (!isRecord(parent['properties'])) parent['properties'] = {}
  const properties = parent['properties'] as Record<string, unknown>

  const existing = properties[name]
  if (existing !== undefined && classify(existing) === null) {
    return { ok: false, message: `${path.join('.')} uses JSON Schema this form cannot show; change it in the JSON tab` }
  }
  const keepGroup = edit.type === 'group' && classify(existing) === 'group'
  properties[name] = keepGroup ? existing : schemaFor(edit.type, edit.options)
  setRequired(parent, name, edit.required)
  return { ok: true, schema: next }
}

export function removeField(root: unknown, path: string[]): FieldResult {
  const next = structuredClone(isRecord(root) ? root : { type: 'object' })
  const name = path[path.length - 1]
  const parent = groupAt(next, path.slice(0, -1))
  if (name === undefined || parent === null || !isRecord(parent['properties'])) {
    return { ok: false, message: `there is no field at ${path.join('.')}` }
  }
  delete parent['properties'][name]
  setRequired(parent, name, false)
  return { ok: true, schema: next }
}

function groupAt(root: Record<string, unknown>, path: string[]): Record<string, unknown> | null {
  let current = root
  for (const name of path) {
    const properties = current['properties']
    const child = isRecord(properties) ? properties[name] : undefined
    if (!isRecord(child) || classify(child) !== 'group') return null
    current = child
  }
  return current
}

function setRequired(parent: Record<string, unknown>, name: string, required: boolean): void {
  const list = isStrings(parent['required']) ? parent['required'] : []
  const has = list.includes(name)
  if (required && !has) parent['required'] = [...list, name]
  if (!required && has) {
    const left = list.filter((one) => one !== name)
    if (left.length === 0) delete parent['required']
    else parent['required'] = left
  }
}
```

In `packages/bpmn/src/index.ts`, add:

```ts
export {
  classify,
  readFields,
  removeField,
  schemaFor,
  setField,
  type FieldEdit,
  type FieldResult,
  type FieldType,
  type FieldView,
} from './forms/fields.js'
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `pnpm --filter @pilots/bpmn exec vitest run`
Expected: PASS.

- [ ] **Step 5: Verify**

```bash
pnpm typecheck && pnpm lint && pnpm test
```

Stop and tell the supervisor the task is ready to review and commit.

---

### Task 7: Forms — what a task fills in, and who may read what

**Files:**
- Create: `packages/bpmn/src/forms/task-fields.ts`, `packages/bpmn/src/forms/visibility.ts`
- Create: `packages/bpmn/test/task-fields.test.ts`, `packages/bpmn/test/visibility.test.ts`
- Modify: `packages/bpmn/src/index.ts`

**Interfaces:**
- Consumes: `isRecord`, `isStrings`, `readFields` (Task 6); `TransitionDocument`, `VisibilityDocument` (Task 1).
- Produces: `interface TaskFields { fills: { name: string; required: boolean }[]; requires: string[] }`;
  `interface TaskFieldsView extends TaskFields { advanced: boolean }`;
  `readTaskFields(transition): TaskFieldsView`;
  `writeTaskFields(transition, data, fields): Partial<TransitionDocument> | null` (a patch for
  `updateTransition`; `null` when advanced);
  `type Access = { kind: 'default' } | { kind: 'always' } | { kind: 'states'; states: string[] }`;
  `readAccess(visibility, path, role): Access`; `writeAccess(visibility, path, role, access): VisibilityDocument[]`;
  `visibilityPaths(data, visibility): string[]`.

- [ ] **Step 1: Write the failing tests**

`packages/bpmn/test/task-fields.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import type { TransitionDocument } from '../src/document.js'
import { readTaskFields, writeTaskFields } from '../src/forms/task-fields.js'
import { example } from './helpers/examples.js'

const quotation = example('container-transport-quotation')
const offer = quotation.transitions.find((t) => t.id === 'offer')!

describe('readTaskFields', () => {
  it('reads what a step fills in and what must already be there', () => {
    const view = readTaskFields(offer)
    expect(view.fills.map((f) => f.name)).toEqual(['price', 'pickup', 'dropoff', 'terms', 'notes'])
    expect(view.fills.find((f) => f.name === 'price')?.required).toBe(true)
    expect(view.requires).toEqual(['price'])
    expect(view.advanced).toBe(false)
  })

  it('calls a guard it cannot express advanced, rather than ignoring it', () => {
    const odd: TransitionDocument = { ...offer, guards: [{ properties: { price: { minimum: 1 } } }] }
    expect(readTaskFields(odd).advanced).toBe(true)
    expect(writeTaskFields(odd, quotation.data, { fills: [], requires: [] })).toBeNull()
  })
})

describe('writeTaskFields', () => {
  const plain: TransitionDocument = { id: 'go', title: 'Go', from: ['A'], to: 'B', by: ['alpha'] }
  const data = { type: 'object', properties: { note: { type: 'string', maxLength: 5 }, size: { type: 'number' } } }

  it('builds the patch from the data schema, and a guard from what must be present', () => {
    const patch = writeTaskFields(plain, data, { fills: [{ name: 'note', required: true }], requires: ['size'] })
    expect(patch).toEqual({
      patch: { type: 'object', required: ['note'], properties: { note: { type: 'string', maxLength: 5 } } },
      guards: [{ required: ['size'] }],
    })
  })

  it('keeps the schema a step already had for a field, rather than copying it again', () => {
    const counter = quotation.transitions.find((t) => t.id === 'counter')!
    const patch = writeTaskFields(counter, quotation.data, {
      fills: readTaskFields(counter).fills,
      requires: [],
    })
    expect((patch?.patch as { properties: Record<string, unknown> }).properties['price']).toEqual({ type: 'object' })
  })

  it('removes patch and guards when the step fills and requires nothing', () => {
    expect(writeTaskFields(offer, quotation.data, { fills: [], requires: [] })).toEqual({
      patch: undefined,
      guards: undefined,
    })
  })
})
```

`packages/bpmn/test/visibility.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import type { VisibilityDocument } from '../src/document.js'
import { readAccess, visibilityPaths, writeAccess } from '../src/forms/visibility.js'

const grants: VisibilityDocument[] = [
  { path: 'mass', roles: ['beta'] },
  { path: 'mass', roles: ['alpha'], whenState: ['PAID', 'DONE'] },
  { path: 'name', roles: ['alpha', 'beta'] },
]

describe('readAccess', () => {
  it('reads always, only in some states, and the default', () => {
    expect(readAccess(grants, 'mass', 'beta')).toEqual({ kind: 'always' })
    expect(readAccess(grants, 'mass', 'alpha')).toEqual({ kind: 'states', states: ['PAID', 'DONE'] })
    expect(readAccess(grants, 'mass', 'gamma')).toEqual({ kind: 'default' })
  })

  it('treats any unconditional grant as always — any matching grant is enough', () => {
    const both = [...grants, { path: 'mass', roles: ['alpha'] }]
    expect(readAccess(both, 'mass', 'alpha')).toEqual({ kind: 'always' })
  })
})

describe('writeAccess', () => {
  it('takes one role out of a shared grant without touching the others', () => {
    const next = writeAccess(grants, 'name', 'alpha', { kind: 'default' })
    expect(next).toContainEqual({ path: 'name', roles: ['beta'] })
    expect(readAccess(next, 'name', 'alpha')).toEqual({ kind: 'default' })
  })

  it('writes a state-restricted grant, replacing the role’s old ones for that field', () => {
    const next = writeAccess(grants, 'mass', 'beta', { kind: 'states', states: ['DONE'] })
    expect(next.filter((g) => g.path === 'mass' && g.roles.includes('beta'))).toEqual([
      { path: 'mass', roles: ['beta'], whenState: ['DONE'] },
    ])
  })
})

describe('visibilityPaths', () => {
  it('lists the data fields and any path a grant already names', () => {
    const data = { type: 'object', properties: { name: { type: 'string' }, size: { type: 'number' } } }
    expect(visibilityPaths(data, grants)).toEqual(['name', 'size', 'mass'])
  })
})
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `pnpm --filter @pilots/bpmn exec vitest run test/task-fields.test.ts test/visibility.test.ts`
Expected: FAIL — modules missing.

- [ ] **Step 3: Implement**

`packages/bpmn/src/forms/task-fields.ts`:

```ts
/**
 * Per task, two lists: what this step fills in (`patch`) and what must already
 * be present (`guards`). That is all the form shows; a patch or a guard it
 * cannot express makes the task *advanced*, edited in JSON.
 */
import type { TransitionDocument } from '../document.js'
import { isRecord, isStrings } from './fields.js'

export interface TaskFields {
  fills: { name: string; required: boolean }[]
  requires: string[]
}

export interface TaskFieldsView extends TaskFields {
  advanced: boolean
}

const PATCH_KEYS = ['type', 'properties', 'required']

const isSimpleGuard = (guard: unknown): guard is { required: string[] } =>
  isRecord(guard) && Object.keys(guard).length === 1 && isStrings(guard['required'])

export function readTaskFields(transition: TransitionDocument): TaskFieldsView {
  const patch: unknown = transition.patch
  const guards: unknown[] = transition.guards ?? []
  const properties = isRecord(patch) && isRecord(patch['properties']) ? patch['properties'] : {}
  const required = isRecord(patch) && isStrings(patch['required']) ? patch['required'] : []
  const advancedPatch =
    isRecord(patch) && (patch['type'] !== 'object' || Object.keys(patch).some((key) => !PATCH_KEYS.includes(key)))
  return {
    fills: Object.keys(properties).map((name) => ({ name, required: required.includes(name) })),
    requires: [...new Set(guards.filter(isSimpleGuard).flatMap((guard) => guard.required))],
    advanced: advancedPatch || guards.some((guard) => !isSimpleGuard(guard)),
  }
}

/**
 * The `updateTransition` patch for a form edit, or `null` when the task carries
 * JSON Schema the form cannot express. A field the step already had keeps the
 * schema it had there; a new one copies the data schema's.
 */
export function writeTaskFields(
  transition: TransitionDocument,
  data: unknown,
  fields: TaskFields,
): Partial<TransitionDocument> | null {
  if (readTaskFields(transition).advanced) return null
  const patch: unknown = transition.patch
  const existing = isRecord(patch) && isRecord(patch['properties']) ? patch['properties'] : {}
  const fromData = isRecord(data) && isRecord(data['properties']) ? data['properties'] : {}
  const required = fields.fills.filter((field) => field.required).map((field) => field.name)

  const next =
    fields.fills.length === 0
      ? undefined
      : {
          type: 'object',
          ...(required.length > 0 ? { required } : {}),
          properties: Object.fromEntries(
            fields.fills.map((field) => [field.name, existing[field.name] ?? fromData[field.name] ?? {}]),
          ),
        }
  return {
    // The properties are copied JSON Schema; the cast only re-labels `unknown` as the JSON it is.
    patch: next as unknown as TransitionDocument['patch'],
    guards: fields.requires.length === 0 ? undefined : [{ required: [...fields.requires] }],
  }
}
```

`packages/bpmn/src/forms/visibility.ts`:

```ts
/**
 * Who may read which field, as a field × role matrix.
 *
 * A role may read a path when *any* grant matches, so the matrix reads the
 * union, and a write replaces only that role's grants for that one path.
 */
import type { VisibilityDocument } from '../document.js'
import { readFields } from './fields.js'

export type Access = { kind: 'default' } | { kind: 'always' } | { kind: 'states'; states: string[] }

export function readAccess(visibility: VisibilityDocument[] | undefined, path: string, role: string): Access {
  const grants = (visibility ?? []).filter((grant) => grant.path === path && grant.roles.includes(role))
  if (grants.length === 0) return { kind: 'default' }
  if (grants.some((grant) => grant.whenState === undefined)) return { kind: 'always' }
  return { kind: 'states', states: [...new Set(grants.flatMap((grant) => grant.whenState ?? []))] }
}

export function writeAccess(
  visibility: VisibilityDocument[] | undefined,
  path: string,
  role: string,
  access: Access,
): VisibilityDocument[] {
  const next = (visibility ?? []).flatMap((grant) => {
    if (grant.path !== path || !grant.roles.includes(role)) return [structuredClone(grant)]
    const roles = grant.roles.filter((one) => one !== role)
    return roles.length === 0 ? [] : [{ ...structuredClone(grant), roles }]
  })
  if (access.kind === 'always') next.push({ path, roles: [role] })
  if (access.kind === 'states' && access.states.length > 0) {
    next.push({ path, roles: [role], whenState: [...access.states] })
  }
  return next
}

/** The rows of the matrix: every top-level field, plus any path a grant already names. */
export function visibilityPaths(data: unknown, visibility: VisibilityDocument[] | undefined): string[] {
  return [...new Set([...readFields(data).map((field) => field.name), ...(visibility ?? []).map((g) => g.path)])]
}
```

In `packages/bpmn/src/index.ts`, add:

```ts
export {
  readTaskFields,
  writeTaskFields,
  type TaskFields,
  type TaskFieldsView,
} from './forms/task-fields.js'
export { readAccess, visibilityPaths, writeAccess, type Access } from './forms/visibility.js'
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `pnpm --filter @pilots/bpmn exec vitest run`
Expected: PASS.

- [ ] **Step 5: Verify**

```bash
pnpm typecheck && pnpm lint && pnpm test
```

Stop and tell the supervisor the task is ready to review and commit.

---

### Task 8: Diagnostics on the node

**Files:**
- Create: `packages/bpmn/src/diagnostics.ts`, `packages/bpmn/test/diagnostics.test.ts`
- Modify: `packages/bpmn/src/index.ts`

**Interfaces:**
- Consumes: `parsePointer` (Task 4), `DiagramModel`, `laneKey` (Task 1).
- Produces: `type DiagnosticTarget = { kind: 'node' | 'edge' | 'lane'; key: string } | { kind: 'process' }`;
  `targetOf(document, model, pointer: string | undefined): DiagnosticTarget`.

- [ ] **Step 1: Write the failing test**

`packages/bpmn/test/diagnostics.test.ts`:

```ts
/**
 * The linter puts a JSON Pointer on every diagnostic (M6.5 designed it so); this
 * turns one into the thing on the canvas to outline. Tested against the real
 * linter, so a change to its pointers cannot silently stop the outlining.
 */
import { lintDefinition } from '@pilots/protocol'
import { describe, expect, it } from 'vitest'

import { targetOf } from '../src/diagnostics.js'
import { toDiagram } from '../src/project.js'
import { small } from './helpers/small.js'

describe('targetOf', () => {
  it('points at a state the linter names', () => {
    const document = small()
    document.states.push({ id: 'ISLAND', title: 'Island' })
    const model = toDiagram(document)
    const unreachable = lintDefinition(document).diagnostics.find((d) => d.path === '/states/3')
    expect(unreachable).toBeDefined()
    expect(targetOf(document, model, unreachable?.path)).toEqual({ kind: 'node', key: 'state:ISLAND' })
  })

  it('points at the first drawing of a transition, a lane for a role, a message for a link', () => {
    const document = small()
    document.links = [{ onEvent: 'quotation:AGREED', triggers: 'finish' }]
    const model = toDiagram(document)
    expect(targetOf(document, model, '/transitions/0/to')).toEqual({ kind: 'node', key: 'task:finish@beta' })
    expect(targetOf(document, model, '/roles/1')).toEqual({ kind: 'lane', key: 'lane:beta' })
    expect(targetOf(document, model, '/links/0/triggers')).toEqual({ kind: 'node', key: 'message:finish#0' })
  })

  it('falls back to the process for anything else', () => {
    const model = toDiagram(small())
    expect(targetOf(small(), model, '/hostedBy')).toEqual({ kind: 'process' })
    expect(targetOf(small(), model, undefined)).toEqual({ kind: 'process' })
    expect(targetOf(small(), model, '/states/99')).toEqual({ kind: 'process' })
  })
})
```

- [ ] **Step 2: Run the test to see it fail**

Run: `pnpm --filter @pilots/bpmn exec vitest run test/diagnostics.test.ts`
Expected: FAIL — module missing. (If the first test fails because the linter reports the unreachable
state at a different pointer, use the pointer it does report — print `lintDefinition(document).diagnostics`
— and keep the assertion on the target.)

- [ ] **Step 3: Implement**

`packages/bpmn/src/diagnostics.ts`:

```ts
/**
 * A linter diagnostic, placed on the canvas.
 *
 * The graph rules emit one diagnostic per offending state with a JSON Pointer,
 * precisely so an editor can outline the node at fault rather than print a
 * list. Anything not about a role, state, transition or link belongs to the
 * process as a whole.
 */
import { parsePointer } from './commands/pointer.js'
import type { DefinitionDocument } from './document.js'
import { laneKey, type DiagramModel, type ElementRef } from './model.js'

export type DiagnosticTarget = { kind: 'node' | 'edge' | 'lane'; key: string } | { kind: 'process' }

const PROCESS: DiagnosticTarget = { kind: 'process' }

export function targetOf(
  document: DefinitionDocument,
  model: DiagramModel,
  pointer: string | undefined,
): DiagnosticTarget {
  const segments = pointer === undefined ? null : parsePointer(pointer)
  if (segments === null || segments.length < 2) return PROCESS
  const [collection, position] = segments
  const index = Number(position)

  const drawn = (match: (ref: ElementRef) => boolean): DiagnosticTarget => {
    const node = model.nodes.find((one) => one.ref !== null && match(one.ref))
    if (node !== undefined) return { kind: 'node', key: node.key }
    const edge = model.edges.find((one) => one.ref !== null && match(one.ref))
    return edge === undefined ? PROCESS : { kind: 'edge', key: edge.key }
  }

  switch (collection) {
    case 'roles': {
      const role = document.roles[index]
      return role === undefined ? PROCESS : { kind: 'lane', key: laneKey(role.id) }
    }
    case 'states': {
      const state = document.states[index]
      return state === undefined ? PROCESS : drawn((ref) => ref.kind === 'state' && ref.id === state.id)
    }
    case 'transitions': {
      const transition = document.transitions[index]
      return transition === undefined
        ? PROCESS
        : drawn((ref) => ref.kind === 'transition' && ref.id === transition.id)
    }
    case 'links':
      return drawn((ref) => ref.kind === 'link' && ref.index === index)
    default:
      return PROCESS
  }
}
```

In `packages/bpmn/src/index.ts`, add:

```ts
export { targetOf, type DiagnosticTarget } from './diagnostics.js'
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `pnpm --filter @pilots/bpmn exec vitest run`
Expected: PASS.

- [ ] **Step 5: Verify**

```bash
pnpm typecheck && pnpm lint && pnpm test
```

Stop and tell the supervisor the task is ready to review and commit.

---

### Task 9: Scenario — a process built only from commands runs across two connectors

**Files:**
- Create: `apps/connector/test/drawn-process.test.ts`
- Modify: `apps/connector/package.json` (devDependency), `apps/connector/vitest.config.mts` (alias),
  `eslint.config.mjs` (a `connector-test` element)

**Interfaces:**
- Consumes: `applyCommand`, `setField`, `Command`, `DefinitionDocument` from `@pilots/bpmn`; the scenario
  harness `buildScenario` in `apps/connector/test/helpers/network.ts`; `runtime.definitions.publish`,
  `runtime.definitions.decide`, `runtime.instances.create`, `runtime.instances.applyTransition` (as used
  in `apps/connector/test/definition-adoption.test.ts`).

- [ ] **Step 1: Let connector tests — and only tests — import the package**

In `apps/connector/package.json`, add to `devDependencies`:

```json
    "@pilots/bpmn": "workspace:*",
```

In `apps/connector/vitest.config.mts`, add to `resolve.alias`, above the `@pilots/protocol` entries:

```ts
      '@pilots/bpmn': resolve(here, '../../packages/bpmn/src/index.ts'),
```

In `eslint.config.mjs`, add an element **before** the `connector` element (the first matching element
wins, so the more specific pattern must come first):

```js
        { type: 'connector-test', pattern: 'apps/connector/test/*' },
```

and the policy:

```js
            // A scenario test may build its fixture with the editor's commands, to
            // prove an editor-made process runs here. The connector itself may not.
            {
              from: { element: { type: 'connector-test' } },
              allow: {
                to: {
                  element: {
                    types: { anyOf: ['connector-test', 'connector', 'client', 'protocol', 'bpmn'] },
                  },
                },
              },
            },
```

Run: `pnpm install`

The connector's Dockerfile does not copy `packages/bpmn` and needs no change: the dependency is dev-only,
exactly like its existing `@pilots/client` devDependency.

- [ ] **Step 2: Write the scenario test**

`apps/connector/test/drawn-process.test.ts`:

```ts
/**
 * A process drawn in the editor runs on an unmodified connector.
 *
 * The definition here is never written by hand: it is built gesture by gesture
 * from `@pilots/bpmn` commands — add a lane, add states, draw tasks, drag one to
 * another lane, put a deadline on it — then published by Org A, adopted by
 * Org B, and run to a fulfilled ending across both connectors. If the editor
 * could produce something the connector cannot run, this is where it shows.
 */
import { applyCommand, setField, type Command, type DefinitionDocument } from '@pilots/bpmn'
import { lintDefinition, Problem, type JsonValue } from '@pilots/protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { ParticipantConfig } from '../src/config/config.js'
import { buildScenario, type Scenario, type ScenarioNode } from './helpers/network.js'

const ORG_A: ParticipantConfig = {
  id: 'org-a',
  did: 'did:web:org-a.example',
  displayName: 'Org A',
  baseUrl: 'https://org-a.example',
}
const ORG_B: ParticipantConfig = {
  id: 'org-b',
  did: 'did:web:org-b.example',
  displayName: 'Org B',
  baseUrl: 'https://org-b.example',
}

/** What a fresh canvas holds before the first gesture: one lane, one state, one step. */
const CANVAS: DefinitionDocument = {
  '@context': 'https://pilots.example/process/v1',
  id: 'drawn',
  version: '1.0.0',
  kind: 'service',
  title: 'Drawn in the editor',
  roles: [{ id: 'client', title: 'Client' }],
  hostedBy: 'client',
  initialState: 'OPEN',
  states: [{ id: 'OPEN', title: 'Open' }],
  data: { type: 'object' },
  transitions: [{ id: 'note', title: 'Add a note', from: ['OPEN'], by: ['client'] }],
  visibility: [],
  links: [],
}

function draw(): DefinitionDocument {
  const field = setField(CANVAS.data, ['reference'], { type: 'text', required: true })
  if (!field.ok) throw new Error(field.message)
  const gestures: Command[] = [
    { type: 'addRole', role: { id: 'supplier', title: 'Supplier' } },
    { type: 'setProcess', patch: { hostedBy: 'supplier', data: field.schema as DefinitionDocument['data'] } },
    { type: 'addState', state: { id: 'CONFIRMED', title: 'Confirmed' } },
    { type: 'addState', state: { id: 'DONE', title: 'Done', outcome: 'fulfilled' } },
    { type: 'addState', state: { id: 'STOPPED', title: 'Stopped', outcome: 'abandoned' } },
    // Drawn in the wrong lane first, then dragged — the gesture B3 maps to `by`.
    { type: 'addTransition', transition: { id: 'confirm', title: 'Confirm', from: ['OPEN'], to: 'CONFIRMED', by: ['client'] } },
    { type: 'moveTask', transition: 'confirm', fromRole: 'client', toRole: 'supplier' },
    { type: 'addTransition', transition: { id: 'finish', title: 'Finish', from: ['CONFIRMED'], to: 'DONE', by: ['client'] } },
    { type: 'addTransition', transition: { id: 'stop', title: 'Stop', from: ['*'], to: 'STOPPED', by: ['client', 'supplier'] } },
    { type: 'setDeadline', transition: 'confirm', deadline: 'P7D', onDeadline: 'stop' },
    { type: 'remove', kind: 'transition', id: 'note' },
  ]
  return gestures.reduce((document, command) => {
    const result = applyCommand(document, command)
    if (!result.ok) throw new Error(`${command.type}: ${result.error.message}`)
    return result.document
  }, CANVAS)
}

let scenario: Scenario
let a: ScenarioNode
let b: ScenarioNode

beforeEach(async () => {
  scenario = await buildScenario({ a: { participants: [ORG_A] }, b: { participants: [ORG_B] } })
  a = scenario.node('a')
  b = scenario.node('b')
  await scenario.connect('a', 'b')
})

afterEach(async () => {
  await scenario.close()
})

describe('a process drawn in the editor', () => {
  it('lints clean', () => {
    expect(lintDefinition(draw()).diagnostics.filter((d) => d.severity === 'error')).toEqual([])
  })

  it('is published, adopted by a peer who has never seen it, and run to a fulfilled ending', async () => {
    const published = await a.runtime.definitions.publish('org-a', draw() as unknown as JsonValue)
    if (!published.ok) throw new Error(JSON.stringify(published.errors))

    const start = () =>
      a.runtime.instances.create(a.caller(), {
        definition: 'drawn@1.0.0',
        participants: { client: ORG_A.did, supplier: ORG_B.did },
        data: { reference: 'R-1' },
      })

    // B hosts and has never seen it: the first attempt is what makes B fetch it.
    const first = await start()
    expect(first.ok).toBe(false)
    if (!first.ok) expect(first.errors[0]?.type).toBe(Problem.definitionPending)
    await b.runtime.definitions.decide('org-b', 'drawn@1.0.0', 'accepted', 'operator')

    const created = await start()
    if (!created.ok) throw new Error(JSON.stringify(created.errors))
    await scenario.settle()
    const id = created.value.instance.id

    const confirmed = await b.runtime.instances.applyTransition(b.caller(), id, { transition: 'confirm' }, 1)
    if (!confirmed.ok) throw new Error(JSON.stringify(confirmed.errors))
    await scenario.settle()

    const finished = await a.runtime.instances.applyTransition(a.caller(), id, { transition: 'finish' }, 2)
    if (!finished.ok) throw new Error(JSON.stringify(finished.errors))
    await scenario.settle()

    expect((await b.runtime.store.instances.get('org-b', id))?.state).toBe('DONE')
    expect((await a.runtime.store.instances.get('org-a', id))?.state).toBe('DONE')
  })
})
```

- [ ] **Step 3: Run it**

Run: `pnpm --filter @pilots/connector exec vitest run test/drawn-process.test.ts`
Expected: PASS (two tests). If `runtime.definitions.publish` or `decide` has a different signature than in
`definition-adoption.test.ts`, follow that file — it is the reference for this harness.

- [ ] **Step 4: Verify**

```bash
pnpm typecheck && pnpm lint && pnpm test
```

Then prove the boundary still protects the connector itself: temporarily add
`import '@pilots/bpmn'` to `apps/connector/src/main.ts`, run `pnpm lint`, see a `boundaries/dependencies`
error, and remove the line. Stop and tell the supervisor the task is ready to review and commit.

---

### Task 10: Process UI — wiring, the draft and its storage

**Files:**
- Modify: `apps/process-ui/package.json`, `apps/process-ui/vitest.config.mts`, `apps/process-ui/Dockerfile`,
  `eslint.config.mjs` (process-ui policy)
- Create: `apps/process-ui/src/web/modeler/draft.ts`, `apps/process-ui/src/web/modeler/storage.ts`
- Create: `apps/process-ui/test/modeler-draft.test.ts`, `apps/process-ui/test/modeler-storage.test.ts`

**Interfaces:**
- Consumes: `applyCommand`, `bumpVersion`, `renameLayoutKeys`, `Command`, `CommandError`,
  `DefinitionDocument`, `DiagramLayout` from `@pilots/bpmn`; `DefinitionDiagnostic` from `../api.js`.
- Produces:
  - `interface Snapshot { document: DefinitionDocument; layout: DiagramLayout }`
  - `interface DraftState extends Snapshot { revision; origin: 'diagram' | 'json' | 'open'; readOnly; past; future; failure: { command: Command; error: CommandError } | null; diagnostics: { revision: number; items: DefinitionDiagnostic[] } }`
  - `type DraftAction` — `command`, `move`, `replace`, `undo`, `redo`, `newVersion`, `linted`, `dismiss`
  - `initialDraft(snapshot): DraftState`, `draftReducer(state, action): DraftState`
  - `browserStorage(): Storage | null`, `loadDraft(store)`, `saveDraft(store, snapshot): boolean`,
    `loadLayout(store, ref)`, `saveLayout(store, ref, layout): boolean`

- [ ] **Step 1: Wire the package into the process UI**

`apps/process-ui/package.json` — add to `dependencies`:

```json
    "@pilots/bpmn": "workspace:*",
```

`apps/process-ui/vitest.config.mts` — add to `resolve.alias`:

```ts
      '@pilots/bpmn': resolve(here, '../../packages/bpmn/src/index.ts'),
```

`eslint.config.mjs` — the process-ui policy becomes:

```js
            // The one that matters: never `connector`.
            {
              from: { element: { type: 'process-ui' } },
              allow: {
                to: { element: { types: { anyOf: ['process-ui', 'client', 'protocol', 'bpmn'] } } },
              },
            },
```

`apps/process-ui/Dockerfile` — copy and build the package alongside the other two:

```dockerfile
COPY packages/protocol/package.json packages/protocol/
COPY packages/client/package.json packages/client/
COPY packages/bpmn/package.json packages/bpmn/
COPY apps/process-ui/package.json apps/process-ui/
RUN pnpm install --frozen-lockfile
COPY packages/protocol packages/protocol
COPY packages/client packages/client
COPY packages/bpmn packages/bpmn
COPY apps/process-ui apps/process-ui
RUN pnpm --filter @pilots/protocol build \
 && pnpm --filter @pilots/client build \
 && pnpm --filter @pilots/bpmn build \
 && pnpm --filter @pilots/process-ui build \
 && pnpm --filter @pilots/process-ui --prod deploy /out
```

Run: `pnpm install`

- [ ] **Step 2: Write the failing tests**

`apps/process-ui/test/modeler-draft.test.ts`:

```ts
/**
 * The draft: one document shared by the Diagram and JSON tabs, an undo stack,
 * and the rule that a lint result for an older revision is dropped — so a slow
 * linter never paints old errors over a newer drawing.
 */
import type { DefinitionDocument } from '@pilots/bpmn'
import { describe, expect, it } from 'vitest'

import { draftReducer, initialDraft, type DraftState } from '../src/web/modeler/draft.js'

const document: DefinitionDocument = {
  id: 'p',
  version: '1.0.0',
  kind: 'service',
  title: 'P',
  roles: [{ id: 'alpha', title: 'Alpha' }],
  hostedBy: 'alpha',
  initialState: 'OPEN',
  states: [
    { id: 'OPEN', title: 'Open' },
    { id: 'DONE', title: 'Done', outcome: 'fulfilled' },
  ],
  data: { type: 'object' },
  transitions: [{ id: 'finish', title: 'Finish', from: ['OPEN'], to: 'DONE', by: ['alpha'] }],
}

const fresh = (): DraftState => initialDraft({ document, layout: {} })
const rename: Parameters<typeof draftReducer>[1] = {
  type: 'command',
  command: { type: 'rename', kind: 'state', from: 'OPEN', to: 'READY' },
}

describe('draftReducer', () => {
  it('applies a command, bumps the revision and makes it undoable', () => {
    const after = draftReducer(fresh(), rename)
    expect(after.document.initialState).toBe('READY')
    expect(after.revision).toBe(1)
    expect(after.origin).toBe('diagram')
    const undone = draftReducer(after, { type: 'undo' })
    expect(undone.document.initialState).toBe('OPEN')
    expect(draftReducer(undone, { type: 'redo' }).document.initialState).toBe('READY')
  })

  it('carries the author’s positions through a rename', () => {
    const placed = draftReducer(fresh(), { type: 'move', key: 'state:OPEN', x: 5, y: 6 })
    expect(draftReducer(placed, rename).layout).toEqual({ 'state:READY': { x: 5, y: 6 } })
  })

  it('keeps a refused command’s error and leaves the document alone', () => {
    const after = draftReducer(fresh(), { type: 'command', command: { type: 'remove', kind: 'state', id: 'OPEN' } })
    expect(after.document).toBe(document)
    expect(after.failure?.error.code).toBe('not-allowed')
    expect(draftReducer(after, { type: 'dismiss' }).failure).toBeNull()
  })

  it('drops a lint result for a revision that is no longer on screen', () => {
    const after = draftReducer(fresh(), rename)
    const stale = draftReducer(after, { type: 'linted', revision: 0, diagnostics: [{ severity: 'error', code: 'x', message: 'old' }] })
    expect(stale.diagnostics.items).toEqual([])
    const current = draftReducer(after, { type: 'linted', revision: 1, diagnostics: [] })
    expect(current.diagnostics.revision).toBe(1)
  })

  it('refuses commands on a published definition until a new version is started', () => {
    const opened = draftReducer(fresh(), { type: 'replace', document, readOnly: true, origin: 'open' })
    expect(draftReducer(opened, rename).failure?.error.code).toBe('not-allowed')
    const next = draftReducer(opened, { type: 'newVersion' })
    expect(next.readOnly).toBe(false)
    expect(next.document.version).toBe('1.0.1')
  })

  it('does not put JSON-tab edits on the undo stack — the text box has its own', () => {
    const typed = draftReducer(fresh(), { type: 'replace', document: { ...document, title: 'Typed' }, origin: 'json' })
    expect(typed.past).toEqual([])
    expect(typed.origin).toBe('json')
  })
})
```

`apps/process-ui/test/modeler-storage.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { loadDraft, loadLayout, saveDraft, saveLayout } from '../src/web/modeler/storage.js'

function memory(): Pick<Storage, 'getItem' | 'setItem'> {
  const map = new Map<string, string>()
  return { getItem: (key) => map.get(key) ?? null, setItem: (key, value) => void map.set(key, value) }
}

const broken: Pick<Storage, 'getItem' | 'setItem'> = {
  getItem: () => {
    throw new Error('blocked')
  },
  setItem: () => {
    throw new Error('blocked')
  },
}

describe('draft storage', () => {
  it('round-trips a draft and a layout per definition', () => {
    const store = memory()
    const snapshot = { document: { id: 'p' } as never, layout: { 'state:A': { x: 1, y: 2 } } }
    expect(saveDraft(store, snapshot)).toBe(true)
    expect(loadDraft(store)).toEqual(snapshot)
    expect(saveLayout(store, 'p@1.0.0', snapshot.layout)).toBe(true)
    expect(loadLayout(store, 'p@1.0.0')).toEqual(snapshot.layout)
  })

  it('degrades to nothing, never to an exception, when storage is blocked or garbage', () => {
    expect(loadDraft(broken)).toBeNull()
    expect(saveDraft(broken, { document: {} as never, layout: {} })).toBe(false)
    expect(loadLayout(broken, 'p@1.0.0')).toEqual({})
    const store = memory()
    store.setItem('pilots.modeler.draft', '{not json')
    expect(loadDraft(store)).toBeNull()
    expect(loadDraft(null)).toBeNull()
  })
})
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `pnpm --filter @pilots/process-ui exec vitest run test/modeler-draft.test.ts test/modeler-storage.test.ts`
Expected: FAIL — modules missing.

- [ ] **Step 4: Implement**

`apps/process-ui/src/web/modeler/draft.ts`:

```ts
/**
 * The draft both tabs edit.
 *
 * One document, so switching between Diagram and JSON can never lose anything.
 * Commands go through `applyCommand` and onto the undo stack; a JSON-tab edit
 * replaces the document without one, because the text box already has undo.
 * `revision` is what a lint result is matched against: an answer for an older
 * revision is dropped (B6).
 */
import {
  applyCommand,
  bumpVersion,
  renameLayoutKeys,
  type Command,
  type CommandError,
  type DefinitionDocument,
  type DiagramLayout,
} from '@pilots/bpmn'

import type { DefinitionDiagnostic } from '../api.js'

export interface Snapshot {
  document: DefinitionDocument
  layout: DiagramLayout
}

export interface DraftState extends Snapshot {
  revision: number
  /** What made the last change — the JSON tab rewrites its text only when it was not itself. */
  origin: 'diagram' | 'json' | 'open'
  readOnly: boolean
  past: Snapshot[]
  future: Snapshot[]
  failure: { command: Command; error: CommandError } | null
  diagnostics: { revision: number; items: DefinitionDiagnostic[] }
}

export type DraftAction =
  | { type: 'command'; command: Command }
  | { type: 'move'; key: string; x: number; y: number }
  | {
      type: 'replace'
      document: DefinitionDocument
      origin: 'json' | 'open'
      readOnly?: boolean
      layout?: DiagramLayout
    }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'newVersion' }
  | { type: 'linted'; revision: number; diagnostics: DefinitionDiagnostic[] }
  | { type: 'dismiss' }

const HISTORY = 100

const READ_ONLY: CommandError = {
  code: 'not-allowed',
  message: 'This definition is published and never changes. Start a new version to edit it.',
}

export function initialDraft(snapshot: Snapshot): DraftState {
  return {
    ...snapshot,
    revision: 0,
    origin: 'open',
    readOnly: false,
    past: [],
    future: [],
    failure: null,
    diagnostics: { revision: -1, items: [] },
  }
}

const snap = (state: DraftState): Snapshot => ({ document: state.document, layout: state.layout })

export function draftReducer(state: DraftState, action: DraftAction): DraftState {
  switch (action.type) {
    case 'command': {
      if (state.readOnly) return { ...state, failure: { command: action.command, error: READ_ONLY } }
      const result = applyCommand(state.document, action.command)
      if (!result.ok) return { ...state, failure: { command: action.command, error: result.error } }
      const command = action.command
      const layout =
        command.type === 'rename'
          ? renameLayoutKeys(state.layout, command.kind, command.from, command.to)
          : state.layout
      return {
        ...state,
        document: result.document,
        layout,
        revision: state.revision + 1,
        origin: 'diagram',
        past: [...state.past, snap(state)].slice(-HISTORY),
        future: [],
        failure: null,
      }
    }
    // Positions only: not a change to the process, so no revision, no lint, no undo entry.
    case 'move':
      return { ...state, layout: { ...state.layout, [action.key]: { x: action.x, y: action.y } } }
    case 'replace': {
      const opening = action.origin === 'open'
      return {
        ...state,
        document: action.document,
        layout: action.layout ?? state.layout,
        readOnly: action.readOnly ?? false,
        origin: action.origin,
        revision: state.revision + 1,
        past: opening ? [] : state.past,
        future: opening ? [] : state.future,
        failure: null,
      }
    }
    case 'undo': {
      const previous = state.past.at(-1)
      if (previous === undefined || state.readOnly) return state
      return {
        ...state,
        ...previous,
        revision: state.revision + 1,
        origin: 'diagram',
        past: state.past.slice(0, -1),
        future: [snap(state), ...state.future],
        failure: null,
      }
    }
    case 'redo': {
      const next = state.future[0]
      if (next === undefined || state.readOnly) return state
      return {
        ...state,
        ...next,
        revision: state.revision + 1,
        origin: 'diagram',
        past: [...state.past, snap(state)],
        future: state.future.slice(1),
        failure: null,
      }
    }
    case 'newVersion': {
      if (!state.readOnly) return state
      const result = applyCommand(state.document, {
        type: 'setProcess',
        patch: { version: bumpVersion(state.document.version) },
      })
      if (!result.ok) return state
      return {
        ...state,
        document: result.document,
        readOnly: false,
        revision: state.revision + 1,
        origin: 'diagram',
        past: [],
        future: [],
        failure: null,
      }
    }
    case 'linted':
      return action.revision === state.revision
        ? { ...state, diagnostics: { revision: action.revision, items: action.diagnostics } }
        : state
    case 'dismiss':
      return { ...state, failure: null }
  }
}
```

`apps/process-ui/src/web/modeler/storage.ts`:

```ts
/**
 * Drafts live in the browser, never in the connector — it holds published
 * definitions only (the F-series "no drafts" decision). Every access is
 * guarded: a private window or blocked site data must cost the author their
 * draft on reload, not the editor.
 */
import type { DefinitionDocument, DiagramLayout } from '@pilots/bpmn'

import type { Snapshot } from './draft.js'

type Store = Pick<Storage, 'getItem' | 'setItem'>

const DRAFT = 'pilots.modeler.draft'
const layoutKey = (ref: string): string => `pilots.modeler.layout:${ref}`

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** `null` when the browser will not let us store anything. */
export function browserStorage(): Storage | null {
  try {
    const store = window.localStorage
    store.setItem('pilots.modeler.probe', '1')
    store.removeItem('pilots.modeler.probe')
    return store
  } catch {
    return null
  }
}

export function loadDraft(store: Store | null): Snapshot | null {
  if (store === null) return null
  try {
    const raw = store.getItem(DRAFT)
    if (raw === null) return null
    const value: unknown = JSON.parse(raw)
    if (!isRecord(value) || !isRecord(value['document'])) return null
    return {
      document: value['document'] as unknown as DefinitionDocument,
      layout: isRecord(value['layout']) ? (value['layout'] as DiagramLayout) : {},
    }
  } catch {
    return null
  }
}

export function saveDraft(store: Store, snapshot: Snapshot): boolean {
  try {
    store.setItem(DRAFT, JSON.stringify(snapshot))
    return true
  } catch {
    return false
  }
}

/** The author's layout for a published definition, so reopening it here shows their drawing. */
export function loadLayout(store: Store, ref: string): DiagramLayout {
  try {
    const raw = store.getItem(layoutKey(ref))
    const value: unknown = raw === null ? null : JSON.parse(raw)
    return isRecord(value) ? (value as DiagramLayout) : {}
  } catch {
    return {}
  }
}

export function saveLayout(store: Store, ref: string, layout: DiagramLayout): boolean {
  try {
    store.setItem(layoutKey(ref), JSON.stringify(layout))
    return true
  } catch {
    return false
  }
}
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `pnpm --filter @pilots/process-ui exec vitest run`
Expected: PASS.

- [ ] **Step 6: Verify**

```bash
pnpm typecheck && pnpm lint && pnpm test
```

Stop and tell the supervisor the task is ready to review and commit.

---

### Task 11: Process UI — the canvas

**Files:**
- Create: `apps/process-ui/src/web/modeler/flow.ts`, `modeler/shapes.tsx`, `modeler/Canvas.tsx`
- Create: `apps/process-ui/test/modeler-flow.test.ts`

**Interfaces:**
- Consumes: `DiagramModel`, `DiagramNode`, `DiagramLayout`, `ElementRef`, `LANE_HEIGHT`, `laneAt` from
  `@pilots/bpmn`.
- Produces: `toFlow(model, layout, { flagged, readOnly }): { nodes: Node[]; edges: Edge[] }`;
  `laneChange(node, y, model): { transition; fromRole; toRole } | null`;
  `stateOfKey(key): string | null`; `refOfKey(model, key): ElementRef | null`; `LANE_WIDTH`;
  `<Canvas model layout flagged readOnly onMove onMoveTask onConnectStates onSelect />`.

- [ ] **Step 1: Write the failing test**

`apps/process-ui/test/modeler-flow.test.ts`:

```ts
import { LANE_HEIGHT, toDiagram, withLayout, type DefinitionDocument } from '@pilots/bpmn'
import { describe, expect, it } from 'vitest'

import { laneChange, refOfKey, stateOfKey, toFlow } from '../src/web/modeler/flow.js'

const document: DefinitionDocument = {
  id: 'p',
  version: '1.0.0',
  kind: 'service',
  title: 'P',
  roles: [
    { id: 'alpha', title: 'Alpha' },
    { id: 'beta', title: 'Beta' },
  ],
  hostedBy: 'alpha',
  initialState: 'OPEN',
  states: [
    { id: 'OPEN', title: 'Open' },
    { id: 'DONE', title: 'Done', outcome: 'fulfilled' },
  ],
  data: { type: 'object' },
  transitions: [{ id: 'finish', title: 'Finish', from: ['OPEN'], to: 'DONE', by: ['alpha'] }],
}
const model = toDiagram(document)

describe('toFlow', () => {
  it('draws lanes behind the nodes, and flags what the linter named', () => {
    const flow = toFlow(model, withLayout(model), { flagged: new Set(['state:DONE']), readOnly: false })
    expect(flow.nodes.slice(0, 2).map((n) => n.id)).toEqual(['lane:alpha', 'lane:beta'])
    expect(flow.nodes.find((n) => n.id === 'lane:beta')?.position).toEqual({ x: 0, y: LANE_HEIGHT })
    expect(flow.nodes.find((n) => n.id === 'state:DONE')?.data).toMatchObject({ flagged: true })
  })

  it('locks every node of a read-only definition', () => {
    const flow = toFlow(model, withLayout(model), { flagged: new Set(), readOnly: true })
    expect(flow.nodes.every((n) => n.draggable === false)).toBe(true)
  })
})

describe('laneChange', () => {
  it('turns a task dropped in another lane into a change of role', () => {
    const task = model.nodes.find((n) => n.key === 'task:finish@alpha')!
    expect(laneChange(task, LANE_HEIGHT + 20, model)).toEqual({ transition: 'finish', fromRole: 'alpha', toRole: 'beta' })
    expect(laneChange(task, 20, model)).toBeNull()
    expect(laneChange(model.nodes.find((n) => n.key === 'state:OPEN')!, LANE_HEIGHT + 20, model)).toBeNull()
  })
})

describe('keys', () => {
  it('reads the state behind a state or gateway key, and the element behind any key', () => {
    expect(stateOfKey('state:OPEN')).toBe('OPEN')
    expect(stateOfKey('gateway:OPEN')).toBe('OPEN')
    expect(stateOfKey('task:finish@alpha')).toBeNull()
    expect(refOfKey(model, 'lane:beta')).toEqual({ kind: 'role', id: 'beta' })
    expect(refOfKey(model, 'task:finish@alpha')).toEqual({ kind: 'transition', id: 'finish' })
    expect(refOfKey(model, 'nothing')).toBeNull()
  })
})
```

- [ ] **Step 2: Run the test to see it fail**

Run: `pnpm --filter @pilots/process-ui exec vitest run test/modeler-flow.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the pure mapping**

`apps/process-ui/src/web/modeler/flow.ts`:

```ts
/**
 * The diagram model, in React Flow's terms — and the two gestures that mean
 * something to the definition: dropping a task in another lane (a change of
 * role) and drawing an arrow from one state to another (a new task).
 */
import {
  LANE_HEIGHT,
  laneAt,
  type DiagramLayout,
  type DiagramModel,
  type DiagramNode,
  type ElementRef,
} from '@pilots/bpmn'
import type { Edge, Node } from '@xyflow/react'

export const LANE_WIDTH = 2400

export function toFlow(
  model: DiagramModel,
  layout: DiagramLayout,
  options: { flagged: ReadonlySet<string>; readOnly: boolean },
): { nodes: Node[]; edges: Edge[] } {
  const lanes: Node[] = model.lanes.map((lane, index) => ({
    id: lane.key,
    type: 'lane',
    position: { x: 0, y: index * LANE_HEIGHT },
    data: { title: lane.title, multiple: lane.multiple, flagged: options.flagged.has(lane.key) },
    draggable: false,
    selectable: true,
    zIndex: -1,
    style: { width: LANE_WIDTH, height: LANE_HEIGHT },
  }))
  const nodes: Node[] = model.nodes.map((node) => ({
    id: node.key,
    type: 'bpmn',
    position: layout[node.key] ?? { x: 0, y: 0 },
    data: { node, flagged: options.flagged.has(node.key) },
    draggable: !options.readOnly,
    selectable: true,
  }))
  const edges: Edge[] = model.edges.map((edge) => ({
    id: edge.key,
    source: edge.source,
    target: edge.target,
    ...(edge.label === null ? {} : { label: edge.label }),
    data: { flagged: options.flagged.has(edge.key), markers: edge.markers },
  }))
  return { nodes: [...lanes, ...nodes], edges }
}

/** A task dropped in another lane is fired by another role. */
export function laneChange(
  node: DiagramNode,
  y: number,
  model: DiagramModel,
): { transition: string; fromRole: string; toRole: string } | null {
  if (node.kind !== 'task' || node.lane === null || node.ref?.kind !== 'transition') return null
  const toRole = laneAt(model, y)
  if (toRole === null || toRole === node.lane) return null
  return { transition: node.ref.id, fromRole: node.lane, toRole }
}

/** An arrow may be drawn from a state, or from the gateway after it. */
export function stateOfKey(key: string): string | null {
  const match = /^(?:state|gateway):(.+)$/.exec(key)
  return match?.[1] ?? null
}

/** What the properties panel should show for a clicked key. */
export function refOfKey(model: DiagramModel, key: string): ElementRef | null {
  const lane = model.lanes.find((one) => one.key === key)
  if (lane !== undefined) return { kind: 'role', id: lane.roleId }
  return (
    model.nodes.find((one) => one.key === key)?.ref ?? model.edges.find((one) => one.key === key)?.ref ?? null
  )
}
```

- [ ] **Step 4: Run the test to see it pass**

Run: `pnpm --filter @pilots/process-ui exec vitest run test/modeler-flow.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the shapes and the canvas**

`apps/process-ui/src/web/modeler/shapes.tsx`:

```tsx
/**
 * BPMN shapes as React Flow nodes. Classes, not hex, so they follow dark mode.
 *
 * Only states and gateways are connectable: an arrow drawn from one state to
 * another is the gesture that adds a task between them.
 */
import type { DiagramNode } from '@pilots/bpmn'
import { Handle, Position, type NodeProps } from '@xyflow/react'

const MARK: Record<string, string> = { auto: '⚙', 'any-state': '✱', update: '↺', unfireable: '⚠' }
const surface = 'border-slate-500 bg-white text-slate-900 dark:bg-slate-900 dark:text-slate-100'

export function BpmnNode({ data, selected }: NodeProps) {
  const { node, flagged } = data as { node: DiagramNode; flagged: boolean }
  const ring = flagged ? 'ring-2 ring-rose-500' : selected ? 'ring-2 ring-sky-500' : ''
  const connectable = node.kind === 'start' || node.kind === 'state' || node.kind === 'end' || node.kind === 'gateway'
  return (
    <div data-node={node.key} className="flex flex-col items-center">
      <Handle type="target" position={Position.Left} isConnectable={connectable} />
      <Shape node={node} ring={ring} />
      <Handle type="source" position={Position.Right} isConnectable={connectable && node.kind !== 'end'} />
    </div>
  )
}

function Shape({ node, ring }: { node: DiagramNode; ring: string }) {
  const marks = node.markers.map((marker) => MARK[marker]).filter(Boolean).join(' ')
  if (node.kind === 'task') {
    return (
      <div className={`flex h-14 w-32 items-center justify-center rounded-lg border px-2 text-center text-[11px] ${surface} ${ring}`}>
        {marks !== '' && <span className="mr-1">{marks}</span>}
        {node.label}
      </div>
    )
  }
  if (node.kind === 'gateway') {
    return (
      <div className={`h-9 w-9 rotate-45 border ${surface} ${ring}`}>
        <div className="m-2 h-4 w-4 rounded-full border border-slate-500" />
      </div>
    )
  }
  const border = node.kind === 'start' ? 'border' : node.kind === 'end' ? 'border-4' : 'border-4 border-double'
  const icon =
    node.kind === 'timer'
      ? '⏱'
      : node.kind === 'message'
        ? '✉'
        : node.markers.includes('abandoned')
          ? '✕'
          : node.markers.includes('fulfilled')
            ? '✓'
            : marks
  return (
    <div className="flex flex-col items-center">
      <div className={`flex h-9 w-9 items-center justify-center rounded-full text-xs ${border} ${surface} ${ring}`}>{icon}</div>
      <span className="mt-1 max-w-28 text-center text-[10px]">{node.label}</span>
    </div>
  )
}

export function LaneNode({ data }: NodeProps) {
  const { title, multiple, flagged } = data as { title: string; multiple: boolean; flagged: boolean }
  return (
    <div className={`h-full w-full border-b border-slate-200 dark:border-slate-700 ${flagged ? 'bg-rose-50 dark:bg-rose-950/30' : ''}`}>
      <div className="flex h-full w-28 items-center justify-center border-r border-slate-200 bg-slate-50 text-xs font-medium dark:border-slate-700 dark:bg-slate-800">
        {title}
        {multiple ? ' ⫴' : ''}
      </div>
    </div>
  )
}
```

`apps/process-ui/src/web/modeler/Canvas.tsx`:

```tsx
/**
 * The canvas. Positions are the author's and never touch the definition; the
 * two gestures that do — a task dropped in another lane, an arrow between two
 * states — are reported up as intents and become commands in the Modeler.
 */
import type { DiagramLayout, DiagramModel } from '@pilots/bpmn'
import {
  Background,
  Controls,
  MarkerType,
  ReactFlow,
  useNodesState,
  type Connection,
  type Node,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useEffect, useMemo } from 'react'

import { laneChange, stateOfKey, toFlow } from './flow.js'
import { BpmnNode, LaneNode } from './shapes.js'

const nodeTypes = { bpmn: BpmnNode, lane: LaneNode }

export interface CanvasProps {
  model: DiagramModel
  layout: DiagramLayout
  flagged: ReadonlySet<string>
  readOnly: boolean
  onMove: (key: string, x: number, y: number) => void
  onMoveTask: (change: { transition: string; fromRole: string; toRole: string }) => void
  onConnectStates: (from: string, to: string) => void
  onSelect: (key: string | null) => void
}

export function Canvas(props: CanvasProps) {
  const { model, layout, flagged, readOnly } = props
  const flow = useMemo(() => toFlow(model, layout, { flagged, readOnly }), [model, layout, flagged, readOnly])
  // React Flow moves a dragged node through its own state; the definition is untouched until the drop.
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>(flow.nodes)
  useEffect(() => setNodes(flow.nodes), [flow.nodes, setNodes])

  const edges = useMemo(
    () =>
      flow.edges.map((edge) => ({
        ...edge,
        markerEnd: { type: MarkerType.ArrowClosed },
        // React Flow paints edges in its own SVG layer, so these read on either background.
        style: { stroke: (edge.data as { flagged: boolean }).flagged ? '#e11d48' : '#64748b' },
        labelShowBg: false,
        labelStyle: { fontSize: 9, fill: '#94a3b8' },
      })),
    [flow.edges],
  )
  const byKey = useMemo(() => new Map(model.nodes.map((node) => [node.key, node])), [model])

  return (
    <div data-testid="modeler-canvas" className="h-[32rem] w-full rounded-lg border border-slate-200 dark:border-slate-800">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        fitView
        fitViewOptions={{ padding: 0.1 }}
        colorMode="system"
        minZoom={0.2}
        nodesDraggable={!readOnly}
        nodesConnectable={!readOnly}
        elementsSelectable
        onNodeDragStop={(_event, node) => {
          const dropped = byKey.get(node.id)
          if (dropped === undefined) return
          props.onMove(node.id, node.position.x, node.position.y)
          const change = laneChange(dropped, node.position.y, model)
          if (change !== null) props.onMoveTask(change)
        }}
        onConnect={(connection: Connection) => {
          const from = stateOfKey(connection.source)
          const to = stateOfKey(connection.target)
          if (from !== null && to !== null) props.onConnectStates(from, to)
        }}
        onNodeClick={(_event, node) => props.onSelect(node.id)}
        onEdgeClick={(_event, edge) => props.onSelect(edge.id)}
        onPaneClick={() => props.onSelect(null)}
      >
        <Background />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  )
}
```

- [ ] **Step 6: Verify**

```bash
pnpm typecheck && pnpm lint && pnpm test
```

The canvas is not mounted yet (Task 14 does that); this task proves it compiles and its pure mapping is
correct. Stop and tell the supervisor the task is ready to review and commit.

---

### Task 12: Process UI — palette and the "new element" forms

**Files:**
- Create: `apps/process-ui/src/web/modeler/fields.tsx`, `modeler/Palette.tsx`, `modeler/NewElement.tsx`

**Interfaces:**
- Consumes: `Command`, `DefinitionDocument`, `freshId`, `identifierFrom`, `ANY_STATE` from `@pilots/bpmn`;
  `button`, `ghost`, `input` from `../ui.js`.
- Produces:
  - `fields.tsx`: `TextField({ label, value, onCommit, testid?, placeholder? })` (commits on blur or Enter,
    only when changed), `Labelled({ label, children })`, `Panel({ title, onClose, onSubmit, submitLabel, children })`
  - `Palette({ document, run, onAsk })`
  - `type Pending = { kind: 'task'; from?: string; to?: string } | { kind: 'timer' } | { kind: 'message' }`
  - `NewElement({ pending, document, run, onClose })`

- [ ] **Step 1: Write the shared form pieces**

`apps/process-ui/src/web/modeler/fields.tsx`:

```tsx
/**
 * Inputs that commit on blur or Enter, not per keystroke: every commit is a
 * command, an undo entry and a lint request, and a title typed letter by letter
 * should be one of each, not twenty.
 */
import { useEffect, useState, type ReactNode } from 'react'

import { button, ghost, input } from '../ui.js'

export function TextField({
  label,
  value,
  onCommit,
  testid,
  placeholder,
}: {
  label: string
  value: string
  onCommit: (value: string) => void
  testid?: string
  placeholder?: string
}) {
  const [text, setText] = useState(value)
  useEffect(() => setText(value), [value])
  const commit = (): void => {
    if (text !== value) onCommit(text)
  }
  return (
    <Labelled label={label}>
      <input
        className={input}
        value={text}
        placeholder={placeholder}
        data-testid={testid}
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit()
        }}
      />
    </Labelled>
  )
}

/**
 * A caption over a control or a group of controls. A `div`, not a `label`: some
 * groups hold checkboxes with labels of their own, and labels must not nest.
 */
export function Labelled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="block" role="group" aria-label={label}>
      <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400">{label}</span>
      {children}
    </div>
  )
}

export function Panel({
  title,
  onClose,
  onSubmit,
  submitLabel,
  children,
}: {
  title: string
  onClose: () => void
  onSubmit: () => void
  submitLabel: string
  children: ReactNode
}) {
  return (
    <div data-testid="new-element" className="flex flex-col gap-2 rounded-lg border border-slate-300 p-3 dark:border-slate-600">
      <h3 className="text-sm font-semibold">{title}</h3>
      <div className="grid gap-2 sm:grid-cols-2">{children}</div>
      <div className="flex gap-2">
        <button type="button" className={button} data-testid="new-element-submit" onClick={onSubmit}>
          {submitLabel}
        </button>
        <button type="button" className={ghost} onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Write the palette**

`apps/process-ui/src/web/modeler/Palette.tsx`:

```tsx
/**
 * The palette is the restriction (B5): seven things, and none of the BPMN
 * elements a definition cannot express — no parallel gateway, because an
 * instance is in one state at a time; no subprocess, loop or data object.
 * Gateways are not here either: they are derived.
 */
import { freshId, type Command, type DefinitionDocument } from '@pilots/bpmn'

import { ghost } from '../ui.js'
import type { Pending } from './NewElement.js'

export function Palette({
  document,
  run,
  onAsk,
}: {
  document: DefinitionDocument
  run: (command: Command) => void
  onAsk: (pending: Pending) => void
}) {
  const roles = document.roles.map((one) => one.id)
  const states = document.states.map((one) => one.id)
  const item = (label: string, testid: string, act: () => void) => (
    <button key={testid} type="button" className={ghost} data-testid={testid} onClick={act}>
      {label}
    </button>
  )
  return (
    <div className="flex flex-wrap gap-2" data-testid="palette">
      {item('+ Lane', 'palette-lane', () =>
        run({ type: 'addRole', role: { id: freshId('role', roles), title: 'New role' } }),
      )}
      {item('+ State', 'palette-state', () =>
        run({ type: 'addState', state: { id: freshId('STATE', states), title: 'New state' } }),
      )}
      {item('+ End ✓', 'palette-end-fulfilled', () =>
        run({ type: 'addState', state: { id: freshId('DONE', states), title: 'Done', outcome: 'fulfilled' } }),
      )}
      {item('+ End ✕', 'palette-end-abandoned', () =>
        run({ type: 'addState', state: { id: freshId('STOPPED', states), title: 'Stopped', outcome: 'abandoned' } }),
      )}
      {item('+ Task', 'palette-task', () => onAsk({ kind: 'task' }))}
      {item('+ Timer', 'palette-timer', () => onAsk({ kind: 'timer' }))}
      {item('+ Message', 'palette-message', () => onAsk({ kind: 'message' }))}
    </div>
  )
}
```

- [ ] **Step 3: Write the "new element" forms**

`apps/process-ui/src/web/modeler/NewElement.tsx`:

```tsx
/**
 * The three additions that need more than one value: a task (lane, from, to),
 * a timer (which transition arms it, how long, what it fires) and a message
 * (which linked event, what it fires).
 */
import { ANY_STATE, identifierFrom, type Command, type DefinitionDocument } from '@pilots/bpmn'
import { useState } from 'react'

import { input } from '../ui.js'
import { Labelled, Panel } from './fields.js'

export type Pending = { kind: 'task'; from?: string; to?: string } | { kind: 'timer' } | { kind: 'message' }

interface Props {
  document: DefinitionDocument
  run: (command: Command) => void
  onClose: () => void
}

export function NewElement({ pending, ...props }: Props & { pending: Pending }) {
  switch (pending.kind) {
    case 'task':
      return <NewTask {...props} from={pending.from} to={pending.to} />
    case 'timer':
      return <NewTimer {...props} />
    case 'message':
      return <NewMessage {...props} />
  }
}

function NewTask({ document, run, onClose, from, to }: Props & { from?: string; to?: string }) {
  const [title, setTitle] = useState('')
  const [role, setRole] = useState(document.roles[0]?.id ?? '')
  const [source, setSource] = useState(from ?? document.initialState)
  const [target, setTarget] = useState(to ?? '')
  const submit = (): void => {
    const id = identifierFrom(title, document.transitions.map((one) => one.id))
    run({
      type: 'addTransition',
      transition: {
        id,
        title: title.trim() === '' ? id : title.trim(),
        from: [source],
        ...(target === '' ? {} : { to: target }),
        by: [role],
      },
    })
    onClose()
  }
  return (
    <Panel title="New task" onClose={onClose} onSubmit={submit} submitLabel="Add task">
      <Labelled label="Title">
        <input className={input} data-testid="new-task-title" value={title} onChange={(e) => setTitle(e.target.value)} />
      </Labelled>
      <Labelled label="Lane">
        <select className={input} data-testid="new-task-lane" value={role} onChange={(e) => setRole(e.target.value)}>
          {document.roles.map((one) => (
            <option key={one.id} value={one.id}>
              {one.title}
            </option>
          ))}
        </select>
      </Labelled>
      <Labelled label="From">
        <select className={input} data-testid="new-task-from" value={source} onChange={(e) => setSource(e.target.value)}>
          <option value={ANY_STATE}>any state</option>
          {document.states.map((one) => (
            <option key={one.id} value={one.id}>
              {one.title} ({one.id})
            </option>
          ))}
        </select>
      </Labelled>
      <Labelled label="To">
        <select className={input} data-testid="new-task-to" value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value="">stays — a data update</option>
          {document.states.map((one) => (
            <option key={one.id} value={one.id}>
              {one.title} ({one.id})
            </option>
          ))}
        </select>
      </Labelled>
    </Panel>
  )
}

function NewTimer({ document, run, onClose }: Props) {
  const arming = document.transitions.filter((one) => one.to !== undefined)
  const [transition, setTransition] = useState(arming[0]?.id ?? '')
  const [duration, setDuration] = useState('PT24H')
  const [target, setTarget] = useState(document.transitions[0]?.id ?? '')
  const submit = (): void => {
    run({ type: 'setDeadline', transition, deadline: duration.trim(), onDeadline: target })
    onClose()
  }
  return (
    <Panel title="New timer" onClose={onClose} onSubmit={submit} submitLabel="Add timer">
      <Labelled label="Starts when this task completes">
        <select className={input} data-testid="new-timer-arming" value={transition} onChange={(e) => setTransition(e.target.value)}>
          {arming.map((one) => (
            <option key={one.id} value={one.id}>
              {one.title} → {one.to}
            </option>
          ))}
        </select>
      </Labelled>
      <Labelled label="Duration (P#D, PT#H or PT#M)">
        <input className={input} data-testid="new-timer-duration" value={duration} onChange={(e) => setDuration(e.target.value)} />
      </Labelled>
      <Labelled label="Then fires">
        <select className={input} data-testid="new-timer-target" value={target} onChange={(e) => setTarget(e.target.value)}>
          {document.transitions.map((one) => (
            <option key={one.id} value={one.id}>
              {one.title}
            </option>
          ))}
        </select>
      </Labelled>
    </Panel>
  )
}

function NewMessage({ document, run, onClose }: Props) {
  const [onEvent, setOnEvent] = useState('')
  const [target, setTarget] = useState(document.transitions[0]?.id ?? '')
  const submit = (): void => {
    run({ type: 'addLink', link: { onEvent: onEvent.trim(), triggers: target } })
    onClose()
  }
  return (
    <Panel title="New message" onClose={onClose} onSubmit={submit} submitLabel="Add message">
      <Labelled label="Event in the linked instance">
        <input
          className={input}
          data-testid="new-message-event"
          placeholder="relation:STATE"
          value={onEvent}
          onChange={(e) => setOnEvent(e.target.value)}
        />
      </Labelled>
      <Labelled label="Then fires">
        <select className={input} data-testid="new-message-target" value={target} onChange={(e) => setTarget(e.target.value)}>
          {document.transitions.map((one) => (
            <option key={one.id} value={one.id}>
              {one.title}
            </option>
          ))}
        </select>
      </Labelled>
    </Panel>
  )
}
```

- [ ] **Step 4: Verify**

```bash
pnpm typecheck && pnpm lint && pnpm test
```

Stop and tell the supervisor the task is ready to review and commit.

---

### Task 13: Process UI — the properties panel

**Files:**
- Create: `apps/process-ui/src/web/modeler/Properties.tsx`
- Create: `apps/process-ui/src/web/modeler/properties/ProcessPanel.tsx`, `properties/ElementPanels.tsx`,
  `properties/FieldBuilder.tsx`, `properties/TaskFieldsEditor.tsx`, `properties/VisibilityMatrix.tsx`,
  `properties/Advanced.tsx`

**Interfaces:**
- Consumes: from `@pilots/bpmn` — `Command`, `DefinitionDocument`, `DiagramModel`, `ElementRef`,
  `ANY_STATE`, `readFields`, `setField`, `removeField`, `readTaskFields`, `writeTaskFields`, `readAccess`,
  `writeAccess`, `visibilityPaths`, `getPointer`, `pointerOf`, `FieldType`, `FieldView`, `Access`; from
  Task 11 `refOfKey`; from Task 12 `TextField`, `Labelled`.
- Produces: `Properties({ document, model, selected, readOnly, run })`.

- [ ] **Step 1: Write the panel switch**

`apps/process-ui/src/web/modeler/Properties.tsx`:

```tsx
/**
 * What the drawing cannot show: ids, titles, the data schema, what each step
 * fills in, who may read what. Driven by the selection; nothing selected is the
 * process itself. A read-only definition shows everything and accepts nothing.
 */
import type { Command, DefinitionDocument, DiagramModel } from '@pilots/bpmn'

import { refOfKey } from './flow.js'
import { LinkPanel, RolePanel, StatePanel, TaskPanel } from './properties/ElementPanels.js'
import { ProcessPanel } from './properties/ProcessPanel.js'

export function Properties({
  document,
  model,
  selected,
  readOnly,
  run,
}: {
  document: DefinitionDocument
  model: DiagramModel
  selected: string | null
  readOnly: boolean
  run: (command: Command) => void
}) {
  const ref = selected === null ? null : refOfKey(model, selected)
  return (
    <aside data-testid="properties" className="rounded-lg border border-slate-200 p-3 text-sm dark:border-slate-700">
      <fieldset disabled={readOnly} className="flex flex-col gap-3">
        {ref === null && <ProcessPanel document={document} run={run} />}
        {ref?.kind === 'role' && <RolePanel document={document} id={ref.id} run={run} />}
        {ref?.kind === 'state' && <StatePanel document={document} id={ref.id} run={run} />}
        {ref?.kind === 'transition' && <TaskPanel document={document} id={ref.id} run={run} />}
        {ref?.kind === 'link' && <LinkPanel document={document} index={ref.index} run={run} />}
      </fieldset>
    </aside>
  )
}
```

- [ ] **Step 2: Write the process panel**

`apps/process-ui/src/web/modeler/properties/ProcessPanel.tsx`:

```tsx
import type { Command, DefinitionDocument } from '@pilots/bpmn'
import { useState } from 'react'

import { input } from '../../ui.js'
import { Labelled, TextField } from '../fields.js'
import { FieldBuilder } from './FieldBuilder.js'
import { VisibilityMatrix } from './VisibilityMatrix.js'

type Tab = 'general' | 'data' | 'visibility'

export function ProcessPanel({ document, run }: { document: DefinitionDocument; run: (c: Command) => void }) {
  const [tab, setTab] = useState<Tab>('general')
  const set = (patch: Extract<Command, { type: 'setProcess' }>['patch']): void => run({ type: 'setProcess', patch })
  return (
    <>
      <div className="flex gap-2 text-xs">
        {(['general', 'data', 'visibility'] as const).map((one) => (
          <button
            key={one}
            type="button"
            data-testid={`process-tab-${one}`}
            className={one === tab ? 'font-semibold underline' : 'text-slate-500'}
            onClick={() => setTab(one)}
          >
            {one === 'general' ? 'Process' : one === 'data' ? 'Data' : 'Who sees what'}
          </button>
        ))}
      </div>

      {tab === 'general' && (
        <>
          <TextField label="Id" value={document.id} testid="process-id" onCommit={(id) => set({ id })} />
          <TextField label="Version" value={document.version} testid="process-version" onCommit={(version) => set({ version })} />
          <TextField label="Title" value={document.title} testid="process-title" onCommit={(title) => set({ title })} />
          <TextField
            label="Description"
            value={document.description ?? ''}
            onCommit={(text) => set({ description: text === '' ? undefined : text })}
          />
          <Labelled label="Kind">
            <select className={input} value={document.kind} onChange={(e) => set({ kind: e.target.value as 'service' | 'quotation' })}>
              <option value="service">service</option>
              <option value="quotation">quotation</option>
            </select>
          </Labelled>
          <Labelled label="Hosted by">
            <select className={input} data-testid="process-hostedBy" value={document.hostedBy} onChange={(e) => set({ hostedBy: e.target.value })}>
              {document.hostedBy === '' && <option value="">— choose a role —</option>}
              {document.roles.map((one) => (
                <option key={one.id} value={one.id}>
                  {one.title}
                </option>
              ))}
            </select>
          </Labelled>
          <Labelled label="Starts in">
            <select
              className={input}
              data-testid="process-initialState"
              value={document.initialState}
              onChange={(e) => set({ initialState: e.target.value })}
            >
              {document.initialState === '' && <option value="">— choose a state —</option>}
              {document.states.map((one) => (
                <option key={one.id} value={one.id}>
                  {one.title} ({one.id})
                </option>
              ))}
            </select>
          </Labelled>
          <Labelled label="Fields nobody is granted">
            <select
              className={input}
              value={document.defaultVisibility ?? 'all'}
              onChange={(e) => set({ defaultVisibility: e.target.value as 'all' | 'none' })}
            >
              <option value="all">are visible to everyone</option>
              <option value="none">are visible to nobody</option>
            </select>
          </Labelled>
          <Labelled label="Who may start it (none ticked: anyone)">
            <div className="flex flex-col gap-1">
              {document.roles.map((one) => {
                const chosen = document.createdBy ?? []
                return (
                  <label key={one.id} className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={chosen.includes(one.id)}
                      onChange={(e) => {
                        const next = e.target.checked ? [...chosen, one.id] : chosen.filter((r) => r !== one.id)
                        set({ createdBy: next.length === 0 ? undefined : next })
                      }}
                    />
                    {one.title}
                  </label>
                )
              })}
            </div>
          </Labelled>
        </>
      )}

      {tab === 'data' && <FieldBuilder document={document} run={run} />}
      {tab === 'visibility' && <VisibilityMatrix document={document} run={run} />}
    </>
  )
}
```

- [ ] **Step 3: Write the field builder**

`apps/process-ui/src/web/modeler/properties/FieldBuilder.tsx`:

```tsx
/**
 * The `data` schema as a list of fields. A field the form cannot show is listed
 * with an *edited in JSON* badge and no controls: it is kept, never rewritten.
 */
import {
  readFields,
  removeField,
  setField,
  type Command,
  type DefinitionDocument,
  type FieldResult,
  type FieldType,
  type FieldView,
} from '@pilots/bpmn'
import { useState } from 'react'

import { ghost, input } from '../../ui.js'

const TYPES: FieldType[] = ['text', 'number', 'datetime', 'choice', 'boolean', 'group']

export function FieldBuilder({ document, run }: { document: DefinitionDocument; run: (c: Command) => void }) {
  const [problem, setProblem] = useState<string | null>(null)
  const write = (result: FieldResult): void => {
    if (!result.ok) {
      setProblem(result.message)
      return
    }
    setProblem(null)
    run({ type: 'setProcess', patch: { data: result.schema as DefinitionDocument['data'] } })
  }
  return (
    <div className="flex flex-col gap-2" data-testid="field-builder">
      <Fields fields={readFields(document.data)} path={[]} data={document.data} write={write} />
      {problem !== null && <p className="text-xs text-rose-700 dark:text-rose-400">{problem}</p>}
    </div>
  )
}

function Fields({
  fields,
  path,
  data,
  write,
}: {
  fields: FieldView[]
  path: string[]
  data: unknown
  write: (result: FieldResult) => void
}) {
  const [name, setName] = useState('')
  const [type, setType] = useState<FieldType>('text')
  return (
    <div className={path.length > 0 ? 'ml-3 border-l border-slate-200 pl-2 dark:border-slate-700' : ''}>
      {fields.map((field) => {
        const at = [...path, field.name]
        return (
          <div key={field.name} className="flex flex-col gap-1 py-1">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="font-mono">{field.name}</span>
              {field.type === null ? (
                <span className="rounded bg-amber-100 px-1 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200">
                  edited in JSON
                </span>
              ) : (
                <>
                  <select
                    className="rounded border border-slate-300 bg-transparent px-1 dark:border-slate-600"
                    value={field.type}
                    onChange={(e) => write(setField(data, at, { type: e.target.value as FieldType, required: field.required, options: field.options }))}
                  >
                    {TYPES.map((one) => (
                      <option key={one} value={one}>
                        {one}
                      </option>
                    ))}
                  </select>
                  <label className="flex items-center gap-1">
                    <input
                      type="checkbox"
                      checked={field.required}
                      onChange={(e) => write(setField(data, at, { type: field.type!, required: e.target.checked, options: field.options }))}
                    />
                    required
                  </label>
                  {field.type === 'choice' && (
                    <input
                      className="rounded border border-slate-300 bg-transparent px-1 dark:border-slate-600"
                      defaultValue={field.options.join(', ')}
                      placeholder="option, option"
                      onBlur={(e) =>
                        write(
                          setField(data, at, {
                            type: 'choice',
                            required: field.required,
                            options: e.target.value.split(',').map((one) => one.trim()).filter(Boolean),
                          }),
                        )
                      }
                    />
                  )}
                </>
              )}
              <button type="button" className="text-rose-700 dark:text-rose-400" onClick={() => write(removeField(data, at))}>
                remove
              </button>
            </div>
            {field.type === 'group' && <Fields fields={field.fields} path={at} data={data} write={write} />}
          </div>
        )
      })}
      <div className="flex gap-2 pt-1">
        <input className={input} placeholder="new field" value={name} data-testid="field-new-name" onChange={(e) => setName(e.target.value)} />
        <select className={input} value={type} onChange={(e) => setType(e.target.value as FieldType)}>
          {TYPES.map((one) => (
            <option key={one} value={one}>
              {one}
            </option>
          ))}
        </select>
        <button
          type="button"
          className={ghost}
          data-testid="field-add"
          onClick={() => {
            write(setField(data, [...path, name.trim()], { type, required: false }))
            setName('')
          }}
        >
          Add
        </button>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Write the task fields editor, the visibility matrix and the advanced editor**

`apps/process-ui/src/web/modeler/properties/TaskFieldsEditor.tsx`:

```tsx
/** Per task: which fields this step fills in, and which must already be present. */
import { readFields, readTaskFields, writeTaskFields, type Command, type DefinitionDocument, type TransitionDocument } from '@pilots/bpmn'

export function TaskFieldsEditor({
  document,
  transition,
  run,
}: {
  document: DefinitionDocument
  transition: TransitionDocument
  run: (c: Command) => void
}) {
  const view = readTaskFields(transition)
  if (view.advanced) {
    return (
      <p className="text-xs text-amber-800 dark:text-amber-300">
        This step’s data rules use JSON Schema the form cannot show. Change them in the Advanced tab.
      </p>
    )
  }
  const names = [...new Set([...readFields(document.data).map((f) => f.name), ...view.fills.map((f) => f.name)])]
  const update = (fills: typeof view.fills, requires: string[]): void => {
    const patch = writeTaskFields(transition, document.data, { fills, requires })
    if (patch !== null) run({ type: 'updateTransition', id: transition.id, patch })
  }
  return (
    <table className="w-full text-xs" data-testid="task-fields">
      <thead>
        <tr className="text-left text-slate-500">
          <th>Field</th>
          <th>fills in</th>
          <th>required</th>
          <th>must be present</th>
        </tr>
      </thead>
      <tbody>
        {names.map((name) => {
          const fill = view.fills.find((f) => f.name === name)
          const others = view.fills.filter((f) => f.name !== name)
          return (
            <tr key={name}>
              <td className="font-mono">{name}</td>
              <td>
                <input
                  type="checkbox"
                  checked={fill !== undefined}
                  onChange={(e) => update(e.target.checked ? [...view.fills, { name, required: false }] : others, view.requires)}
                />
              </td>
              <td>
                <input
                  type="checkbox"
                  disabled={fill === undefined}
                  checked={fill?.required ?? false}
                  onChange={(e) => update(view.fills.map((f) => (f.name === name ? { name, required: e.target.checked } : f)), view.requires)}
                />
              </td>
              <td>
                <input
                  type="checkbox"
                  checked={view.requires.includes(name)}
                  onChange={(e) =>
                    update(view.fills, e.target.checked ? [...view.requires, name] : view.requires.filter((r) => r !== name))
                  }
                />
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
```

`apps/process-ui/src/web/modeler/properties/VisibilityMatrix.tsx`:

```tsx
/** Field × role. A cell is: the default, always, or only in some states. */
import { readAccess, visibilityPaths, writeAccess, type Access, type Command, type DefinitionDocument } from '@pilots/bpmn'

export function VisibilityMatrix({ document, run }: { document: DefinitionDocument; run: (c: Command) => void }) {
  const paths = visibilityPaths(document.data, document.visibility)
  const write = (path: string, role: string, access: Access): void =>
    run({ type: 'setProcess', patch: { visibility: writeAccess(document.visibility, path, role, access) } })
  return (
    <div className="flex flex-col gap-2" data-testid="visibility-matrix">
      <p className="text-xs text-slate-500">
        A field nobody is granted is {document.defaultVisibility === 'none' ? 'visible to nobody' : 'visible to everyone'}.
        The host still holds every value; this decides who may read it.
      </p>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-slate-500">
            <th>Field</th>
            {document.roles.map((role) => (
              <th key={role.id}>{role.title}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {paths.map((path) => (
            <tr key={path}>
              <td className="font-mono">{path}</td>
              {document.roles.map((role) => {
                const access = readAccess(document.visibility, path, role.id)
                return (
                  <td key={role.id} className="py-1">
                    <select
                      className="rounded border border-slate-300 bg-transparent px-1 dark:border-slate-600"
                      value={access.kind}
                      onChange={(e) => {
                        const kind = e.target.value as Access['kind']
                        write(path, role.id, kind === 'states' ? { kind, states: [document.initialState] } : { kind })
                      }}
                    >
                      <option value="default">default</option>
                      <option value="always">always</option>
                      <option value="states">in states…</option>
                    </select>
                    {access.kind === 'states' && (
                      <input
                        className="mt-1 w-full rounded border border-slate-300 bg-transparent px-1 dark:border-slate-600"
                        defaultValue={access.states.join(', ')}
                        placeholder="STATE, STATE"
                        onBlur={(e) =>
                          write(path, role.id, {
                            kind: 'states',
                            states: e.target.value.split(',').map((one) => one.trim()).filter(Boolean),
                          })
                        }
                      />
                    )}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
```

`apps/process-ui/src/web/modeler/properties/Advanced.tsx`:

```tsx
/**
 * The escape hatch: the selected element's raw JSON. Whatever the forms cannot
 * express is changed here, and judged by the linter like anything else.
 */
import { getPointer, type Command, type DefinitionDocument } from '@pilots/bpmn'
import { useEffect, useState } from 'react'

import { ghost, input } from '../../ui.js'

export function Advanced({ document, pointer, run }: { document: DefinitionDocument; pointer: string; run: (c: Command) => void }) {
  const current = JSON.stringify(getPointer(document, pointer), null, 2)
  const [text, setText] = useState(current)
  const [problem, setProblem] = useState<string | null>(null)
  useEffect(() => setText(current), [current])
  return (
    <div className="flex flex-col gap-1">
      <textarea
        className={`${input} h-48 font-mono text-[11px]`}
        data-testid="advanced-json"
        spellCheck={false}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      {problem !== null && <p className="text-xs text-rose-700 dark:text-rose-400">{problem}</p>}
      <button
        type="button"
        className={ghost}
        data-testid="advanced-apply"
        onClick={() => {
          try {
            run({ type: 'setFragment', pointer, value: JSON.parse(text) })
            setProblem(null)
          } catch (cause) {
            setProblem((cause as Error).message)
          }
        }}
      >
        Apply JSON
      </button>
    </div>
  )
}
```

- [ ] **Step 5: Write the element panels**

`apps/process-ui/src/web/modeler/properties/ElementPanels.tsx`:

```tsx
/** One panel per kind of element: a role, a state, a task (a transition), a link. */
import { ANY_STATE, pointerOf, type Command, type DefinitionDocument } from '@pilots/bpmn'

import { ghost, input } from '../../ui.js'
import { Labelled, TextField } from '../fields.js'
import { Advanced } from './Advanced.js'
import { TaskFieldsEditor } from './TaskFieldsEditor.js'

interface Props {
  document: DefinitionDocument
  run: (command: Command) => void
}

const removeButton = (label: string, act: () => void) => (
  <button type="button" className={`${ghost} text-rose-700 dark:text-rose-400`} data-testid="remove-element" onClick={act}>
    {label}
  </button>
)

export function RolePanel({ document, id, run }: Props & { id: string }) {
  const role = document.roles.find((one) => one.id === id)
  if (role === undefined) return null
  return (
    <>
      <h3 className="font-semibold">Lane</h3>
      <TextField label="Id" value={role.id} testid="role-id" onCommit={(to) => run({ type: 'rename', kind: 'role', from: id, to })} />
      <TextField label="Title" value={role.title} testid="role-title" onCommit={(title) => run({ type: 'updateRole', id, patch: { title } })} />
      <Labelled label="How many participants fill it">
        <input
          className={input}
          type="number"
          min={1}
          defaultValue={role.cardinality ?? 1}
          onBlur={(e) => run({ type: 'updateRole', id, patch: { cardinality: Math.max(1, Number(e.target.value) || 1) } })}
        />
      </Labelled>
      <Labelled label="Part it plays">
        <select
          className={input}
          value={role.protocolRole ?? ''}
          onChange={(e) =>
            run({ type: 'updateRole', id, patch: { protocolRole: e.target.value === '' ? undefined : (e.target.value as 'requester' | 'provider' | 'observer') } })
          }
        >
          <option value="">—</option>
          <option value="requester">requester</option>
          <option value="provider">provider</option>
          <option value="observer">observer</option>
        </select>
      </Labelled>
      {removeButton('Remove lane', () => run({ type: 'remove', kind: 'role', id }))}
    </>
  )
}

export function StatePanel({ document, id, run }: Props & { id: string }) {
  const state = document.states.find((one) => one.id === id)
  if (state === undefined) return null
  return (
    <>
      <h3 className="font-semibold">State</h3>
      <TextField label="Id" value={state.id} testid="state-id" onCommit={(to) => run({ type: 'rename', kind: 'state', from: id, to })} />
      <TextField label="Title" value={state.title} testid="state-title" onCommit={(title) => run({ type: 'updateState', id, patch: { title } })} />
      <TextField
        label="Description"
        value={state.description ?? ''}
        onCommit={(text) => run({ type: 'updateState', id, patch: { description: text === '' ? undefined : text } })}
      />
      <Labelled label="Ends the process">
        <select
          className={input}
          data-testid="state-outcome"
          value={state.outcome ?? ''}
          onChange={(e) =>
            run({ type: 'updateState', id, patch: { outcome: e.target.value === '' ? undefined : (e.target.value as 'fulfilled' | 'abandoned') } })
          }
        >
          <option value="">no — the process continues</option>
          <option value="fulfilled">yes — fulfilled</option>
          <option value="abandoned">yes — abandoned</option>
        </select>
      </Labelled>
      {removeButton('Remove state', () => run({ type: 'remove', kind: 'state', id }))}
    </>
  )
}

export function TaskPanel({ document, id, run }: Props & { id: string }) {
  const transition = document.transitions.find((one) => one.id === id)
  if (transition === undefined) return null
  const update = (patch: Extract<Command, { type: 'updateTransition' }>['patch']): void =>
    run({ type: 'updateTransition', id, patch })
  const wildcard = transition.from.includes(ANY_STATE)
  const pointer = pointerOf(document, { kind: 'transition', id })
  return (
    <>
      <h3 className="font-semibold">Task</h3>
      <TextField label="Id" value={transition.id} testid="task-id" onCommit={(to) => run({ type: 'rename', kind: 'transition', from: id, to })} />
      <TextField label="Title" value={transition.title} testid="task-title" onCommit={(title) => update({ title })} />
      <Labelled label="May happen in">
        <div className="flex flex-col gap-1 text-xs">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={wildcard} onChange={(e) => update({ from: e.target.checked ? [ANY_STATE] : [document.initialState] })} />
            any state that has not ended
          </label>
          {!wildcard &&
            document.states.map((state) => (
              <label key={state.id} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={transition.from.includes(state.id)}
                  onChange={(e) => {
                    const next = e.target.checked ? [...transition.from, state.id] : transition.from.filter((s) => s !== state.id)
                    if (next.length > 0) update({ from: next })
                  }}
                />
                {state.title}
              </label>
            ))}
        </div>
      </Labelled>
      <Labelled label="Leads to">
        <select className={input} value={transition.to ?? ''} onChange={(e) => update({ to: e.target.value === '' ? undefined : e.target.value })}>
          <option value="">stays — a data update</option>
          {document.states.map((state) => (
            <option key={state.id} value={state.id}>
              {state.title}
            </option>
          ))}
        </select>
      </Labelled>
      <Labelled label="Done by (none: only the connector, on a timer or message)">
        <div className="flex flex-col gap-1 text-xs">
          {document.roles.map((role) => (
            <label key={role.id} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={transition.by.includes(role.id)}
                onChange={(e) => update({ by: e.target.checked ? [...transition.by, role.id] : transition.by.filter((r) => r !== role.id) })}
              />
              {role.title}
            </label>
          ))}
        </div>
      </Labelled>
      <label className="flex items-center gap-2 text-xs">
        <input type="checkbox" checked={transition.auto === true} onChange={(e) => update({ auto: e.target.checked ? true : undefined })} />
        happens automatically as soon as it can
      </label>
      <label className="flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={transition.attachments?.required === true}
          onChange={(e) => {
            const rest = { ...(transition.attachments ?? { required: false }) }
            const attachments = { ...rest, required: e.target.checked }
            const onlyFlag = Object.keys(attachments).length === 1
            update({ attachments: !e.target.checked && onlyFlag ? undefined : attachments })
          }}
        />
        requires a document
      </label>
      <Deadline document={document} id={id} run={run} />
      <h4 className="pt-2 text-xs font-semibold">Data in this step</h4>
      <TaskFieldsEditor document={document} transition={transition} run={run} />
      {pointer !== null && (
        <details>
          <summary className="cursor-pointer text-xs text-slate-500">Advanced (JSON)</summary>
          <Advanced document={document} pointer={pointer} run={run} />
        </details>
      )}
      {removeButton('Remove task', () => run({ type: 'remove', kind: 'transition', id }))}
    </>
  )
}

function Deadline({ document, id, run }: Props & { id: string }) {
  const transition = document.transitions.find((one) => one.id === id)
  if (transition === undefined || transition.to === undefined) return null
  return (
    <div className="flex flex-col gap-1 rounded border border-slate-200 p-2 text-xs dark:border-slate-700">
      <span className="font-medium">Timer on {transition.to}</span>
      {transition.deadline === undefined ? (
        <span className="text-slate-500">None. Add one from the palette.</span>
      ) : (
        <>
          <TextField
            label="Duration"
            value={transition.deadline}
            onCommit={(deadline) => run({ type: 'setDeadline', transition: id, deadline, onDeadline: transition.onDeadline ?? id })}
          />
          <Labelled label="Then fires">
            <select
              className={input}
              value={transition.onDeadline ?? ''}
              onChange={(e) => run({ type: 'setDeadline', transition: id, deadline: transition.deadline!, onDeadline: e.target.value })}
            >
              {document.transitions.map((one) => (
                <option key={one.id} value={one.id}>
                  {one.title}
                </option>
              ))}
            </select>
          </Labelled>
          <button type="button" className={ghost} onClick={() => run({ type: 'clearDeadline', transition: id })}>
            Remove timer
          </button>
        </>
      )}
    </div>
  )
}

export function LinkPanel({ document, index, run }: Props & { index: number }) {
  const link = (document.links ?? [])[index]
  if (link === undefined) return null
  return (
    <>
      <h3 className="font-semibold">Message</h3>
      <TextField
        label="Event in the linked instance"
        value={link.onEvent}
        placeholder="relation:STATE"
        onCommit={(onEvent) => run({ type: 'setFragment', pointer: `/links/${index}/onEvent`, value: onEvent })}
      />
      <Labelled label="Then fires">
        <select
          className={input}
          value={link.triggers}
          onChange={(e) => run({ type: 'setFragment', pointer: `/links/${index}/triggers`, value: e.target.value })}
        >
          {document.transitions.map((one) => (
            <option key={one.id} value={one.id}>
              {one.title}
            </option>
          ))}
        </select>
      </Labelled>
      {removeButton('Remove message', () => run({ type: 'removeLink', index }))}
    </>
  )
}
```

- [ ] **Step 6: Verify**

```bash
pnpm typecheck && pnpm lint && pnpm test
```

Stop and tell the supervisor the task is ready to review and commit.

---

### Task 14: Process UI — the Modeler, mounted in Authoring

**Files:**
- Create: `apps/process-ui/src/web/modeler/Modeler.tsx`
- Modify: `apps/process-ui/src/web/views/Authoring.tsx` (replace the component body; keep `STARTER` and
  the "Processes this connector holds" card)

**Interfaces:**
- Consumes: everything from Tasks 10–13; `toDiagram`, `withLayout`, `targetOf`, `applyCommand`,
  `bumpVersion` from `@pilots/bpmn`; `api`, `UiError`, `DefinitionDiagnostic` from `../api.js`.
- Produces: `Modeler({ draft, dispatch, flagged })`; Authoring test ids `authoring-tab-diagram`,
  `authoring-tab-json`, `new-process`, `open-ref`, `open-definition`, `read-only`, `new-version`, `undo`,
  `redo`, `publish-next`, `storage-warning`, `lint-unavailable` — plus the existing `definition-source`,
  `diagnostics`, `publish`, `published`, `import`.

- [ ] **Step 1: Write the Modeler**

`apps/process-ui/src/web/modeler/Modeler.tsx`:

```tsx
/**
 * The Diagram tab: palette, canvas, properties, and the one place a refused
 * command is explained — with "remove with dependents" offered when that is
 * what the refusal was about (B6).
 */
import { toDiagram, withLayout, type Command } from '@pilots/bpmn'
import { useMemo, useState } from 'react'

import { ghost } from '../ui.js'
import { Canvas } from './Canvas.js'
import type { DraftAction, DraftState } from './draft.js'
import { NewElement, type Pending } from './NewElement.js'
import { Palette } from './Palette.js'
import { Properties } from './Properties.js'

export function Modeler({
  draft,
  dispatch,
  flagged,
}: {
  draft: DraftState
  dispatch: (action: DraftAction) => void
  flagged: ReadonlySet<string>
}) {
  const model = useMemo(() => toDiagram(draft.document), [draft.document])
  const layout = useMemo(() => withLayout(model, draft.layout), [model, draft.layout])
  const [selected, setSelected] = useState<string | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const run = (command: Command): void => dispatch({ type: 'command', command })
  const failure = draft.failure

  return (
    <div className="flex flex-col gap-3" data-testid="modeler">
      {!draft.readOnly && <Palette document={draft.document} run={run} onAsk={setPending} />}
      {pending !== null && !draft.readOnly && (
        <NewElement pending={pending} document={draft.document} run={run} onClose={() => setPending(null)} />
      )}

      {failure !== null && (
        <div data-testid="command-problem" className="rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-xs text-rose-900 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-300">
          <p>{failure.error.message}</p>
          {failure.error.dependents !== undefined && (
            <ul className="ml-4 list-disc">
              {failure.error.dependents.map((one) => (
                <li key={one}>{one}</li>
              ))}
            </ul>
          )}
          <div className="mt-2 flex gap-2">
            {failure.error.code === 'has-dependents' && failure.command.type === 'remove' && (
              <button
                type="button"
                className={ghost}
                data-testid="remove-with-dependents"
                onClick={() => {
                  if (failure.command.type === 'remove') run({ ...failure.command, cascade: true })
                }}
              >
                Remove with dependents
              </button>
            )}
            <button type="button" className={ghost} onClick={() => dispatch({ type: 'dismiss' })}>
              Dismiss
            </button>
          </div>
        </div>
      )}

      <div className="grid gap-3 lg:grid-cols-[1fr_22rem]">
        <Canvas
          model={model}
          layout={layout}
          flagged={flagged}
          readOnly={draft.readOnly}
          onMove={(key, x, y) => dispatch({ type: 'move', key, x, y })}
          onMoveTask={(change) => run({ type: 'moveTask', ...change })}
          onConnectStates={(from, to) => setPending({ kind: 'task', from, to })}
          onSelect={setSelected}
        />
        <Properties document={draft.document} model={model} selected={selected} readOnly={draft.readOnly} run={run} />
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Rewrite Authoring around one draft**

In `apps/process-ui/src/web/views/Authoring.tsx`:

1. Update the header comment's second paragraph to say the canvas has arrived: the Diagram tab edits the
   same document through commands (`@pilots/bpmn`), and the JSON tab remains for anything else.
2. Replace the imports with:

```tsx
import { applyCommand, bumpVersion, targetOf, toDiagram, type DefinitionDocument } from '@pilots/bpmn'
import { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import { UiError, api } from '../api.js'
import { StateDiagram } from '../graph/StateDiagram.js'
import { draftReducer, initialDraft } from '../modeler/draft.js'
import { Modeler } from '../modeler/Modeler.js'
import { browserStorage, loadDraft, loadLayout, saveDraft, saveLayout } from '../modeler/storage.js'
import { keys, queries } from '../queries.js'
import { Card, Problem, button, ghost, input } from '../ui.js'
```

3. Type `STARTER` as `const STARTER: DefinitionDocument = { … }` (content unchanged), and add below it:

```tsx
/** An empty canvas. Not a valid process yet — a draft may be incomplete; only publishing is blocked. */
const BLANK: DefinitionDocument = {
  '@context': 'https://pilots.example/process/v1',
  id: 'new-process',
  version: '1.0.0',
  kind: 'service',
  title: 'New process',
  roles: [],
  hostedBy: '',
  initialState: '',
  states: [],
  defaultVisibility: 'all',
  data: { type: 'object' },
  transitions: [],
  visibility: [],
  links: [],
}
```

Keep the `Drawable` interface (the JSON tab's `StateDiagram` still uses it).

4. Replace the `Authoring` function with:

```tsx
export function Authoring() {
  const storage = useMemo(() => browserStorage(), [])
  const [draft, dispatch] = useReducer(draftReducer, undefined, () =>
    initialDraft(loadDraft(storage) ?? { document: STARTER, layout: {} }),
  )
  const [tab, setTab] = useState<'diagram' | 'json'>('diagram')
  const [source, setSource] = useState(() => JSON.stringify(draft.document, null, 2))
  const [syntax, setSyntax] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const [lintFailed, setLintFailed] = useState(false)
  const [published, setPublished] = useState<string | null>(null)
  const [error, setError] = useState<UiError | null>(null)
  const [conflict, setConflict] = useState<string | null>(null)
  const [opening, setOpening] = useState('')
  const fileInput = useRef<HTMLInputElement>(null)
  const client = useQueryClient()

  const definitions = useQuery(queries.definitions()).data ?? []

  // The text follows the document — except when the text is what changed it,
  // or the cursor would jump on every keystroke.
  useEffect(() => {
    if (draft.origin === 'json') return
    setSource(JSON.stringify(draft.document, null, 2))
    setSyntax(null)
    // Keyed on the revision alone: it is what changes exactly once per edit.
  }, [draft.revision])

  useEffect(() => {
    if (storage !== null) saveDraft(storage, { document: draft.document, layout: draft.layout })
  }, [storage, draft.document, draft.layout])

  /*
   * Lint on a debounce, tagged with the revision it was asked about. The
   * reducer drops an answer for any other revision, so a slow linter cannot
   * paint old errors over a newer drawing.
   */
  useEffect(() => {
    const revision = draft.revision
    const timer = setTimeout(() => {
      setChecking(true)
      void api
        .lintDefinition(draft.document as unknown as Record<string, unknown>)
        .then((result) => {
          dispatch({ type: 'linted', revision, diagnostics: result.diagnostics })
          setLintFailed(false)
        })
        .catch(() => setLintFailed(true))
        .finally(() => setChecking(false))
    }, 300)
    return () => clearTimeout(timer)
  }, [draft.revision, draft.document])

  const settled = draft.diagnostics.revision === draft.revision
  const diagnostics = settled ? draft.diagnostics.items : []
  const errors = diagnostics.filter((one) => one.severity === 'error')
  const warnings = diagnostics.filter((one) => one.severity === 'warning')
  const publishable = !draft.readOnly && syntax === null && settled && !lintFailed && errors.length === 0

  const model = useMemo(() => toDiagram(draft.document), [draft.document])
  const flagged = useMemo(
    () =>
      new Set(
        diagnostics.flatMap((one) => {
          const target = targetOf(draft.document, model, one.path)
          return target.kind === 'process' ? [] : [target.key]
        }),
      ),
    [diagnostics, draft.document, model],
  )

  const publish = (document: DefinitionDocument = draft.document): void => {
    setError(null)
    setPublished(null)
    setConflict(null)
    void api
      .publishDefinition(document as unknown as Record<string, unknown>)
      .then(async (result) => {
        setPublished(result.ref)
        if (storage !== null) saveLayout(storage, result.ref, draft.layout)
        await client.invalidateQueries({ queryKey: keys.definitions })
      })
      .catch((cause: unknown) => {
        if (!(cause instanceof UiError)) return
        // Same id@version, different bytes: a published definition never changes,
        // so the answer is the next version, offered in one click.
        if (cause.problem.type?.endsWith('definition-conflict') === true) {
          setConflict(bumpVersion(document.version))
          return
        }
        setError(cause)
      })
  }

  const publishAsNext = (): void => {
    if (conflict === null) return
    const command = { type: 'setProcess' as const, patch: { version: conflict } }
    const bumped = applyCommand(draft.document, command)
    if (!bumped.ok) return
    dispatch({ type: 'command', command })
    publish(bumped.document)
  }

  const open = (ref: string): void => {
    void api.definition(ref).then((result) => {
      dispatch({
        type: 'replace',
        document: result.definition as unknown as DefinitionDocument,
        origin: 'open',
        readOnly: true,
        layout: storage === null ? {} : loadLayout(storage, ref),
      })
      setPublished(null)
      setConflict(null)
    })
  }

  const typed = (text: string): void => {
    setSource(text)
    setPublished(null)
    try {
      const value: unknown = JSON.parse(text)
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        setSyntax('A definition is a JSON object.')
        return
      }
      setSyntax(null)
      dispatch({ type: 'replace', document: value as DefinitionDocument, origin: 'json' })
    } catch (cause) {
      setSyntax((cause as Error).message)
    }
  }

  const importFile = (file: File): void => {
    void file.text().then((text) => {
      setTab('json')
      typed(text)
    })
  }

  const download = (): void => {
    const blob = new Blob([JSON.stringify(draft.document, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${draft.document.id || 'definition'}.json`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  const parsed = syntax === null ? (draft.document as unknown as Drawable) : null
  const tabClass = (one: 'diagram' | 'json'): string =>
    one === tab ? 'border-b-2 border-slate-900 pb-1 font-semibold dark:border-slate-100' : 'pb-1 text-slate-500'

  return (
    <div className="flex flex-col gap-4">
      <Card title="Write a process">
        <div className="flex flex-col gap-3">
          <p className="text-xs text-slate-600 dark:text-slate-400">
            Draw it or write it — both tabs edit the same definition. The connector validates it as you go, with the
            same linter it applies to a definition a peer sends. A published definition never changes: to alter
            one, start a new version.
          </p>

          <div className="flex flex-wrap items-end gap-2">
            <select className={`${input} w-auto`} data-testid="open-ref" value={opening} onChange={(e) => setOpening(e.target.value)}>
              <option value="">Open a published process…</option>
              {definitions.map((one) => (
                <option key={one.ref} value={one.ref}>
                  {one.ref}
                </option>
              ))}
            </select>
            <button type="button" className={ghost} data-testid="open-definition" disabled={opening === ''} onClick={() => open(opening)}>
              Open
            </button>
            <button
              type="button"
              className={ghost}
              data-testid="new-process"
              onClick={() => dispatch({ type: 'replace', document: BLANK, origin: 'open', layout: {} })}
            >
              New process
            </button>
            <button type="button" className={ghost} data-testid="undo" disabled={draft.past.length === 0} onClick={() => dispatch({ type: 'undo' })}>
              Undo
            </button>
            <button type="button" className={ghost} data-testid="redo" disabled={draft.future.length === 0} onClick={() => dispatch({ type: 'redo' })}>
              Redo
            </button>
          </div>

          {draft.readOnly && (
            <p data-testid="read-only" className="flex items-center gap-2 rounded-md border border-sky-300 bg-sky-50 px-3 py-2 text-xs text-sky-900 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-300">
              {draft.document.id}@{draft.document.version} is published and read-only.
              <button type="button" className={ghost} data-testid="new-version" onClick={() => dispatch({ type: 'newVersion' })}>
                New version
              </button>
            </p>
          )}
          {storage === null && (
            <p data-testid="storage-warning" className="text-xs text-amber-700 dark:text-amber-400">
              This browser will not keep the draft: it is lost on reload.
            </p>
          )}
          {lintFailed && (
            <p data-testid="lint-unavailable" className="text-xs text-amber-700 dark:text-amber-400">
              Cannot validate — the connector did not answer. Publishing waits until it does.
            </p>
          )}

          <div className="flex gap-4 text-sm">
            <button type="button" data-testid="authoring-tab-diagram" className={tabClass('diagram')} onClick={() => setTab('diagram')}>
              Diagram
            </button>
            <button type="button" data-testid="authoring-tab-json" className={tabClass('json')} onClick={() => setTab('json')}>
              JSON
            </button>
          </div>

          {tab === 'diagram' ? (
            <Modeler draft={draft} dispatch={dispatch} flagged={flagged} />
          ) : (
            <div className="grid gap-3 lg:grid-cols-2">
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-slate-600">Definition (JSON)</span>
                <textarea
                  className={`${input} h-96 font-mono text-xs`}
                  data-testid="definition-source"
                  spellCheck={false}
                  readOnly={draft.readOnly}
                  value={source}
                  onChange={(event) => typed(event.target.value)}
                />
              </label>
              <div className="flex flex-col gap-2">
                <span className="text-xs font-medium text-slate-600">The process it describes</span>
                {parsed === null ? (
                  <div className="flex h-96 items-center justify-center rounded-md border border-dashed border-slate-300 p-4 text-center text-xs text-slate-500 dark:border-slate-700">
                    Not valid JSON yet — the diagram appears as soon as it parses.
                  </div>
                ) : (
                  <StateDiagram definition={parsed} height="h-96" />
                )}
              </div>
            </div>
          )}

          <div data-testid="diagnostics" className="flex flex-col gap-2">
            {syntax !== null && (
              <p className="rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-xs text-rose-900 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-300">
                {syntax}
              </p>
            )}
            {syntax === null && settled && diagnostics.length === 0 && !checking && (
              <p className="text-xs text-emerald-700 dark:text-emerald-400">
                No problems. This process can be started and can be completed.
              </p>
            )}
            {/* Errors first: they are what stops a publish. */}
            {[...errors, ...warnings].map((diagnostic, index) => (
              <p
                key={`${diagnostic.code}-${diagnostic.path ?? index}`}
                className={
                  diagnostic.severity === 'error'
                    ? 'rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-xs text-rose-900 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-300'
                    : 'rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300'
                }
              >
                <span className="font-mono">{diagnostic.code}</span> — {diagnostic.message}
                {diagnostic.path !== undefined && <span className="ml-1 font-mono text-slate-500">{diagnostic.path}</span>}
              </p>
            ))}
          </div>

          {error && <Problem error={error} />}
          {conflict !== null && (
            <p className="flex items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
              {draft.document.id}@{draft.document.version} is already published with different content.
              <button type="button" className={ghost} data-testid="publish-next" onClick={publishAsNext}>
                Publish as {conflict}
              </button>
            </p>
          )}
          {published !== null && (
            <p
              data-testid="published"
              className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-xs text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300"
            >
              Published <span className="font-mono">{published}</span>. It is ready to start, and a peer will be asked
              to adopt it the first time you run it with them.
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            <button className={button} type="button" data-testid="publish" disabled={!publishable} onClick={() => publish()}>
              Publish
            </button>
            <button className={ghost} type="button" onClick={() => fileInput.current?.click()}>
              Import a file
            </button>
            <button className={ghost} type="button" onClick={download}>
              Download
            </button>
            <input
              ref={fileInput}
              type="file"
              accept="application/json,.json"
              className="hidden"
              data-testid="import"
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (file) importFile(file)
              }}
            />
          </div>
        </div>
      </Card>

      {/* Keep the existing "Processes this connector holds" card here, unchanged. */}
    </div>
  )
}
```

Move the existing "Processes this connector holds" `<Card>` (unchanged) into the place of the final
comment. (This repo runs no `react-hooks` ESLint plugin, so do not add `eslint-disable` comments for its
rules: ESLint would report the unknown rule as an error.)

- [ ] **Step 3: Run it and look at it**

```bash
pnpm --filter @pilots/protocol build && pnpm --filter @pilots/bpmn build
pnpm demo:env && docker compose up -d org-a org-b   # connectors only
pnpm --filter @pilots/process-ui dev & pnpm --filter @pilots/process-ui dev:web
```

Open `http://localhost:5175`, sign in as in `README.md#running-the-demo`, open **Authoring**, and check
by hand:

- The Diagram tab shows the starter as two lanes, a start, tasks, end events, and the wildcard `cancel`
  marked ✱.
- Dragging a task into the other lane moves it, and the JSON tab shows its `by` changed.
- Drawing an arrow from one state to another opens "New task".
- Removing a state with tasks attached shows the dependents and a **Remove with dependents** button.
- Opening `container-transport-quotation@1.0.0` shows the 24h timer racing Accept/Counter behind a
  gateway, and the page says read-only.
- Diagnostics outline the node at fault (create an unreachable state to see it).

Stop the dev servers and `docker compose down` afterwards.

- [ ] **Step 4: Verify**

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

Stop and tell the supervisor the task is ready to review and commit.

---

### Task 15: End-to-end specs

**Files:**
- Create: `tests/e2e/modeler.spec.ts`
- Modify: `tests/e2e/process-ui.spec.ts` (one line: switch to the JSON tab before typing JSON)

**Interfaces:**
- Consumes: the test ids listed in Task 14 and Tasks 12–13 (`palette-*`, `new-task-*`, `new-timer-*`,
  `new-element-submit`, `process-id`, `process-hostedBy`, `process-initialState`, `state-title`,
  `[data-node="…"]`).

- [ ] **Step 1: Keep the existing authoring spec working**

In `tests/e2e/process-ui.spec.ts`, directly after
`await page.getByTestId('tab-authoring').click()` in the "is written in the browser…" test, add:

```ts
    // The Diagram tab opens first now; this test is about the JSON route.
    await page.getByTestId('authoring-tab-json').click()
```

- [ ] **Step 2: Write the modeler spec**

`tests/e2e/modeler.spec.ts`:

```ts
/**
 * The modeler, in a browser, against the running demo.
 *
 * Wiring and UI only: that gestures on the canvas become a definition the
 * connector accepts, and that the JSON tab shows the same document the diagram
 * edits. That an editor-made process *runs* is proven in the scenario tier
 * (`apps/connector/test/drawn-process.test.ts`), in milliseconds.
 *
 * Prerequisite: `docker compose up`.
 */
import { expect, test, type Page } from '@playwright/test'

const ORG_A = { email: 'alice@org-a.example', password: 'OrgA_123' }

async function signIn(page: Page): Promise<void> {
  await page.goto('/')
  await page.fill('input[name="email"]', ORG_A.email)
  await page.fill('input[name="password"]', ORG_A.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByTestId('participant')).toBeVisible()
  await page.getByTestId('tab-authoring').click()
}

async function addTask(page: Page, title: string, lane: string, from: string, to: string): Promise<void> {
  await page.getByTestId('palette-task').click()
  await page.fill('[data-testid="new-task-title"]', title)
  await page.selectOption('[data-testid="new-task-lane"]', lane)
  await page.selectOption('[data-testid="new-task-from"]', from)
  await page.selectOption('[data-testid="new-task-to"]', to)
  await page.getByTestId('new-element-submit').click()
}

test('a two-lane process is drawn from a blank canvas and published', async ({ page }) => {
  await signIn(page)
  await page.getByTestId('authoring-tab-diagram').click()
  await page.getByTestId('new-process').click()

  await page.getByTestId('palette-lane').click() // role
  await page.getByTestId('palette-lane').click() // role2
  await page.getByTestId('palette-state').click() // STATE
  await page.getByTestId('palette-state').click() // STATE2
  await page.getByTestId('palette-end-fulfilled').click() // DONE

  const id = `e2e-drawn-${Date.now()}`
  await page.fill('[data-testid="process-id"]', id)
  await page.press('[data-testid="process-id"]', 'Tab')
  await page.selectOption('[data-testid="process-initialState"]', 'STATE')
  await page.selectOption('[data-testid="process-hostedBy"]', 'role')

  await addTask(page, 'Begin', 'role', 'STATE', 'STATE2')
  await addTask(page, 'Finish', 'role2', 'STATE2', 'DONE')

  await page.getByTestId('palette-timer').click()
  await page.selectOption('[data-testid="new-timer-arming"]', 'begin')
  await page.fill('[data-testid="new-timer-duration"]', 'PT1H')
  await page.selectOption('[data-testid="new-timer-target"]', 'finish')
  await page.getByTestId('new-element-submit').click()

  await expect(page.locator('[data-node="timer:begin"]')).toBeVisible()
  // Enabled means linted, current and free of errors. Not "No problems": a
  // warning would hide that line without making the process unpublishable.
  await expect(page.getByTestId('publish')).toBeEnabled()
  await page.getByTestId('publish').click()
  await expect(page.getByTestId('published')).toContainText(`${id}@1.0.0`)
})

test('an example opens read-only, the JSON tab shows the same document, and an edit shows in both', async ({ page }) => {
  await signIn(page)
  const ref = 'container-weighing@1.0.0'
  await page.selectOption('[data-testid="open-ref"]', ref)
  await page.getByTestId('open-definition').click()
  await expect(page.getByTestId('read-only')).toBeVisible()

  await page.getByTestId('authoring-tab-json').click()
  const shown: unknown = JSON.parse(await page.getByTestId('definition-source').inputValue())
  const served = (await (await page.request.get(`/api/ui/definitions/${encodeURIComponent(ref)}`)).json()) as {
    definition: unknown
  }
  expect(shown).toEqual(served.definition)

  await page.getByTestId('authoring-tab-diagram').click()
  await page.getByTestId('new-version').click()
  await page.locator('[data-node="state:ORDERED"]').click()
  await page.fill('[data-testid="state-title"]', 'Ordered — edited')
  await page.press('[data-testid="state-title"]', 'Tab')

  await page.getByTestId('authoring-tab-json').click()
  const edited = JSON.parse(await page.getByTestId('definition-source').inputValue()) as {
    version: string
    states: { id: string; title: string }[]
  }
  expect(edited.version).toBe('1.0.1')
  expect(edited.states.find((s) => s.id === 'ORDERED')?.title).toBe('Ordered — edited')
})
```

- [ ] **Step 3: Run the e2e suite against the stack**

```bash
pnpm demo:env
docker compose build && docker compose up -d
pnpm test:e2e
docker compose down
```

Expected: 17 specs pass (15 existing + 2 new). If `docker compose build` fails on the process-ui image,
check that Task 10's Dockerfile change is present.

- [ ] **Step 4: Verify**

```bash
pnpm typecheck && pnpm lint && pnpm test
```

Stop and tell the supervisor the task is ready to review and commit.

---

### Task 16: Documentation

**Files:**
- Modify: `CLAUDE.md`, `docs/DEFINITIONS.md`
- Modify: `docs/superpowers/specs/2026-11-17-bpmn-modeler-design.md` (status line only)

- [ ] **Step 1: Update CLAUDE.md**

- In **Stack and structure**, add under `packages/client/`:

```
  packages/bpmn/         A definition as a BPMN-style diagram (`toDiagram`) and every edit as a
                         command on the definition (`applyCommand`). Pure, browser-safe: the
                         protocol and zod are type-only imports. Never parsed back, so lossless.
```

  and under `apps/process-ui/src/web/`:

```
      modeler/           The Diagram tab: palette, canvas, properties panel, over one draft
                         shared with the JSON tab. Drafts and layout stay in the browser.
```

- In the **Boundary rule** paragraph, add: `apps/process-ui` may also import `packages/bpmn`, which may
  import only `packages/protocol`; connector **tests** may import `packages/bpmn`, the connector itself may
  not.
- In **Available commands**, under `pnpm --filter @pilots/process-ui dev:web`, add:

```bash
pnpm --filter @pilots/bpmn build             # once, before dev:web — the SPA imports its build
```

- Update the test counts in **Current status** to the numbers `pnpm test` and `pnpm test:e2e` actually
  report (do not estimate them).
- Add `docs/superpowers/specs/2026-11-17-bpmn-modeler-design.md` to **Key documents**' specs line if it
  lists specs individually; it currently links the directory, so no change is needed there.

- [ ] **Step 2: Update DEFINITIONS.md**

After the paragraph that introduces `pnpm lint:definitions` in §1-area ("Check a definition with"), add:

```markdown
A definition can also be **drawn**: the process UI's Authoring view has a Diagram tab that shows it in
BPMN notation — roles as lanes, transitions as tasks, states as events, deadlines as timers, links as
messages — and turns every gesture into an edit of this same document
([design](superpowers/specs/2026-11-17-bpmn-modeler-design.md)). The JSON stays the source of truth; the
diagram never adds anything to it, and its layout is kept outside it so it cannot change the hash.
```

- [ ] **Step 3: Mark the spec implemented**

In `docs/superpowers/specs/2026-11-17-bpmn-modeler-design.md`, change
`Status: **accepted**, not yet implemented.` to `Status: **accepted**, implemented.`

- [ ] **Step 4: Verify**

```bash
pnpm typecheck && pnpm lint && pnpm test
```

Stop and tell the supervisor the work is complete and ready for review and commit. Remind them of the
spec's two open questions (milestone placement; layout persistence beyond the browser), which this plan
deliberately did not decide.
