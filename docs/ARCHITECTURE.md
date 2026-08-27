# Architecture

*Authoritative. Supersedes [IDEA.md](IDEA.md). Standing rules in [../AGENT.md](../AGENT.md). The
reasoning behind the component split and the persistence port is in
[superpowers/specs/2026-08-26-component-split-and-persistence-design.md](superpowers/specs/2026-08-26-component-split-and-persistence-design.md).*

## 1. The idea in one paragraph

A shared business process is described **once**, as a declarative definition that names roles, states,
transitions and who may make each move. A running process is **one authoritative instance**, hosted by
the party the definition designates, advanced only through signed transitions, and reconstructible
from a hash-chained event log that every participant replicates and verifies. Each party runs the same
connector; how they drive it — a person clicking, a backoffice reacting to a webhook, or their own
in-house UI — is their own business, and all three go through the same API.

## 2. Terminology

| Term | Meaning |
|---|---|
| **Connector** | The core software. Everybody runs the same one. Serves three API surfaces and its own minimal admin UI. |
| **Node** | A running connector. Used loosely where the deployment is what matters. |
| **Participant** | A legal entity with a DID. Lives on a connector; one connector may host several. |
| **Connection** | A verified, persistent, bidirectional relationship between two participants. Established once, before any process runs. |
| **Definition** | A process description: roles, states, transitions, data schema, visibility, links. |
| **Instance** | A running process. `kind` is `quotation` or `service`. |
| **Home node** | The connector of the participant holding the role named in the definition's `hostedBy`. Stores the authoritative instance. |
| **Peer node** | Every other participant's connector. Holds a verified replica. |
| **Integrator** | Anything speaking the local API on a participant's behalf: their backoffice, their own UI, or our demo process UI. |
| **`requester` / `provider`** | The two generic protocol roles. Business roles (`shipper`, `weigher`, `transporter`, `terminal`) come from the definition. |

Deliberately **not** used as protocol terms: *consumer/producer* (collides with messaging),
*customer/supplier* (fine as UI labels, too narrow for three-party processes).

## 3. Components

Three deliverables, not one program. This is what makes "integrate your own UI or your own backend"
the normal path rather than a special case.

```
  packages/protocol      THE SPEC. Schemas, JCS, sign/verify, evaluator,
                         visibility filter, linter, JSON Schema export.
  packages/client        Typed local-API client + OpenAPI document.
                         The integration surface.

  apps/connector         ──▶ container 1
    three API surfaces + minimal admin UI + store adapters

  apps/process-ui        ──▶ container 2, OPTIONAL
    BFF (holds an API key, owns its own users) + SPA
```

`apps/process-ui` may import `packages/client` and `packages/protocol`. It may **never** import from
`apps/connector`. If it needs something the local API does not expose, that is a gap in the local API.
The same rule is what guarantees a third party's UI can do everything ours can.

The store lives **inside** `apps/connector`. Nothing outside the connector consumes a repository, so
promoting it to a shared package would be packaging for its own sake.

### 3.1 Runtime shape

Above the connector sits an **integrator layer**: a process UI, an internal system, or both. The
connector cannot tell them apart — they are all API-key clients on `/api/local/v1`.

```
  Party A — small                                 Party B — large
  ┌──────────────────────────┐                    ┌──────────────────────────┐
  │ process-ui  (container)  │                    │ process-ui  (container)  │
  │  · own user accounts     │                    │  · a person can always   │
  │  · holds one API key     │                    │    take over by hand     │
  └───────────┬──────────────┘                    └──────┬───────────────────┘
              │                                          │   ┌────────────────┐
              │                                          │   │ their own      │
              │                                          │   │ backoffice     │
              │                                          │   │  · acts on     │
              │                                          │   │  action.required│
              │                                          │   └──────┬─────────┘
              │  /api/local/v1  (API key)                 │         │
              ▼                                           ▼         ▼
  ┌──────────────────────────┐                    ┌──────────────────────────┐
  │ connector   (container)  │ ─── /api/peer/v1 ──▶ connector   (container)  │
  │  · admin UI              │    signed JWS      │  · admin UI              │
  │  · file store, no DB     │ ◀── events ──────── │  · managed doc store     │
  │  · local Ed25519 key     │    over the        │  · signer plugin         │
  │  · verified replica      │    Connection      │  · public HTTPS endpoint │
  │  · no inbound endpoint   │                    │  · authoritative record  │
  │  · notif. subscriptions  │                    │  · notif. subscriptions  │
  └──────────────────────────┘                    └──────────────────────────┘
```

