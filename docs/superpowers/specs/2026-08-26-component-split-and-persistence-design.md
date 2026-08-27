# Component split, persistence port, and test isolation

*Design decision record. 2026-08-26. Supersedes the M0 assumptions in `AGENT.md`, `docs/ARCHITECTURE.md`,
`docs/PROTOCOL.md` and `docs/ROADMAP.md` where they conflict. Those documents have been updated to match;
this file records **why**.*

Status: **accepted**. No implementation code exists yet, so every change here was free.

---

## 1. What prompted this

Four requirements arrived after the M0 documents were written:

1. Split the UI from the backend. Integrating your own UI or backend services with the connector must be
   well supported, not an afterthought. The connector's embedded UI shrinks to a minimal **admin** UI —
   API keys, trusted connectors, settings — and process management moves to a separate deployable.
2. Move to a document store. Local testing and the minimal demo should be able to run on JSON files on a
   mounted volume; mature deployments use MongoDB or a cloud equivalent. The repository layer stays
   configurable, because that is the part that is expensive to retrofit.
3. Scenarios must be testable without external dependencies. Fully isolated test runs, no exceptions.
4. If end-to-end testing is added, prefer Playwright.

Three of the four broke a stated non-negotiable. None of them required a redesign.

## 2. Decisions

| # | Decision | Alternative rejected |
|---|---|---|
| D1 | Three deployables: `apps/connector` (core + admin UI), `apps/process-ui` (demo process management), and the shared packages. | Keeping one container that serves both UIs. Rejected: it makes "bring your own UI" a special case rather than the normal path. |
| D2 | Two shared packages only — `protocol` and `client`. Anything that is a pure connector internal stays inside `apps/connector`. | A `packages/store`. Rejected as over-packaging: nothing outside the connector consumes the repository port. |
| D3 | Three authenticated API surfaces, separated by path prefix: `/api/peer/v1`, `/api/local/v1`, `/api/admin/v1`. | One surface with mixed auth. Rejected: the auth boundary must be visible in the URL. |
| D4 | The local API relays transparently by `hostedBy`. An integrator never learns which node hosts what. | Explicit peer targeting (`/peers/{did}/instances`). Rejected: leaks the hosting model into every client. |
| D5 | Integration auth is an API key with scopes plus an asserted `X-Actor-Ref`. The connector authenticates the *client*, not the person. | The connector as identity provider for external UIs. Rejected: a third-party-hosted connector would end up holding your user accounts, which cuts against the lightweight hosting story. |
| D6 | `actorRef` stays **outside** the signed event header. | Signing it. Rejected: peers do not need employee identities, and a replicated chain cannot be retracted. |
| D7 | Three logs with three jobs: application (stdout), audit (local, hash-chained), event (signed, replicated). | Folding operational logging into the audit log. Rejected: different durability, different retention, different audience. |
| D8 | Persistence is a port with memory / file / mongo adapters and one conformance suite. Mongo lands at M3. | Mongo at M6. Rejected: memory and file are both single-writer and in-process, so they hide precisely the contracts a networked store differs on. |
| D9 | Hermetic tests are a non-negotiable. `Clock`, `IdGenerator`, `Signer` and peer `Transport` are injectable ports. Two connectors run in one test process. | Proving scenarios only through Playwright. Rejected: it puts all confidence in the slowest, flakiest tier. |
| D10 | Playwright covers wiring and UI only, and most likely runs against local processes rather than containers. | Playwright as the primary scenario proof. Rejected, see D9. |
| D11 | **Both parties run the demo process UI in the first real demo.** The mock backoffice sits alongside Van Moer's UI, not instead of it. | Only the small party getting a UI. Rejected: the first demo has to be verifiable by hand on both sides, and a UI-less party is harder to demonstrate than to build. |
| D12 | **Notification subscriptions** are how a party with no UI participates. `action.required` is computed from the definition. `channel` is a port: `webhook` + `sse` now, queues later. | Leaving "register a webhook" underspecified. Rejected: an internal system needs to know *when it is its turn*, and deriving that from a raw event firehose would force every integrator to reimplement the state machine. |
| D13 | **No participant is typed.** Supplier/consumer is a role in one instance. Home node resolves **per instance**; offerings are runtime store records. Proven by scenario test S5, not by the demo. | Treating supplier and consumer as deployment profiles. Rejected: it would make subcontracting — a transporter supplying a forwarder while consuming from another transporter — a redesign rather than ordinary use. |

