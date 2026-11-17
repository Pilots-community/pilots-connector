# BPMN modeler: drawing a shared process, losslessly

*Design decision record. 2026-11-17. Sub-project 1 of the BPMN track. Affects a new `packages/bpmn` and
`apps/process-ui`. The connector, the protocol and the client are **unchanged**. M7 stays
event-triggered.*

Status: **accepted**, not yet implemented.

Decisions are numbered `B1…` to avoid colliding with the `D`, `P` and `F` series in the earlier records.

---

## 1. What prompted this

Definitions can be authored at runtime since M6.5, but only as JSON. The people who agree a process
between companies — PMs, analysts, operations — read BPMN, not JSON Schema. The supervisor asked for a
module that lets a user **build a multi-participant process in BPMN notation** and produces the
definition the connector runs, with a deliberately restricted palette, extended where BPMN has no home
for what the connector needs.

Behind it sits a larger direction (§9): a process space where different TMS and back-office systems talk
to each other **without code**. The shared definition is the agreed understanding of the process, the
events and the data exchanged; each participant later adds private tasks that fetch from or write to
their own systems. This record designs only the first step, and constrains it so the later steps slot in.

---

## 2. B1 — BPMN is a notation, not an interchange format

**Decision.** We draw **BPMN-style** shapes on `@xyflow/react`. There is no BPMN XML import or export,
and no `bpmn-js`.