Same connector image both sides, two configuration files. That difference — and only that difference —
is what separates the haulier from the terminal operator.

**The first demo runs a process UI on both sides**, so every step can be driven and verified by hand
without reading logs. Party B additionally registers a notification subscription into a mock backoffice,
so the automated path is demonstrated alongside the manual one — the same process, advancing either way.
A party may run the UI, the backoffice integration, or both; nothing in the connector prefers one.

### 3.2 Deployment topologies

| Setup | Shape | Self-run containers |
|---|---|---|
| Full self-hosting | `[process-ui]` + `[connector + admin UI]` | 2 |
| Semi-lightweight | `[process-ui]` + third-party `[connector + admin UI]` | 1 |
| Fully lightweight | third-party `[process-ui]` + third-party `[connector + admin UI]` | 0 |
| Headless integrator | `[connector + admin UI]` only, own systems on the local API | 1 |

Note what the small-party profile no longer needs: **a database container**. The file store is a
mounted volume holding JSON. A remotely running connector with one volume is a complete deployment.

## 4. The three API surfaces

The auth boundary is visible in the URL. Details in [PROTOCOL.md](PROTOCOL.md).

| Surface | Prefix | Auth | Callers |
|---|---|---|---|
| Peer | `/api/peer/v1/*` | JWS bearer, `did:web`-resolved | other connectors |
| Integration | `/api/local/v1/*` | API key + scopes, `X-Actor-Ref` | backoffice, own UI, the demo UI's BFF |
| Admin | `/api/admin/v1/*` | admin session | the connector's own admin UI |
| — | `/.well-known/did.json` | none | anyone. Static, not a surface. |

**No privileged path.** Our demo UI is an ordinary API-key client. There is no back door it uses and a
third party cannot.

### 4.1 The local API relays

An integrator calls its **own** connector, always, and never addresses a peer directly. The connector
reads the definition's `hostedBy`, works out whether it is the home node, and if not relays to the peer
signing with the participant's key:

```
POST  our-connector/api/local/v1/instances
      Authorization: ApiKey …          X-Actor-Ref: alice@acme.example
      { "definition": "container-transport@1.0.0",
        "participants": { "shipper": "did:web:acme…", "transporter": "did:web:vanmoer…" } }

  → hostedBy is `transporter`, that is not us
  → relay to  vanmoer/api/peer/v1/instances,  signed JWS
  → return the peer's 201 as our own
```

Two consequences. The integrator never learns which node hosts what, so `hostedBy` stays an
implementation detail of the connector rather than something every client must understand. And the
connector is the only thing that ever holds a signing key.

### 4.2 Two independent notions of delivery

These are separate mechanisms and must not be conflated:

| | Between | Channels | Nature |
|---|---|---|---|
| **Peer delivery** | connector ↔ connector | `webhook`, `stream` | Protocol. Declared on the connection. |
| **Local delivery** | connector → your own systems | `webhook`, SSE, later `queue` | Configuration. Declared on a notification subscription. |

A large party's "webhook into the backoffice" is *local* delivery. It has no protocol standing and the
peer on the other side neither knows nor cares about it.

### 4.3 Local notifications — how a party with no UI participates

The path that makes a fully automated participant possible. An operator configures **notification
subscriptions** in the admin UI; the connector then tells the party's internal systems when something
needs doing, and those systems answer on the local API.

The type that matters is **`action.required`**: the instance has entered a state where at least one
transition is available to one of our roles. *It is our turn.* This is computed rather than configured —
the connector asks the definition which transitions list one of our roles in `by` for the current state,
using the same `availableTransitions(definition, instance, roles)` function the UI uses to render its
buttons. One rule, three consumers: notifications, the UI, and the permission check.