## 3. Components

```
pilots-service/
  packages/protocol/       THE SPEC. Zod schemas, JCS, sign/verify, evaluator,
                           visibility filter, linter, JSON Schema export.
                           Consumed by everything; also the reference for
                           non-TypeScript implementers.
  packages/client/         Typed local-API client + OpenAPI document.
                           The integration surface. Consumed by process-ui,
                           published for third parties.
  apps/connector/          Core. Three API surfaces + admin UI, built in and
                           served by it.  →  container 1
    src/store/             Repository port, memory/file/mongo adapters,
                           conformance suite. Connector-internal by design.
    src/admin-ui/          Minimal admin UI.
  apps/process-ui/         Demo process management. BFF (holds the API key,
                           owns its own user accounts) + SPA.
                           →  container 2, optional
  tests/e2e/               Playwright.
```

**Boundary rule**, lint-enforced: `apps/process-ui` may import `packages/client` and `packages/protocol`.
It may never import from `apps/connector`. If the demo UI needs something the connector does not expose on
the local API, that is a gap in the local API, not a reason to reach inside.

`apps/process-ui` cannot be a static SPA, because it holds an API key. It is a thin server plus a SPA, and
that server owns its own user accounts.

### 3.1 Deployment topologies

| Setup | Self-run containers |
|---|---|
| Full self-hosting — `[process-ui]` + `[connector + admin UI]` | 2 |
| Semi-lightweight — `[process-ui]` + third-party `[connector + admin UI]` | 1 |
| Fully lightweight — both third-party hosted | 0 |
| Headless integrator — own systems against the local API, no demo UI | 1 |

The small profile needs no database container at all. The cost story is better than it was before this
change, not worse.

### 3.2 The hosted-connector trade-off

A third-party-hosted connector holds the participant's signing key, unless and until a remote signer
implementation exists. This is an **accepted limitation**, on the same footing as using a payment processor:
the provider holds the key, and the answer is provider compliance, not architecture. Documented plainly,
not treated as unresolved. `Signer` remains a plugin interface so a remote signer is possible later.

## 4. API surfaces

| Surface | Prefix | Auth | Callers |
|---|---|---|---|
| Peer | `/api/peer/v1/*` | JWS bearer, `did:web`-resolved | other connectors |
| Integration | `/api/local/v1/*` | API key + scopes, `X-Actor-Ref` | own backoffice, own UI, the demo UI's BFF |
| Admin | `/api/admin/v1/*` | admin session (Better Auth) | the admin UI |
| — | `/.well-known/did.json` | none | anyone. Static, not a surface. |

**No privileged path.** Anything the demo UI can do, a third party's UI can do, over the same surface with
the same auth. This is the whole content of "bring your own UI is well supported"; if it is ever violated,
the claim is false.

### 4.1 Two independent notions of delivery

The M0 documents conflated these. They are separate:

- **Peer delivery** — connection-level, `webhook` or `stream`, connector ↔ connector. Protocol.
- **Local delivery** — integration-level, `webhook` or SSE, connector → your own systems. Configuration.

Van Moer's mock backoffice in S1 and S2 is the *second* kind. `ARCHITECTURE.md §3` previously drew it on the
same line as connection delivery, which implied a protocol role it does not have.

### 4.2 Relay error semantics

The local API relays to the home node. A `409` or `422` from the home node passes through unchanged, because
it is the integrator's problem to resolve. A peer that is unreachable is **not** the same thing and gets its
own RFC 7807 problem type. Collapsing the two would make a network fault look like a business conflict.

### 4.3 Future: a fourth `public` surface