The supervisor's answer to "what must BPMN buy us" was **familiar notation**, not interchange with
Camunda, Signavio or bpmn.io files. That settles the library: React Flow is already a dependency (MIT),
chosen in [P7](2026-09-03-process-ui-iteration-design.md#5-the-diagram--chosen-for-the-editor-that-is-coming)
precisely because the viewer would become an editor.

**Relation to the earlier rejection.** [§5.1 of the 2026-09-03 record](2026-09-03-process-ui-iteration-design.md#51-why-the-first-recommendation-was-wrong)
rejected `bpmn-js` for its licence (logo attribution) and for a lossy mapping, concluding that "the
definition, not the drawing, is the spec". This record **refines** that decision rather than reversing
it: no `bpmn-js`, so no licence question; and the definition remains the only source of truth (B2), so
the mapping cannot be lossy. What changes is only that the editor's shapes are BPMN's.

---

## 3. B2 — the diagram is a projection; edits are commands

**Decision.** The definition is the only source of truth. The diagram is derived from it and is
**never parsed back**.

```
toDiagram(definition, layout?) → DiagramModel                       pure
applyCommand(definition, command) → Result<definition, CommandError> pure
```

"BPMN → JSON" by interpreting a drawing is exactly where a mapping becomes ambiguous: the same
definition can be drawn many ways, and a drawing has nowhere to keep a state's id. With commands, every
gesture is a typed change to the definition (`addTask`, `moveTask`, `addState`, `setOutcome`,
`setDeadline`, `rename`, `remove`, …), the result is re-projected, and **round-trip is lossless by
construction**. The supervisor chose round-trip explicitly: any definition — the five examples, one
written as JSON, one adopted from a peer — opens in the diagram.

**Rejected:** free BPMN compiled to states (approach B — ambiguous on the way back, so no round-trip);
an editable state diagram with lanes (approach C — least work, but not the notation asked for).

---

## 4. B3 — the projection rules

State-centric: BPMN is task-centric, our definitions are state-centric, so states become intermediate
events and transitions become tasks.

| Definition | Diagram |
|---|---|
| `roles[]` | **Lanes** in one pool. `cardinality > 1` → multi-instance marker. |
| `initialState` | Start event |
| non-terminal state | Intermediate event (a milestone), labelled with the state's title |
| state with `outcome` | End event: plain = `fulfilled`, terminate = `abandoned` |
| transition, per role in `by` | **One task per lane** — the same transition. Moving a task between lanes changes `by`; removing one copy removes that role. |
| several `from` states | several incoming arrows |
| `from: ["*"]` | one task with an "any state" marker, not N arrows |
| no `to` | an arrow back to the same state (a pure data update) |
| `deadline` / `onDeadline` | ⏱ timer after the state the deadline arms in, arrow to the target |
| `links[]` | ✉ message event ("waits for `quotation:AGREED`"), arrow to the target |
| `auto` with roles in `by` | task with a ⚙ marker |
| `auto` with `by: []` | a ⚙ arrow straight from `from` to `to`, no task |
| `by: []`, fired by a timer or link | **no task** — the timer or message event *is* the transition |
| more than one way out of a state | **event-based gateway** — derived, never stored |

**Why no "System" lane.** An earlier draft put `by: []` transitions in a System lane. Rejected: a lane
reads as an actor, and the connector is not a participant. It is also wrong, not only unclear —
`cancel` in `container-transport` is fired by participants **and** by a link, and `bookGate`'s deadline
fires a transition participants can also fire. A lane cannot say that; events pointing at a task can.
Lanes mean exactly one thing: **which role does this**. Which lane an event is *drawn* in is layout only.

**Details worth stating.**

- A deadline belongs to the **transition that enters** a state, not to the state (`offer` → `OFFERED`
  arms `PT24H`). Two transitions entering the same state may arm different deadlines, so the timer is
  keyed by its arming transition and labelled with it, and `setDeadline` takes a transition.
- A `by: []` transition with several triggers (a timer *and* a link) gets one event node per trigger,
  each carrying the same transition `ref`.
- A `by: []` transition with no trigger at all cannot be fired; the linter reports it as
  `no-fireable-exit`. It is still projected — as a task outside every lane, marked unfireable — because
  a projection that drops what it cannot place is not lossless.
- Every node and edge carries a `ref` to the definition element behind it, plus
  `layer: 'shared' | 'private'` (B7). Derived elements (gateways, edges between them) carry none.

---

## 5. B4 — `packages/bpmn`

**Decision.** A new workspace package holds the model, the projection and the commands. It depends on
`packages/protocol` only, with no new npm dependencies, and is built dual ESM + CJS with tsup like the
other packages. The boundary is lint-enforced by extending the `eslint-plugin-boundaries` configuration.

| Module | Responsibility |
|---|---|
| `model.ts` | `DiagramModel` — lanes, nodes (start, state, end, task, timer, message, gateway), edges, `ref`, `layer` |
| `project.ts` | `toDiagram(definition, layout?)` |
| `commands/` | one file per command family; `applyCommand` dispatches |
| `layout.ts` | `DiagramLayout` (node key → x, y) and the auto-layout: lanes as rows, BFS columns from `initialState`, reusing the approach in `apps/process-ui/src/web/graph/layout.ts` |
| `forms/` | field builder ⇄ `data`; "fills in" / "must be present" ⇄ `patch` / `guards`; visibility matrix ⇄ `visibility` |
| `diagnostics.ts` | a linter JSON Pointer → the node key it is about |

**Why a package and not only the process UI.** A third party building its own UI gets the same
translation, which is the "anything our demo UI can do" rule applied to authoring.

**Node keys are stable** and derived from ids: `state:OFFERED`, `task:offer@transporter`,
`timer:offer`, `message:startExecution#0`. Layout is keyed by them, so `rename` rewrites layout keys too.

**Layout never enters the definition.** The `definitionHash` covers the document's bytes
([F-series §5](2026-09-04-open-foundation-design.md)); moving a box must not change a process's identity.

---

## 6. B5 — the editor in `apps/process-ui`

The existing **Authoring** view gains two tabs over **one draft**: **Diagram** and **JSON**. The JSON
tab is today's editor, unchanged. Switching is lossless because both edit the same definition. New code
lives in `src/web/modeler/`; BPMN shapes are custom SVG nodes.

**Canvas.** One pool, lanes as rows. Drag an arrow out of a state and choose a lane to add a task. Drag a
task to another lane to change `by`.

**The palette is the restriction.**

| Offered | Not offered |
|---|---|
| Lane (role), Task, State, End ✓ fulfilled, End ✕ abandoned, ⏱ Timer, ✉ Message | parallel gateway, subprocess, loop / multi-instance task, data object, more than one pool |

Gateways are not in the palette either: they are derived. A parallel gateway is not merely omitted for
simplicity — an instance is in one state at a time, so the model cannot express it.

**Properties panel**, by selection:

- **Process** — `id`, `version`, `title`, `kind`, `hostedBy` (a lane picker), `createdBy`, `defaultVisibility`
- **Lane** — title, cardinality, `protocolRole`
- **State** — id, title, outcome
- **Task** — id, title, `from` / `to` (also drawable), `auto`, attachments, deadline and its target
- **Data** — a field builder (text, number, date/time, choice, yes/no, group) producing `data`
- **Per task** — "this step fills in" (fields, each optionally required) → `patch`; "must already be
  present" → `guards`
- **Visibility** — a field × role matrix, each grant optionally "only in states …" (`whenState`)
- **Advanced (JSON)** — the raw fragment of the selected element

**Forms never drop what they cannot show.** A `pattern`, a nested `enum`, a richer guard: the form shows
the field read-only with an *edited in JSON* badge, and Advanced is where it is changed. This is what
lets the five examples open without loss.

**Diagnostics on the node.** Every command triggers a debounced dry-run lint
(`POST /api/local/v1/definitions/lint`, existing). Each diagnostic's JSON Pointer maps to a node key
(M6.5 designed diagnostics for this), which is outlined, with the message in the panel. Publishing is
blocked while there are errors, as today.

**Drafts and layout** stay in the browser (`localStorage`, per draft), following F-series "no drafts in
the connector". Publishing is the existing `POST /api/local/v1/definitions`. No new endpoint, no
privileged path.

**Published means read-only.** A published or adopted definition opens read-only; **New version** copies
it into a draft with the version bumped.

**No domain vocabulary** in labels, placeholders or palette names (non-negotiable 11). Only definitions
carry domain terms.

---

## 7. B6 — data flow and error handling

```
gesture → command → applyCommand → new draft revision (+ undo) → toDiagram → render
                                 → debounced (~300 ms) lint → diagnostics on nodes
```

**Two kinds of wrong, handled differently.**

1. **Structurally impossible** — the command is refused and the draft does not change. Commands never
   leave a dangling reference.
   - **Remove** a state or role something still references: refused, listing the dependents. An
     explicit *remove with dependents* removes those too.
   - **Rename** an id: cascades through every reference — `from`, `to`, `onDeadline`, `links.triggers`,
     `whenState`, `hostedBy`, `by`, `createdBy`, `visibility.roles` — and the layout keys.
2. **Valid but not yet a working process** — unreachable state, no fulfilled ending, a dead end. That is
   the linter's job. **A draft may be incomplete**; only publishing is blocked.

| Situation | Behaviour |
|---|---|
| A lint response for an older revision | Dropped. Every request carries the draft revision. |
| Connector or BFF unreachable | Draft keeps working; banner "cannot validate"; publish disabled until lint answers |
| `409 definition-conflict` on publish | "This version exists. Publish as `x.y.(z+1)`?" — one click bumps and retries |
| Same bytes, same `id@version` | Idempotent, shown as published |
| Network error on publish | Draft intact, retry |
| `localStorage` unavailable | Draft in memory only, with a warning that a reload loses it |

**Undo/redo** is a stack of (definition, layout) pairs — cheap, because every revision is a new
immutable object.

---

## 8. Testing

Per the tiers in [TESTING.md](../../TESTING.md); hermetic, no browser outside e2e.

**`unit` — `packages/bpmn`, where nearly everything is tested.**

- **Coverage.** For each of the five example definitions, every role, state, transition, deadline, link,
  `auto` and `from: ["*"]` is represented by at least one node or edge carrying its `ref`.
- **Losslessness.** Each command followed by its inverse yields byte-identical JCS. For each example,
  open → project → no change yields the identical document and therefore the same `definitionHash`.
- **Commands individually**, including refusals: remove with dependents, rename cascading through every
  reference kind in B6, moving a task between lanes → `by`.
- **Schema validity.** Every command's output passes `ProcessDefinition.parse`. The linter may warn; the
  schema may not fail.
- **Forms.** Field builder ⇄ `data`; the two per-task lists ⇄ `patch` / `guards`; unsupported schema
  features preserved and flagged.
- **Diagnostics.** A linter JSON Pointer maps to the right node key.

**`unit` — `apps/process-ui`.** Draft, undo and stale-lint dropping as pure reducers, without React.

**`scenario`.** One new test: a definition **built only from commands**, published, adopted by a peer
and run to `fulfilled` on two connectors. It proves an editor-made process runs on an unmodified
connector (non-negotiable 11).

**`contract`.** Nothing new: the editor uses only `lint` and `publish`, both already covered.

**`e2e`** — wiring and UI only, two specs:

1. Draw a two-lane process from scratch (task, state, fulfilled end, timer), publish, see it listed.
2. Open an example: the JSON tab shows the identical document; one edit in the diagram appears in the
   JSON.

---

## 9. B7 — the track this starts, and the constraint it sets

| # | Sub-project | Builds on |
|---|---|---|
| **1** | **Shared BPMN editor** — this record | — |
| 2 | **Private layer, model and editor** — a participant's own tasks in the same canvas: the shared part read-only, their own lane editable | 1 |
| 3 | **Private task runner** — executes private tasks: an HTTP call to the participant's own system, a field mapping, writing the result back as a transition's patch or into the back end | 2 |
| 4 | **Collaboration view** — several linked definitions in one canvas: pools are definitions, `links` become message flows between them | 1 |

**The constraint on sub-project 1.** `layer: 'shared' | 'private'` exists in the model from the start,
and nodes are keyed so a second artefact can add nodes to a lane without touching the definition. A
collaboration view is a layer *above* `DiagramModel` (several projections, message flows between them),
not a change to it.

**What is already settled about 2 and 3**, so that 1 does not foreclose it:

- The private layer is a **separate artefact per participant**, bound to `definition@version` and
  `definitionHash`, **never in the definition, never replicated, outside the hash**. Otherwise one
  participant's private task would change everyone's agreement.
- A private task **cannot change the shared flow**. It may only produce data for a shared transition, or
  consume data from an event.
- The runner is a client of the **local API**, as the mock backoffice is: it reacts to
  `action.required` and posts a transition back. No privileged path.

**Honest limitations, stated now** so the "no code" goal is not oversold:

- "No code" holds for back ends with a reasonable HTTP/JSON API and plain field mappings. EDI, SOAP,
  unusual auth flows or real business logic will still need an adapter. The target is no code for the
  common case.
- Private tasks need **credentials for a participant's own systems** — a new kind of secret in the
  connector. Sub-project 3 needs a clear design for that, reviewed with the CISO before it reaches a real
  participant.

---

## 10. Open questions for the supervisor

1. **Milestone placement.** This is new scope after M6.5 and before an event-triggered M7. Its own
   milestone (e.g. M6.6), or outside the milestone line as a track?
2. **Layout persistence beyond the browser.** v1 keeps layout in `localStorage`, so a published
   definition opens with auto-layout on another machine. Acceptable for v1, or should the author's
   layout travel (e.g. as a sidecar beside the published definition, outside its hash)?
