# Process definitions

*The shared artefact. One definition per process, agreed once, executed identically by every node.
Real examples live in [definitions/](definitions/).*

A definition is a JSON document. It carries an `@context` so it can be projected to JSON-LD/ODRL for
publication, but the runtime reads it as plain JSON — **there is no JSON-LD processor on the hot path**.

The canonical schema lives in `packages/protocol` as a Zod schema
(`src/schemas/definition.ts`). This document is its annotation; if the two disagree, the code wins and
this file is a bug. A JSON Schema projection is generated from it for non-TypeScript implementations:
[`packages/protocol/schema/process-definition.schema.json`](../packages/protocol/schema/process-definition.schema.json).

Check a definition with:

```bash
pnpm lint:definitions
```

## 1. Skeleton

```jsonc
{
  "@context": "https://pilots.example/process/v1",
  "id": "container-transport",
  "version": "1.0.0",
  "kind": "service",                       // "service" | "quotation"
  "title": "Container road transport",
  "roles": [ … ],
  "hostedBy": "transporter",
  "initialState": "PENDING_CONTRACT",
  "states": [ … ],                         // an ending state carries an "outcome"
  "defaultVisibility": "all",              // "all" | "none"
  "data": { … },                           // JSON Schema
  "transitions": [ … ],
  "visibility": [ … ],
  "links": [ … ]
}
```

Definitions are **content-addressed and versioned**. An instance pins `id@version`; a definition, once
published, never changes. Disagreement forks a version instead of blocking anyone.

## 2. Fields

### `kind`

`"quotation"` or `"service"`. It selects nothing in the engine — both run on the same state machine —
but it drives how the UI presents the instance, and a `service` instance may carry `quotationId`.

A **standing quotation** is simply a quotation definition whose initial transition is marked `auto`
(§`transitions`). Creating the instance immediately fires it, so it is born `AGREED`. There is no
separate code path for "fixed price" services.

### `roles`

```jsonc
"roles": [
  { "id": "shipper",     "title": "Shipper",     "cardinality": 1, "protocolRole": "requester" },
  { "id": "transporter", "title": "Transporter", "cardinality": 1, "protocolRole": "provider" }
]
```

An array, always — even for two-party processes. Adding a third participant is one more entry plus its
transitions, never a redesign. `protocolRole` (`requester` | `provider` | `observer`) is a hint for
generic UI and for defaulting `hostedBy`; business logic keys off `id`.

### `hostedBy`