Deferred, non-blocking, recorded so it is a choice rather than an omission.

A party involved in a process but not running a connector should be able to watch it progress. The shape:
a long-lived, view-only token embedded in a URL, resolving to a filtered read of one instance, on a fourth
`/api/public/v1/*` surface. It reuses the existing visibility filter, so the hard part is already built in M1.
Not scheduled. See `ROADMAP.md`.

## 5. API keys and actor identity

An API key record holds: `participantId`, label, hashed secret, scopes, created-by, created-at,
last-used-at, revoked-at, optional expiry. The secret is hashed at rest and displayed once at creation.

Scopes, deliberately few: `instances:read`, `instances:write`, `events:read`, `attachments:read`,
`attachments:write`, `connections:read`, `definitions:read`. Per-definition or per-role scoping is a named
later refinement.

`X-Actor-Ref` is an opaque, length-limited string identifying the human or system behind the call. It is
**asserted, not proven** — the connector authenticates the key, not the person. It is recorded in the audit
log and as unsigned local metadata on the event. It is never part of the signed header, and therefore never
replicated to peers.

This also closes an existing gap: `PROTOCOL.md §1.2` promised that a person's identity is "recorded as
metadata on the event", but no header or record field existed to hold it.

## 6. Three logs

| Log | Where | Integrity | Leaves the node? | Answers |
|---|---|---|---|---|
| **Application** | stdout, structured JSON (CloudWatch-shaped) | none | to the operator's log sink | "what is this process doing right now" |
| **Audit** | the store, append-only, locally hash-chained | `prev = sha256(JCS(previous))`, unsigned | never | "who did what here, and what was refused" |
| **Event** | the store, append-only, hash-chained and signed | `prev` + `sig` per event | replicated to peers | "what happened to this business process" |

### 6.1 Application log

Ordinary structured logging. It **must** record every rejected authentication, every authorisation failure,
and every attempt to change something the caller was not entitled to change — the class of event that, by
definition, produces no business event.

The logger exposes a flag so an entry can be marked for the audit sink at its single call site, rather than
requiring every such site to write to two places and stay in step:

```ts
log.warn({ audit: { action: 'transition.apply', outcome: 'denied', subject: { instance } },
           problem: 'urn:pilots:problem:role-not-permitted' },
         'transition refused')
```

One call, two destinations. Which entries carry `audit` is a deliberate choice per call site, not a level
threshold.

### 6.2 Audit log

```jsonc
{ "seq": 41, "at": "2026-08-26T09:14:02Z", "participantId": "…",
  "category": "admin" | "local" | "peer",
  "action":  "apiKey.create" | "connection.accept" | "transition.apply" | "chain.verify" | …,
  "actor":   { "kind": "adminSession" | "apiKey" | "peer" | "runtime",
               "id": "…", "actorRef": "alice@acme.example" },
  "subject": { "instance": "018f2c…" },
  "outcome": "ok" | "denied" | "failed",
  "problem": "urn:pilots:problem:…",
  "request": { "method": "POST", "path": "…", "ip": "…", "jti": "…" },
  "prev":    "sha256:…" }
```

Mutations and denials are always recorded. Read-auditing is configurable and defaults to denials only,
or the log drowns in `GET`s.

Why this log has to exist: **failed actions produce no event at all.** A rejected connection request, a `403`
on an unentitled transition, a peer whose JWS did not verify, a chain verification failure — none of these
appear anywhere in the event log, because no event was ever created. Before this change there was no record
that they happened.

It is hash-chained because that costs one call to primitives M1 already builds, and it gives tamper evidence
on your own administrative trail with no key ceremony. It is not signed and not replicated: it is nobody
else's business.

## 7. Persistence

`apps/connector/src/store/` — one port, three adapters, one conformance suite.

Collections, every document carrying `participantId`: `participants`, `apiKeys`, `connections`,
`definitions`, `instances`, `events`, `attachments`, `idempotencyKeys`, `auditEntries`, `deliveryQueue`,
`timers`.

