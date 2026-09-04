# Open foundation: authoring, validating and adopting process definitions

*Design decision record. 2026-09-04. Milestone **M6.5**. Affects `packages/protocol`, `apps/connector`,
`apps/process-ui` and the connector's admin UI. M7 (publish and deploy) stays **locked**.*

Status: **accepted**, not yet implemented.

Decisions are numbered `F1…` to avoid colliding with the `D` series in the
[2026-08-26 record](2026-08-26-component-split-and-persistence-design.md) and the `P` series in the
[2026-09-03 record](2026-09-03-process-ui-iteration-design.md).

---

## 1. What prompted this

An attempt to drive a demo by hand, entirely through the two process UIs, dead-ended: every process
reached a state whose only offered action was *cancel*. The investigation is worth recording, because it
changed what this milestone is about.

`container-transport` starts in `PENDING_CONTRACT`, whose only forward transition is `startExecution`,
declared `by: []` — no participant may fire it. It is fired by a `links` rule when the quotation the
instance points at reaches `AGREED`. The process UI never sets `quotationId` when creating an instance,
so there was no quotation to fire it, and `cancel` (`from: ["*"]`, `by: ["shipper","transporter"]`) was
the only edge anyone could walk.

The tempting fix was to make the process UI set `quotationId` for that pair of definitions. That is the
wrong fix, and the supervisor said so: **the deliverable is a connector that runs anyone's valid process,
not one that runs ours.** The definition was not invalid — it declares a link that fires the transition,
and it is coherent. What was invalid was the **instance**: created without the relation its own
definition depends on, and therefore unable to ever succeed.

That reframing is the spine of this milestone. Everything below either detects that class of mistake
generically, or removes a reason to hand-write definitions in the first place.

---

## 2. F1 — refuse an instance that cannot succeed

**Decision.** At instance creation, the connector walks the definition from `initialState` across only
the edges *something can actually fire for this instance*, and refuses the creation if no state with
`outcome: "fulfilled"` is reachable.

An edge is walkable when any of these hold:

| Condition | Who fires it |
|---|---|
| `by` is non-empty | a participant |
| `auto: true` | the engine |
| some transition's `onDeadline` names it and arms on entry into this state | the clock |
| a `links` entry `triggers` it **and the relation it names is set on this instance** | a linked instance |

The last row is the whole point. `links` are declared per definition but anchored per instance:
relation `quotation` resolves through `instance.quotationId`. An instance created with
`quotationId: null` cannot walk a link-only edge, however well-formed the definition is.

Checked against the five committed definitions:

| Definition | Created with | Result |
|---|---|---|
| `container-transport` | no `quotationId` | **refused** — only `CANCELLED` reachable |
| `container-transport` | a `quotationId` | allowed — `DELIVERED` reachable |
| `container-transport-with-terminal` | no `quotationId` | **refused** |
| `container-weighing` | — | allowed |
| `container-weighing-quotation` | — | allowed (`agree` is `auto`) |

**Why refuse rather than warn.** `quotationId` is part of `InstanceGenesis` and therefore immutable —
it cannot be supplied later. An instance that fails this check can never do anything but be cancelled,
so creating one is always a mistake.

**Problem type.** `urn:pilots:problem:instance-unfulfillable`, 422, whose `detail` names the relation
that would unlock the path (`this definition reaches fulfilment only through a transition fired by the
"quotation" relation; create it with a quotationId`). The message is generated from the graph, so a
definition nobody here has seen produces an equally specific message.

**Second consumer.** The same computation, run against a definition with no instance, answers *"can this
definition be started standalone?"*. The process UI's Start screen uses it to disable a definition that
cannot, with the reason shown — which is the user-visible fix for the dead end that prompted this.

---

## 3. F2 — three lint rules the existing twenty-five do not cover

The linter is already substantial. One of its rules is, in practice, dead:

> `dead-end-state` — *no path to any terminal state*

Every shipped definition has `cancel` with `from: ["*"]` to a terminal `CANCELLED`. Every state
therefore reaches a terminal state trivially, and the rule can essentially never fire. It tests for a
path to *an ending*, when what an author needs tested is a path to a *good* ending.