The `id` of the role whose participant runs the **home node** for instances of this definition. That
node holds the authoritative record and assigns `seq`. See
[ARCHITECTURE.md §8](ARCHITECTURE.md#8-hosting-and-the-trust-model) for what this does and does not
imply about trust.

### `createdBy`

Optional. Roles permitted to create an instance; absent means any participant may. None of the shipped
definitions restrict it, but the field exists so that "the definition forbids the caller's role from
creating an instance" ([PROTOCOL.md §9.1](PROTOCOL.md#91-post-instances)) is a real check.

### `states`, `initialState`, and how a process ends

`states` is a list of `{ id, title }`, and a state that **ends** the process carries an `outcome`:

```jsonc
"states": [
  { "id": "PENDING_CONTRACT", "title": "Pending contract" },
  { "id": "DELIVERED",  "title": "Delivered",  "outcome": "fulfilled" },
  { "id": "CANCELLED",  "title": "Cancelled",  "outcome": "abandoned" }
]
```

`outcome` is what makes a state terminal — there is no separate list, so nothing can disagree about
whether a state is final. Two values: **`fulfilled`** ("it did what it was for") and **`abandoned`**
("it stopped without doing it"). Absent means the process is still running there.

**Why it is not merely a terminal flag.** A flag says *that* a process ended and never *how*, so
`AGREED` and `REJECTED` look identical to anything that does not already know this definition's
vocabulary — and every integrator ends up hardcoding which state names of which definitions mean
success. The computed value travels on the instance (`outcome` on `GET /instances`) and in every
notification envelope, so a back-office system can close its own ticket on `fulfilled` without
learning that `VGM_ISSUED` is one particular process's good ending. It is the same principle as
`available`: the connector computed it, so an internal system needs no state machine.

A `["*"]` transition expands to every **non-terminal** state, so a cancellation cannot resurrect a
finished instance.

Every state must be reachable from `initialState`, every state must have a path to an ending, and at
least one state must declare an `outcome`. The linter in `packages/protocol` enforces all three; a
definition that fails does not load.

### `data`

A JSON Schema describing the instance's data document. The document must validate after every
transition, not merely at creation.

### `transitions`

```jsonc
{
  "id": "offer",
  "title": "Make an offer",
  "from": ["REQUESTED", "COUNTERED"],
  "to": "OFFERED",
  "by": ["transporter"],
  "patch": { … },                     // JSON Schema for the merge patch
  "guards": [ { "required": ["price"] } ],
  "attachments": { "required": false },
  "deadline": "PT24H",
  "onDeadline": "expire",
  "auto": false
}
```

| Field | Meaning |
|---|---|
| `from` | States this transition may be applied in. `["*"]` means **any non-terminal state** — used for cancellation. |
| `to` | Resulting state. Omit for a pure data update. |
| `by` | Roles permitted to fire it. **An empty array means no participant may fire it manually** — only the runtime, via `auto`, a `deadline`, or a `link`. |
| `patch` | JSON Schema for the JSON Merge Patch (RFC 7386) applied to `data`. Omit for a pure state change. |
| `guards` | Extra conditions on the resulting data document, each an ordinary **JSON Schema fragment** — `{ "required": ["price"] }` already is one, so guards add no second expression language. Evaluated after the patch. |
| `attachments` | Whether this transition requires content-addressed documents, and which mime types. |
| `deadline` | ISO 8601 duration, from the restricted subset `P#D` / `PT#H` / `PT#M`. It **arms on entry into this transition's `to` state**, and `onDeadline` fires if the instance is still there when it elapses. So `offer` → `OFFERED` with `PT24H` means "an offer may sit unanswered for a day". A `deadline` therefore requires a `to`. |
| `onDeadline` | The `id` of another transition to fire when the deadline passes. It must be applicable in the state the deadline arms in; the linter checks this, because otherwise it silently never fires. |
| `auto` | Fire immediately when the `from` state is entered. This is what makes standing quotations a definition concern rather than a code concern. |
| `requiresCredential` | Name of a verifiable credential the actor must present to fire this transition. **Declared but not yet enforced** — the field exists so credential gating can be switched on without a schema change. See [ROADMAP.md](ROADMAP.md#deliberately-not-in-scope-yet). |

**Every change is a transition.** There is no separate "update a field" operation, because a transition
with a `patch` and no `to` already is one. One mutating endpoint, one audit trail, one permission check.

**`create` is a reserved transition id.** Creating an instance is event `seq` 1, recorded with that id,
so the log alone can reconstruct the instance — which definition it pins, who is in it, and what data it
was born with. The linter refuses a definition that declares a transition called `create`.

### `visibility`

An array of grants. A role may read a path if **any** grant matches.

```jsonc
"defaultVisibility": "all",
"visibility": [
  { "path": "grossMass",  "roles": ["weigher"] },
  { "path": "grossMass",  "roles": ["shipper"], "whenState": ["PAID", "VGM_ISSUED"] },
  { "path": "driverName", "roles": ["transporter"] }
]
```

- `path` is a dotted path into the `data` document.
- `whenState` restricts the grant to certain instance states — this is how "the shipper may not see the
  weighed mass until payment is recorded" becomes a runtime rule rather than a convention about what a
  script puts in a message.
- `defaultVisibility: "all"` means unlisted paths are readable by every participant. Set `"none"` for
  processes where withholding is the norm; then every path needs an explicit grant.

Visibility is applied on instance reads, event replay, the event stream, and attachment fetches, on **both**
the peer and the local surface — one enforcement point, in the runtime.

### `links`

```jsonc
"links": [ { "onEvent": "quotation:AGREED", "triggers": "startExecution" } ]
```

An instance may subscribe to another instance's event stream and fire a transition when a matching
signed event arrives. `onEvent` is `<relation>:<state>` or `<relation>:<transitionId>`, where the
relation names how the other instance is attached (today: `quotation`).

Because the triggering event is signed and chained, a cross-process advance is **provable** — the
instance can show exactly why it moved. This construct earns itself immediately by starting a service
instance when its quotation is agreed, and it generalises to linking genuinely independent processes.

## 2.1 What the linter checks that a schema cannot

A definition is agreed once between companies and then executed identically everywhere, so the checks
are deliberately unsubtle: one that fails does not load. Most of the rules are the obvious ones —
undefined roles and states, duplicate ids, dangling references, deadline coherence, JSON Schema
validity of `data`, `patch` and `guards`. Four are worth explaining, because they catch a class of
mistake that looks fine until somebody tries to run the process.

| Code | Severity | What it means |
|---|---|---|
| `no-fulfilled-path` | error | No state with `outcome: "fulfilled"` is reachable from `initialState`. The process can never succeed. |
| `no-fireable-exit` | error | A reachable non-terminal state that **nothing** can leave: no transition out of it names a role in `by`, is `auto`, is fired by a link, or has a deadline arming in it. |
| `starts-link-dependent` | warning | Correct, but not startable on its own — every route to fulfilment crosses a transition only a linked instance can fire. |
| `unfulfillable-state` | warning | Reachable, and no fulfilled ending is reachable from it. Legitimate (a dispute that can only end badly), but worth saying out loud. |

There was already a rule that looked like the first of those:

> `dead-end-state` — no path to any terminal state.

It asks about *an* ending, not a *good* one. Every shipped definition has `cancel` with `from: ["*"]`
to a terminal `CANCELLED`, so every state reaches a terminal state trivially and the rule could
essentially never fire. That is why a process with no way to succeed used to lint clean.

**Every diagnostic carries a JSON Pointer** into the document, and the graph rules emit one diagnostic
per offending state rather than one listing them all — so an editor can highlight exactly the node at
fault. `pnpm lint:definitions` groups them back together for reading.

`container-transport` and `container-transport-with-terminal` both raise `starts-link-dependent`, which
is correct: they are contracted by a quotation, and the connector refuses an instance created without
one. See [ARCHITECTURE.md §5.1.2](ARCHITECTURE.md#512-a-valid-definition-can-still-yield-an-unrunnable-instance).

## 3. Available definitions

| File | Kind | Roles | Used by |
|---|---|---|---|
| [`container-weighing-quotation.json`](definitions/container-weighing-quotation.json) | quotation, standing | shipper, weigher | S1 |
| [`container-weighing.json`](definitions/container-weighing.json) | service | shipper, weigher | S1 |
| [`container-transport-quotation.json`](definitions/container-transport-quotation.json) | quotation, negotiated | shipper, transporter | S2 |
| [`container-transport.json`](definitions/container-transport.json) | service | shipper, transporter | S2 |
| [`container-transport-with-terminal.json`](definitions/container-transport-with-terminal.json) | service | shipper, transporter, terminal | S3 |

The last one exists to prove the model is not bilateral. It is not executed in the first milestone, but
it must load and lint under exactly the same schema as the others.