### 7.1 The port is shaped by two operations

Everything else is ordinary reads and writes. These two decide the interface:

```ts
// ONE atomic operation. The event and the materialised instance must never diverge.
appendEvent(instanceId, expectedSeq, event, instanceAfter): Promise<Result<void, ConflictError>>

// Insert-if-absent, returning the stored result when the key is already present.
claimIdempotencyKey(key, participantId): Promise<StoredResult | null>
```

| Adapter | `appendEvent` | `claimIdempotencyKey` |
|---|---|---|
| memory | trivially atomic | map insert |
| file | per-instance lock, JSONL append, write-ahead marker for crash safety | lock + file presence |
| mongo | unique index on `{instanceId, seq}`, insert-then-update, idempotent on crash replay | unique index |

Getting these two right is the entire reason the Mongo adapter lands at M3 rather than M6. A port designed
only against in-process single-writer adapters would need a signature change the first time a networked
store appeared — which is the retrofit this decision exists to prevent.

### 7.2 Profiles

| Profile | Adapter | Containers |
|---|---|---|
| unit and scenario tests | memory | 0 |
| dev, demo, small party | file, on a mounted volume | 0 |
| CI conformance | all three (mongo tagged, excluded from the unit run) | 1, in CI only |
| large party | mongo, or a managed cloud equivalent | 0 self-run |

**Stated limitation:** the file adapter is single-writer and single-process. No horizontal scaling, no
replicas. Correct for the small profile, and a footgun if left unwritten.

Dropped from the stack: `drizzle-orm`, SQLite, Postgres. The document store is not what makes process
definitions unconstrained — `instance.data` was always an opaque blob validated at the application layer
against the definition's JSON Schema, and `jsonb` would have held anything. The real gains are no
migrations, a dev store that needs no infrastructure, and storage that matches the JSON-native artefacts.

## 8. Testing

**Non-negotiable: no unit, contract or scenario test may require a network, a container, a real clock, or a
filesystem outside a temporary directory.** Enforced structurally, by making everything external a port:
`Clock`, `IdGenerator`, `Signer`, peer `Transport`, and the repository.

| Tier | Scope | Dependencies |
|---|---|---|
| `unit` | Pure functions in `packages/protocol` | none |
| `contract` | Repository conformance suite | memory + file always; mongo tagged, CI only |
| `scenario` | S0–S4 end to end, **two connector instances in one process** | none |
| `e2e` | Playwright: process UI → connector → connector → mock backoffice, plus admin flows | local processes; containers only for S4c |

The load-bearing tier is `scenario`. An in-process `Transport` wires two connector instances directly to
each other, so a full two-party run needs no HTTP, no ports and no containers. Consequences worth naming:

- **S4a (offline catch-up)** becomes a test that drops the transport, advances the instance, reattaches, and
  asserts convergence. Milliseconds.
- **S4b (tamper detection)** becomes a test that mutates a stored event and asserts a hard verification
  failure. Milliseconds.
- **Deadlines** are tested by advancing a fake clock. No test sleeps, ever.

Both were manual demo steps in the M0 roadmap. They are the two most important behaviours in the design and
they should not be things a person checks by hand.

Playwright then only has to prove that the wiring and the UI work. It never carries the burden of proving
protocol behaviour, which is what stops all the confidence in a system from ending up in its slowest and
flakiest tier.

Test signing keys are generated at test setup. No private key is ever committed, including as a fixture.

## 9. Non-negotiables, consolidated

The list was heading for sixteen entries. It is now ten, by merging entries that state one idea twice. No
decision was dropped; `AGENT.md` carries the authoritative version.

| Was | Now |
|---|---|
| 1, 2 | unchanged — one primitive, every change is a transition |
| 3, 4 | merged — multi-party from day one (`roles` cardinality + `hostedBy`) |
| 5, 6 | merged — the event log is the record (chaining + the three mechanisms) |
| 7 | unchanged — connections are first-class |
| 8, 10, + API surfaces | merged — three surfaces, three auth layers, no privileged path |
| — | new — three logs, three jobs |
| 9, + persistence | merged — persistence is a port, documents carry `participantId` |
| 12, + hermetic tests | merged — everything external is a port, and tests are hermetic |
| 11 | unchanged — timers and abort paths from the start |