**Decision.** Add three rules, and keep `dead-end-state` (it still catches a definition with no
`cancel`-style escape).

| Code | Severity | Rule |
|---|---|---|
| `no-fulfilled-path` | error | From `initialState`, no state with `outcome: "fulfilled"` is reachable. The process can never succeed. |
| `no-fireable-exit` | error | A reachable non-terminal state whose every outgoing transition is unfireable by anything — no `by`, not `auto`, no link triggers it, no deadline arms into it. True self-locking. |
| `starts-link-dependent` | warning | Every path from `initialState` to fulfilment crosses a link-only edge, so this definition must not be started standalone. Derived from the graph, never declared. |

A fourth, `unfulfillable-state` (warning): a reachable non-terminal state from which fulfilment is
unreachable, in a definition that can otherwise succeed. Legitimate — a dispute state that can only end
badly — but worth saying out loud.

`starts-link-dependent` is what `container-transport` would have raised, and it is a **warning**, not an
error: the definition is correct, and the mistake it predicts is made at creation time, where F1 catches
it as an error.

---

## 4. F3 — every diagnostic points at a node

All twenty-nine existing diagnostics already carry a `path`. Two things stop that path being usable by
a future canvas:

- `invalid-json-schema` passes the prose string `'the data schema'` rather than a pointer.
- The graph-level rules (`no-terminal-state`, `unreachable-state`, `dead-end-state`, and the new rules)
  point at `/states` collectively, so a canvas cannot tell *which* states are at fault.

**Decision.** Every diagnostic's `path` is a JSON Pointer into the definition document, and the
graph-level rules emit **one diagnostic per offending state** rather than one listing them all. A canvas
highlights exactly the nodes named; the CLI groups them back together for display.

This is done now rather than when the canvas is built, because retrofitting it means revisiting every
rule while also writing an editor.

---

## 5. F4 — `definitionHash` in the instance genesis

`InstanceGenesis` pins `definition` as `id@version` — a **name, not the bytes**. Its own comment says it
exists so a home node cannot "quietly claim a different definition", and at ref granularity that is not
quite true: two connectors can hold different documents under the same ref and each believe the other
agrees.

Today this is masked, because both demo containers mount the same `docs/definitions` directory. Once
definitions are authored in one UI and fetched by a peer (F6), it is live.

**Decision.** Add `definitionHash: Sha256` to `InstanceGenesis`, alongside `definition`.

**This is a breaking change.** `genesis` is committed to by every event header, so every existing
instance's chain becomes unverifiable. It is accepted deliberately: nothing has been published, M7 has
not run, and the alternative is making the same change after a release.

**Consequence for F7.** The hash covers the document's bytes, which is why editor layout must not live
inside the document.

---

## 6. F5 — authoring on the local surface

**Decision.** Authoring a definition is an ordinary integration act on `/api/local/v1`, not a
privileged one. Accepting a *peer's* definition (F6) is a trust decision and stays on `/api/admin/v1`
beside connections and trusted peers.

This follows the non-negotiable that anything our demo UI can do, a third party's UI can do over the
same surface. An editor behind the admin session would make authoring a privileged path.

**Endpoints.**

| Method | Path | Scope | Behaviour |
|---|---|---|---|
| `POST` | `/api/local/v1/definitions/lint` | `definitions:write` | Dry run. Lints a candidate document, returns diagnostics, **stores nothing**. |
| `POST` | `/api/local/v1/definitions` | `definitions:write` | Publish. Lints hard; refuses on any error. |
| `GET` | `/api/local/v1/definitions` | `definitions:read` | Already exists. |

`definitions:write` is a new value in the `Scope` enum.

**Immutability.** A published definition is content-addressed and never changes. Publishing an identical
document under an existing `id@version` is idempotent. Publishing **different bytes** under an existing
`id@version` is a conflict, refused with `urn:pilots:problem:definition-conflict` — the author must bump
the version.

**Storage.** A new `definitions` store collection, carrying `participantId` like every other document,
holding the raw document, its content hash, its origin (`boot` | `local` | `peer`) and, for peer
definitions, the adoption record from F6.