| Type | Fires when |
|---|---|
| `action.required` | It is our turn to act |
| `action.cleared` | It no longer is — so a work queue can drain |
| `state.changed` | Any state change on an instance we are in |
| `event` | Every signed event, including pure data patches |

Each notification carries the **whole signed event**, so an internal system can verify independently
rather than trusting its own connector, plus the list of available transitions. That last part is what
turns a notification into an instruction: the internal system reads a transition id and posts it back.
It needs no copy of the definition and no state machine of its own.

Subscriptions are filterable by definition, kind, state and transition, so a backoffice hears only about
what it handles. Delivery is at-least-once and ordered per instance, retried with backoff, dead-lettered
on repeated failure, replayable from a cursor after an outage, and visibility-filtered exactly as a read
would be.

`channel` is a port. **`webhook` and `sse` now; queues (SQS, AMQP, Pub/Sub) later.** Adding a queue
adapter must not change subscriptions, notification types or the envelope — only the adapter. If it
does, this model is wrong. Full schema in
[PROTOCOL.md §4.4](PROTOCOL.md#44-local-delivery--notification-subscriptions).

## 5. The three artefacts

### 5.1 Definition

One document per process. See [DEFINITIONS.md](DEFINITIONS.md) for the annotated schema and
[definitions/](definitions/) for real examples.

```jsonc
{
  "@context": "https://pilots.example/process/v1",
  "id": "container-transport", "version": "1.0.0", "kind": "service",
  "roles": [ { "id": "shipper", "cardinality": 1 },
             { "id": "transporter", "cardinality": 1 } ],
  "hostedBy": "transporter",
  "initialState": "PENDING_CONTRACT",
  "terminalStates": ["DELIVERED", "CANCELLED"],
  "data": { /* JSON Schema for the instance's data document */ },
  "transitions": [ /* … */ ],
  "visibility": { "price": ["shipper", "transporter"] },
  "links": [ { "onEvent": "quotation:AGREED", "triggers": "startExecution" } ]
}
```

Two properties matter more than they look:

- **Multi-party is free.** A third participant is one more entry in `roles` plus its transitions. Not
  a redesign. This is the whole scaling argument: integration effort grows with the number of
  *processes*, not with the number of *pairs of companies*.
- **`links` is how parallel processes connect.** An instance may subscribe to another instance's
  event stream and auto-fire a transition when a matching signed event arrives. It earns itself
  immediately — it is how an agreed quotation starts the service execution waiting behind it — and it
  generalises to linking genuinely separate processes later.

### 5.2 Instance

```jsonc
{ "id": "018f2c…",
  "participantId": "…",
  "kind": "service",
  "definition": "container-transport@1.0.0",
  "participants": { "shipper": "did:web:acme-shipping.example",
                    "transporter": "did:web:vanmoer.example" },
  "quotationId": "018f2b…",
  "state": "ASSIGNED",
  "seq": 3,
  "data": { /* validated against the definition's `data` schema */ } }
```

The instance is **derived by folding its event log**, and also stored materialised so reads are cheap.
The log is the truth; the materialised document is a cache. Any peer can rebuild the instance from
events it has verified itself — which is what makes hosting a mechanical role rather than a position of
trust. Appending an event and updating the materialised document are **one atomic store operation**
(§7.1), because they must never diverge.

**A quotation is an instance too.** `kind: "quotation"`, its own definition, its own state machine.
A service instance references the quotation that authorised it via `quotationId`. The quotation may
still be running while the service instance exists — it just cannot leave `PENDING_CONTRACT` until the
quotation reaches `AGREED`.

### 5.3 Signed event

```jsonc
{ "header": { "instance": "018f2c…", "seq": 4, "transition": "quote",
              "actor": "did:web:vanmoer.example",
              "from": "REQUESTED", "to": "OFFERED",
              "at": "2026-08-24T09:14:02Z",
              "prev": "sha256:9f3c…",
              "payloadHash": "sha256:1a7b…" },
  "payload": { "price": { "value": 320, "currency": "EUR" } },
  "sig": "<JWS over the canonicalised header>" }
```

- The **signature covers the header only**, and the header commits to the payload by hash.
- The chain (`prev`) links headers, so a peer can verify the complete, unbroken history of an instance
  **even for events whose payload it was never allowed to see**. This is not an optimisation; it is
  the thing that makes field-level visibility and tamper evidence coexist.
- Canonicalisation is **JCS (RFC 8785)** before hashing or signing. Non-negotiable — skipping it is
  the classic cross-implementation interop bug.
- `actor` is the **participant's** DID. The human or system behind the call is recorded as unsigned
  local metadata and in the audit log, never in the signed header. See §6.

## 6. The three logs

Three records, three jobs. Conflating them is how you end up with an audit trail that is either
useless or a liability.

| Log | Where | Integrity | Leaves the node? | Answers |
|---|---|---|---|---|
| **Application** | stdout, structured JSON | none | to the operator's log sink | "what is it doing right now" |
| **Audit** | the store, append-only | locally hash-chained, unsigned | **never** | "who did what, and what was refused" |
| **Event** | the store, append-only | `prev` + `sig` | replicated to peers | "what happened to the business process" |

**The application log** must record every rejected authentication, every authorisation failure, and
every attempt to change something the caller was not entitled to change. The logger carries an `audit`
flag so an entry can be routed to the audit sink from its single call site, rather than requiring every
such site to write twice and stay in step.

**The audit log** exists because *failed actions produce no event at all*. A rejected connection
request, a `403` on an unentitled transition, a peer whose JWS did not verify, a chain verification
failure — none of these appear in the event log, because no event was ever created. It records the
actual caller: which API key or admin session, the asserted `X-Actor-Ref`, the peer DID and `jti`, the
endpoint, and the outcome. It is hash-chained, which costs one call to primitives M1 already builds and
buys tamper evidence on your own administrative trail with no key ceremony. It is never replicated: it
is nobody else's business.

**The event log** is the protocol artefact of §5.3.

## 7. Persistence

A document store behind a port. Three adapters, one conformance suite, configuration chooses.

| Profile | Adapter | Containers |
|---|---|---|
| unit and scenario tests | memory | 0 |
| dev, demo, small party | file, on a mounted volume | 0 |
| CI conformance | all three | 1, in CI only |
| large party | Mongo, or a managed cloud equivalent | 0 self-run |

Collections, each document carrying `participantId`: `participants`, `apiKeys`, `connections`,
`definitions`, `instances`, `events`, `attachments`, `idempotencyKeys`, `auditEntries`,
`subscriptions`, `deliveryQueue`, `deadLetters`, `timers`.

### 7.1 The port is shaped by two operations

Everything else is ordinary reads and writes. These two decide the interface:

```ts
// ONE atomic operation. Event and materialised instance must never diverge.
appendEvent(instanceId, expectedSeq, event, instanceAfter): Promise<Result<void, ConflictError>>

// Insert-if-absent, returning the stored result when the key is already present.
claimIdempotencyKey(key, participantId): Promise<StoredResult | null>
```

| Adapter | `appendEvent` | `claimIdempotencyKey` |
|---|---|---|
| memory | trivially atomic | map insert |
| file | per-instance lock, JSONL append, write-ahead marker | lock + file presence |
| mongo | unique index on `{instanceId, seq}`, insert-then-update, idempotent on replay | unique index |

The Mongo adapter lands at **M3**, not at the end. Memory and file are both in-process and
single-writer, so they hide precisely the contracts a networked store differs on. A port proven only
against them would need a signature change the first time a real store appeared — which is the retrofit
this design exists to prevent.

### 7.2 Stated limitation

The file adapter is **single-writer, single-process**. No horizontal scaling, no replicas. Correct for
the small profile, and a footgun if left unwritten.

There is no ORM, no SQL and no migrations. Note that SQL was never what constrained process
definitions: `instance.data` was always an opaque blob validated at the application layer against the
definition's JSON Schema. The gains here are no migrations, a dev store needing no infrastructure, and
storage that matches the JSON-native artefacts.

## 8. Hosting and the trust model

The definition names one role in `hostedBy`. That participant's connector is the home node for every
instance of that definition: it holds the authoritative record, assigns `seq`, and is the address every
other participant's connector talks to.

Peers do not take this on faith:

- Every transition is signed by the participant that made it. The host cannot invent a move by someone
  else, because it does not hold their key.
- Every event chains to its predecessor. The host cannot rewrite, reorder, or delete history without
  breaking the chain in a way every replica detects.
- Every peer keeps a full verified replica of the headers. A stalled or unavailable host does not
  destroy the record.

### 8.1 What this does not do

**The host holds the bytes.** Visibility rules govern who may read which fields; they do not blind the
host. Say this plainly whenever hosting comes up. If a field must genuinely be withheld from the host,
it does not belong in the instance — put a hash in the instance and exchange the value out of band.

**A hosted connector holds your signing key.** In the semi- and fully-lightweight topologies, the
hosting provider holds the participant's key. This is an **accepted** trade-off, on the same footing as
using a payment processor: the provider holds the key, and the answer is provider compliance rather
than architecture. `Signer` stays a plugin interface so a remote signer remains possible, but nothing
is blocked on it.

## 9. Connections

Two participants connect **before** any process runs. This replaces per-request callback URLs, and it
is where trust is established once instead of being re-derived on every message.

A connection holds: the peer's DID, its base URL, its status, and the **peer delivery** channel for
events in that direction:

| Delivery | How it works | Who it suits |
|---|---|---|
| `webhook` | We POST batches of signed events to one URL, registered once at handshake time. | Parties with a public endpoint. |
| `stream` | The peer holds an SSE connection to us and receives events on it; reconnects with `Last-Event-ID` and catches up. | Parties behind NAT, on a laptop, or unwilling to run a public HTTPS endpoint. |

Both carry **the identical signed event object**. Transport is configuration, not protocol. That is
what lets the same software serve a one-truck haulier and a terminal operator without a second
codebase — and it is why a small party never needs DNS, a certificate, or an inbound firewall rule.

Do not confuse this with local delivery into your own systems (§4.2).

Handshake and trust checks are specified in [PROTOCOL.md](PROTOCOL.md#3-connections).

## 10. Visibility

`visibility` maps a field path in the instance's data document to the roles that may read it. It is
applied on read (`GET …/instances/{id}`), on log replay, on the event stream, and on attachment
fetches — on **both** the peer and local surfaces. There is one enforcement point, and it is not the
caller's good manners.

The demo uses it for something real: the weighed gross mass is withheld from the requester until
payment is recorded. That is a genuine commercial rule, enforced by the runtime rather than by whoever
assembled the message.

The same filter is what would make a future view-only `public` surface
([PROTOCOL.md §11](PROTOCOL.md#11-deferred-a-public-view-only-surface)) cheap: the hard part is already
built.

## 11. Multi-tenancy readiness

The demo runs one participant per connector. The code does not assume it:

- Every document carries `participantId`.
- The signer interface takes a participant, not a global key.
- API keys are scoped to a participant.
- Configuration holds a *list* of participants.
- `did:web` supports path segments, so a hosted tenant has a real, resolvable DID:
  `did:web:connectors.example.com:t:acme`.

This is a few hours of care now. It is what makes the semi- and fully-lightweight topologies possible
without a rewrite — which is the only realistic path to onboarding parties too small to run any
infrastructure at all.

## 12. Cost targets

| Target | Value |
|---|---|
| Self-run containers, headless integrator | 1 |
| Self-run containers, with the demo process UI | 2 |
| Self-run containers, fully hosted | 0 |
| Database containers, small-party profile | **0** |
| Memory, small-party profile | < 150 MB |
| Containers for the full two-party demo | 4 — two connectors, two process UIs, **0 databases** |
| `docker compose up` → first transaction | < 60 s |
| Public HTTPS endpoint required | No, with `stream` delivery |
| Onboarding a participant | Publish one static `did.json`; accept one connection request |
| Full scenario suite (S0–S4) wall-clock | seconds, no containers |

These are acceptance criteria. Measure them; do not assert them.