## 10. Roadmap impact

| Milestone | Change |
|---|---|
| M1 | Unchanged in spirit. Adds API key and audit entry schemas, and the `Clock` / `IdGenerator` port definitions. |
| M2 | Adds the store (port + memory + file + conformance). Connector carries all three surfaces. API keys, scopes, audit log. **The admin UI starts here** — a key has to be mintable. Exit moves to the *local* API. |
| M3 | **Scenario harness and in-process transport land first**, so S1/S2/S4a/S4b are hermetic tests before the container demo exists. Mongo adapter and conformance in CI. Admin UI gains connection accept and reject. |
| M4 | Unchanged, plus fake-clock deadline tests. |
| M5 | Narrows to `apps/process-ui`, `packages/client` + OpenAPI, and Playwright. The admin UI already shipped incrementally. |
| M6 | Managed document store replaces the Postgres profile. Cost targets remeasured against the 0 / 1 / 2-container topologies. |

The admin UI moving out of M5 matters: it is needed to *operate* M2 and M3. "Minimal" is what makes growing
it incrementally viable.

## 11. Open, deliberately

- **The `public` view-only surface** (§4.3). Not scheduled.
- **Per-definition or per-role API key scoping.** Flat scopes for the pilot.
- **A remote signer.** The interface exists; no second implementation is planned. §3.2 explains why this is
  acceptable rather than urgent.
- **Whether Playwright uses local processes or containers by default.** Local processes look lighter and
  sufficient. Not committed; revisit when there is something to run.


---

## 12. Amendment, 2026-08-26 — the demo runs two UIs, and internal systems get notified

Two additions after the first review. Neither changes the model; both make it demonstrable.

### 12.1 Both parties run the process UI (D11)

The first cut had Acme clicking and Van Moer automated, to dramatise "small consumer, large supplier, one
stack". Good slide, bad first demo: half of it could only be verified by reading logs.

So the demo runs **four containers** — two connectors, two process UIs, still zero databases — and every
step is drivable by hand on either side. Van Moer's mock backoffice then sits *alongside* its UI, which
turns out to be the better demonstration anyway: run the same scenario twice, once clicked and once
unattended, and show that the connector cannot tell the difference. The claim survives, and it is now
something you watch rather than something you are told.

Cost targets and S4c updated to four containers. The per-party numbers (2 self-hosting, 1 headless, 0
fully hosted) are unchanged.

### 12.2 Notification subscriptions (D12)

"Local delivery" existed before this amendment, but only as *register a webhook and we will POST events at
it*. That is not enough to run a party with no UI, for one specific reason: **a raw event stream does not
tell a system when it is that system's turn.** Deriving it would mean every integrator reimplementing the
state machine — which is exactly the thing this whole design exists to avoid.

So the model is:

- **A subscription** is admin-configured state: a channel, a target, the notification types wanted, and
  filters on definition / kind / state / transition. Registered once, owned by the operator.
- **`action.required`** is the type that matters — the instance entered a state where a transition is
  available to one of our roles. It is **computed, not declared**: the connector asks the definition,
  via the same `availableTransitions(definition, instance, roles)` function the UI uses to render its
  buttons. Nothing new appears in a definition to support it.
- **The envelope carries the whole signed event plus the available transitions.** So an internal system
  can verify independently instead of trusting its own connector, and can act by echoing back a
  transition id — no definition copy, no state machine, no polling.
- **`channel` is a port.** `webhook` (HMAC-signed, so the internal network boundary is authenticated) and
  `sse` now. **Queues — SQS, AMQP, Pub/Sub — later, as adapters.** The test of whether this model is
  right: adding a queue must not change subscriptions, notification types, or the envelope. If it does,
  come back and fix this section.