**Registry.** `DefinitionRegistry` gains hydration from the store at boot and in-memory registration on
publish. It stays **synchronous**: a connector is a single process, and making `get()` async would
ripple through the peer server, replication, links and instances for no benefit. The boot directory
becomes a seed, not the authority — a definition published at runtime and one loaded from disk are the
same kind of record afterwards.

**No drafts.** The connector holds published definitions only. The editor's working copy lives in the
browser and is validated continuously against the dry-run endpoint. Drafts in the store can be added
later without changing what a published definition means; the reverse is not true.

---

## 7. F6 — adoption: fetch, decide once, diff on change

Replication currently **refuses** an instance whose definition this connector does not hold. The serving
half of the answer already exists: `GET /api/peer/v1/definitions/{ref}` returns a definition and its
content hash to a connected peer.

**Decision.** On an unheld definition, the connector fetches it from the peer, lints it, verifies its
hash against the `definitionHash` in the instance genesis (F4), and stores it as **pending**. That
replication batch is refused with `urn:pilots:problem:definition-pending`, and the peer's existing
retry machinery does the waiting. No new queue: any non-2xx already throws, leaves the delivery cursor
where it was, and retries with capped backoff.

**A pending adoption is a wait, not a failure.** The delivery path today treats every non-2xx
identically: it marks the connection `DEGRADED` and writes a `delivery.fail` audit entry on each
attempt. For this response that is wrong twice over — nothing is faulty, and a demo would show a red
connection while the other operator is being asked to click *accept*. So the failure path gains one
branch: `definition-pending` backs off without degrading the connection and without an audit entry per
attempt, and the connection carries a `waitingOn` note naming the ref instead.

**Known limitation: head-of-line blocking.** The delivery cursor is per connection and ordered, so
deliveries for unrelated instances queue behind one awaiting adoption. This is accepted rather than
solved: ordering is what makes an incrementally replicated chain verifiable, and the wait is
operator-scale. It is stated here so it is not discovered later as a surprise.

**Adoption is decided per definition, not per instance.** An operator accepts or rejects a pending
definition in the admin UI; the decision is recorded against the ref and consulted for every later
instance. Only the first instance under a definition ever asks.

| Method | Path | Behaviour |
|---|---|---|
| `GET` | `/api/admin/v1/definitions/pending` | Pending definitions, with their origin peer and diff (below). |
| `POST` | `/api/admin/v1/definitions/{ref}/accept` | Adopt. Every held and future instance under this ref may run. |
| `POST` | `/api/admin/v1/definitions/{ref}/reject` | Refuse. Instances under this ref stay refused, with a reason. |

**Diff on a new version.** When a pending definition's `id` matches one already accepted at a lower
version, the screen shows a **structural diff** against the highest accepted version — roles, states,
transitions and visibility rules added, removed or changed — over the raw JSON diff. An operator
approving `1.1.0` is answering "what changed since the `1.0.0` I already agreed to", which a text diff
answers badly.

**Conflict is not a diff.** Same `id@version`, different bytes, is refused outright as
`definition-conflict` and never offered for adoption. A version is an identity, not a label.

**Audit.** `definition.accept` and `definition.reject` are audit entries in the strict sense of §10:
they are decisions that produce no event and would otherwise leave no record.

---

## 8. F7 — layout lives beside the definition, never inside it

Visual editing of definitions is on the roadmap. A canvas that auto-lays-out on every edit is unusable,
so node positions must persist.

**Decision.** Layout is stored **separately**, keyed by definition ref, and is never part of the
definition document.

The reason is F4: `definitionHash` covers the document's bytes, and the hash is what peers adopt.
Positions inside the document would mean **dragging a box changes the hash**, invalidating instances and
forcing every peer to re-adopt a definition whose behaviour is identical.

Nothing about layout is built in this milestone. The decision is recorded now because it is the one
choice here that a canvas cannot undo cheaply.

---

## 9. F8 — no domain vocabulary in the connector or the base UI

A sweep of the connector, protocol, client and process UI for logistics terms outside comments found
three hits, and no code anywhere branching on a domain term:

