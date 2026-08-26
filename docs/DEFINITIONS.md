# Process definitions

*The shared artefact. One definition per process, agreed once, executed identically by every node.
Real examples live in [definitions/](definitions/).*

A definition is a JSON document. It carries an `@context` so it can be projected to JSON-LD/ODRL for
publication, but the runtime reads it as plain JSON — **there is no JSON-LD processor on the hot path**.

The canonical schema lives in `packages/protocol` as a Zod schema. This document is its annotation; if
the two disagree, the code wins and this file is a bug.

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
  "states": [ … ],
  "terminalStates": [ "DELIVERED", "CANCELLED" ],
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

### `states`, `initialState`, `terminalStates`

`states` is a list of `{ id, title }`. Every state must be reachable from `initialState`, and every
state must have a path to some terminal state. The linter in `packages/protocol` enforces both; a
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
| `guards` | Extra conditions on the resulting data document. Evaluated after the patch. |
| `attachments` | Whether this transition requires content-addressed documents. |
| `deadline` | ISO 8601 duration, measured from entry into the `from` state. |
| `onDeadline` | The `id` of another transition to fire when the deadline passes. |
| `auto` | Fire immediately when the `from` state is entered. This is what makes standing quotations a definition concern rather than a code concern. |
| `requiresCredential` | Name of a verifiable credential the actor must present to fire this transition. **Declared but not yet enforced** — the field exists so credential gating can be switched on without a schema change. See [ROADMAP.md](ROADMAP.md#deliberately-not-in-scope-yet). |

**Every change is a transition.** There is no separate "update a field" operation, because a transition
with a `patch` and no `to` already is one. One mutating endpoint, one audit trail, one permission check.

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