- Delivery is at-least-once and ordered per instance, retried with backoff, dead-lettered, replayable
  from a cursor, and visibility-filtered exactly as a read would be.

Three consequences worth naming.

**One rule, three consumers.** `availableTransitions` is a pure function in `packages/protocol` (M1), and
notifications, UI buttons and the permission check all read from it. They cannot disagree about who may
act, because there is only one place that decides.

**An automated participant becomes a test fixture.** Subscribe to `action.required`, post back the
transition it names. S1 then runs with no UI and no human in it, inside the scenario tier, against an
in-memory channel adapter — so notification behaviour is covered without a webhook receiver, which is
precisely the kind of dependency that would otherwise smuggle a container into the fast tests.

**A dead backoffice is not a broken process.** A failing subscription degrades and dead-letters; the
instance is untouched and catches up on replay. Local delivery has no protocol standing, and this is
where that pays off.

### 12.3 Where it landed

| Milestone | Notification work |
|---|---|
| M1 | `availableTransitions`, and the subscription + envelope schemas |
| M2 | Admin CRUD for subscriptions, the `NotificationChannel` port, in-memory adapter |
| M3 | `webhook` and `sse` adapters, `action.required` / `action.cleared`, filtering, backoff, dead letters, cursor replay. **Exit adds: S1 runs with an automated participant.** |
| later | Queue adapters. Additive by construction. |

---

## 13. Amendment, 2026-08-26 — role symmetry (D13)

### 13.1 What was wrong

`ARCHITECTURE.md §8` said:

> The definition names one role in `hostedBy`. That participant's connector is the home node for **every
> instance of that definition**.

That is false, and the error is not cosmetic. A definition names a *role*; only an instance names the
*participant* filling it. So the same definition has different home nodes for different instances:

```
container-transport, hostedBy: "transporter"

  instance 1   { shipper: FF, transporter: A }   →  home node: A
  instance 2   { shipper: A,  transporter: B }   →  home node: B
```

Transporter A is provider in one and requester in the other, concurrently, under one definition. Its
connector is authoritative for instance 1 and a verifying replica of instance 2, with both in the same
store and the same instance list.

The surrounding prose reinforced the mistake by pairing deployment profile with business role — "small
consumer, large supplier", "that difference, and only that difference, separates the haulier from the
terminal operator". Those two axes are independent, and conflating them in the *documentation* is how it
ends up conflated in the *code*.

### 13.2 The rule

- **Home node resolves per instance, in two steps**: definition → `hostedBy` role; instance →
  `participants[role]`. The stored instance carries the resolved `home` flag so it is answered once.
- **A participant becomes a supplier by publishing an offering** — a store record with `participantId`,
  created and withdrawn in the admin UI at runtime. Not a config file, not a build flag, not a mode.
  Withdrawing it does not affect running instances; offerings govern discovery only.
- **One connection, both directions.** No supplier connection, no consumer connection.
- **`action.required` already works** without change, because it is computed from *our roles in that
  instance*. This is a second dividend from D12 having made it computed rather than declared.
- Deployment profile (store adapter, delivery channel, public endpoint) is orthogonal to role, and the
  documents must stop implying otherwise.

### 13.3 Why this is a test and not a demo

The demo runs one direction — Acme consumes, Van Moer supplies — which is enough to exercise the
protocol and is the right scope. But it means **a per-definition hosting shortcut passes every demo and
every happy path.** An implementation could cache "we host `container-transport`" and nothing in S0–S4
would notice.

Hence **S5**, scenario-test-only: three participants, one definition, two instances with opposite
participants, asserting different home nodes and `action.required` firing for both of A's roles. It is
cheap only because the M3 harness can already run two connectors in one process — an unplanned dividend
from D9.

Landed in M2 (offerings, per-instance `home` resolution from the first write) and M3 (S5 in the exit
criteria).

### 13.4 The honest scope note

Symmetry is designed and tested, not demonstrated. The first demo stays one-directional. When someone
asks whether a party can be both, the answer is "yes, and there is a test for it" — not "yes, in
principle".