| Where | What | Fix |
|---|---|---|
| `apps/connector/src/admin-ui/src/App.tsx` | The "publish an offering" form prefills `urn:offering:example:container-weighing` / "Container weighing" | Draw the prefill from the definitions this connector actually holds |
| `packages/protocol/src/schemas/common.ts` | A validation message says "e.g. `grossMass.value`" | A neutral example |
| `packages/client/src/openapi.ts` | A doc string uses `VGM_ISSUED` as its example | A neutral example |

The admin UI fix is the interesting one: rather than swapping one hardcoded example for another, the
prefill becomes definition-driven, which is both neutral and more useful to an operator.

**No banned-wordlist test.** It would false-positive on "container" throughout a repository built around
containers, and become a thing to fight rather than a guard. The principle goes in `AGENT.md`; the
enforcement is review.

---

## 10. Deferred: sharpening the audit log

Not built in this milestone, recorded because F6's new entries are written against the sharpened rule
rather than added and then subtracted.

The audit log currently records both `auth.apiKey` denials and successful `transition.apply`. The first
is the only record that the thing happened; the second duplicates an event that is already signed,
chained and replicated. The result is a hash chain dominated by process traffic — which is why
`audit/prune` had to be built at M6, pruning a chain that should have been small.

**The test is not "process versus security". It is: is this entry the only record that this happened?**

- **Keep**: `auth.*` (especially denials), `apiKey.create`, `session.create`, `admin.tokenSeed`,
  `connection.gate`, `chain.verify`, `definition.accept`, `definition.reject`, and every `denied` or
  `failed` outcome of anything.
- **Drop**: successful `transition.apply`, `instance.create`, `replication.apply`, `link.fire`,
  `deadline.fire`, `relay.forward` — all of which the event log already proves.

The "connector-owned, filterable process log" that motivated this is best built as a **query over the
events already stored**, not a fourth log: cross-instance history filterable by peer, definition, state,
transition and time. Today `GET /api/local/v1/events` is a live SSE stream only, so the gap is history,
not records. An index has nothing to keep consistent.

---

## 11. What this milestone does not do

- **Structured forms** for authoring. JSON first, by decision; forms are the next iteration.
- **Graph editing.** F3 and F7 exist to make it cheap later; none of it is built now.
- **Drafts** in the store (§6).
- **The audit split** (§10).
- **Definition deletion.** A published definition is immutable and referenced by instances; withdrawing
  one is a separate problem with its own questions.

---

## 12. Testing

Every tier stays hermetic — no network, no containers, no real clock.

- **Protocol**: the four new rules, table-driven over hand-built definitions, including the case the
  existing `dead-end-state` misses (a `cancel` from `*` making a fulfilment-less state look fine). JSON
  Pointer assertions on every diagnostic.
- **Connector**: F1 as a unit test over the definition graph, and at the API boundary — the exact
  creation that dead-ended must now return 422 naming `quotation`. Publish idempotency, conflict
  refusal, scope enforcement, registry hydration across a restart. A `definition-pending` response must
  leave the connection `ACTIVE` and write no `delivery.fail` entry, which is the regression the branch
  in §7 exists to prevent.
- **Scenario**: a definition authored on Org A, an instance started with Org B, replication refused as
  pending, an operator accepting, replication succeeding on retry — in-process transport, no containers.
  A second instance under the same ref must **not** ask again.
- **E2E**: authoring a definition in the process UI and seeing diagnostics; accepting it in Org B's
  admin UI.

---

## 13. Order of work

1. `packages/protocol`: the four lint rules and F3's pointers. Testable with no UI.
2. `packages/protocol`: `definitionHash` in `InstanceGenesis` (F4) — breaking, so before anything builds
   on the genesis.
3. `apps/connector`: F1's creation check and its problem type.
4. `apps/connector`: the definitions collection, registry hydration, lint and publish endpoints (F5).
5. `apps/connector`: fetch, pending, accept/reject, diff (F6).
6. `apps/process-ui`: the JSON editor with live diagnostics and live diagram.
7. `apps/connector/src/admin-ui`: pending definitions and the diff screen.
8. F8's three fixes, alongside whichever step touches the file.

Steps 1–3 are independently valuable: they would have caught the bug that prompted this milestone even
with no authoring UI at all.
