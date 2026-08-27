# Roadmap

*From an empty repo to S1 and S2 running. Every milestone ends in something you can show someone, not
in a document.*

## Guiding constraints

1. **`docker compose up`, one command, under a minute.** If a milestone adds a container or a
   dependency, it must say what that buys.
2. **`packages/protocol` is the spec.** Behaviour that is not a schema or a tested function there is
   not decided. This is the one rule that prevents documentation and runtime from drifting apart.
3. **Signatures are stubbed behind an interface until M3.** In dev mode the connector trusts the
   asserted DID. Real crypto must not block the state machine — but the interface must exist from M1 so
   that switching it on is a configuration change, not a refactor.
4. **Tests stay hermetic.** No milestone may introduce a unit, contract or scenario test that needs a
   network, a container or a real clock. See [TESTING.md](TESTING.md).

---

## M1 — The protocol package

One package, no server. This is the milestone that decides whether the design is real.

- Zod schemas: definition, instance, event header, event, connection, offering, **API key, audit entry**.
- JCS canonicalisation (RFC 8785), `sha256` helpers, event-header hashing, **audit-entry chaining**
  (the same primitive, applied to a second chain).
- `Signer` interface + local Ed25519 implementation; `verify()` against a resolved `did:web` document.
- **`Clock` and `IdGenerator` port definitions**, with deterministic test implementations. Nothing
  downstream may read the wall clock or generate an id directly.
- Chain verification: given an ordered list of headers, confirm `prev` linkage, `from`/`to` continuity
  and signatures. Must pass with **redacted payloads**.
- State machine evaluator: given a definition, a current instance and a proposed transition, return the
  next instance or a typed error. Pure function, no I/O.
- **`availableTransitions(definition, instance, roles)`** — which transitions this participant may fire
  right now. One rule with three consumers: `action.required` notifications, the UI's buttons, and the
  permission check. Pure function; belongs here so the three cannot disagree.
- JSON Merge Patch (RFC 7386) application and patch-schema validation.
- Visibility filter: given a definition, a role and an instance or event, return the filtered view.
- Definition linter, replacing `tools/lint-definitions.py` (then delete that file).
- JSON Schema export, so the definitions can be validated by non-TypeScript implementations.

**Exit:** `pnpm --filter protocol test` is green; the five definitions in `docs/definitions/` load and
lint; a tampered event fails verification; a redacted event does not.

## M2 — The connector, single party

`apps/connector`. NestJS + Fastify. No database container.

- **The store**: repository port, memory and file adapters, and the conformance suite
  ([TESTING.md §3.2](TESTING.md#32-contract)). `participantId` on every document from the first write.
  The two operations that shape the port — atomic `appendEvent`, `claimIdempotencyKey` — are the ones
  the suite is really about.
- Definition registry: load from disk, verify content hash, cache, serve.
- **All three API surfaces exist from the start**, even where thin: `/api/peer/v1`, `/api/local/v1`,
  `/api/admin/v1`. Retrofitting a surface split later would touch every route.
- **API keys and scopes**: creation, hashing at rest, revocation, scope enforcement, `X-Actor-Ref`.
- **The audit log**: hash-chained, every admin action, every mutating local call, every refusal.
- **The application logger**: structured stdout, with the `audit` flag that routes an entry to the audit
  sink from one call site.
- `POST /instances`, `GET /instances[/{id}]`, `POST /instances/{id}/transitions`,
  `GET /instances/{id}/events` on the local surface, running against the M1 evaluator.
- `If-Match` / `409` / `428`, `Idempotency-Key`, RFC 7807 errors.
- `auto` transitions fire on state entry — which is what makes standing quotations work.
- `GET /.well-known/did.json` served from configuration.
- **Notification subscriptions**: the schema, admin CRUD, and the `NotificationChannel` port with the
  in-memory adapter. Delivery machinery itself lands in M3; the model exists here so the store and the
  admin UI carry it from the first write.
- **The admin UI starts here**, minimal: mint and revoke an API key, browse the audit log, register a
  notification subscription. It is needed to *operate* this milestone.

**Exit:** one container, no database. S1's full weighing sequence runs against the **local API** with
`curl` and an API key, single-party, no counterparty. Visibility filtering demonstrably withholds
`grossMass` before `PAID`. The audit log shows every call, including a deliberately refused one.

## M3 — Two connectors: connections, delivery, replication, and the scenario harness

The milestone where it becomes a *shared* process. The harness comes **first**, because it is what makes
the rest of the milestone testable.

- **The in-process `Transport` and the scenario harness**: two connector instances in one process, fake
  clock, memory store. S0–S2 become hermetic tests before a container demo exists.
- Connection handshake — request, accept, accepted, rejected — with `did:web` resolution and the
  domain-binding check. Accept and reject on the **admin** surface; `accepted` / `rejected` on the
  **peer** surface. Config-seeded connections as a demo shortcut.
- **Peer delivery**: `webhook` push with backoff, and `stream` (SSE) with `Last-Event-ID` catch-up. Both
  emit the identical signed event object.
- **Local delivery / notifications**: the `webhook` and `sse` channel adapters, `action.required` and
  `action.cleared` computed from `availableTransitions`, subscription filtering, at-least-once ordered
  delivery, backoff, dead letters, and cursor replay. Kept clearly distinct from peer delivery.
  Queue adapters are explicitly **not** built here — the port is what makes them a later, additive change.
- **The relay**: the local API resolves `hostedBy` and forwards to the home node, with the
  `peer-unreachable` / `peer-response-invalid` problem types kept separate from a real `409`.
- Peer replication: verified local replica of every instance the participant is in; `?since=` pull as the
  authoritative recovery path.
- Node-to-node auth switched on: JWS bearer, DID resolution, `aud` and `exp` checks, `jti` replay
  rejection. Dev-mode trust becomes a flag that refuses to start under production config.
- Event signing switched on for real.
- **The Mongo adapter**, running the same conformance suite in CI. This is where a single-writer
  assumption would first bite, and the port is still cheap to change.
- Admin UI gains connection accept / reject and the trusted-peer allowlist.

**Exit:** **S4a and S4b pass as scenario tests, in milliseconds, in `pnpm test`** — those are the
milestone's real acceptance tests, not the happy path. Plus: **S1 runs with an automated participant** —
a test fixture that subscribes to `action.required` and posts back the transition it names, with no UI
and no human in the loop. Then, separately: two containers, `docker compose up`, S1 runs end to end
across both, and each side's replica verifies against the other's.

## M4 — Quotations, links, deadlines

- `POST /instances` accepting a `quotationId`; quotation and service instances side by side.
- `links` evaluation: subscribe to a related instance's events, fire the named transition on a match,
  and record *which signed event* caused the advance.
- Deadline scheduling and `onDeadline` firing; transitions with `by: []` invocable only by the runtime.
  **Tested by advancing the fake clock — no test sleeps.**
- Attachments: content-addressed store, upload, `GET /attachments/{sha256}`, visibility-filtered on both
  surfaces.
- `GET /offerings`, including standing quotations.

**Exit:** **S2 runs end to end as a scenario test and across two containers**, including the
counter-offer loop, the auto-started service instance, the `409` on a stale `If-Match`, and an offer
expiring on its deadline.

## M5 — The process UI and the integration surface

`apps/process-ui` as its **own container**, and the client package that makes it replaceable. The admin
UI already shipped incrementally in M2 and M3.

- **`packages/client`**: typed local-API client plus an OpenAPI document, so a non-TypeScript integrator
  can generate their own. The same export discipline as M1's JSON Schema export.
- `apps/process-ui`: BFF holding one API key and owning its own user accounts, plus the SPA.
- Offerings browser; start a quotation or a service instance.
- Instance list and detail: current state, the data document as the caller may see it, and the
  available transitions for *this* participant's role — rendered generically from the definition, so a
  new definition needs no UI work.
- Event log with per-event verification status. **A broken chain must be loud and red.**
- **The boundary lint rule**: `apps/process-ui` may import `packages/client` and `packages/protocol`,
  never `apps/connector`.
- **Playwright** arrives: process UI flows plus the admin flows (mint a key, accept a connection, read
  the audit log, see a red chain). Wiring and UI only.

**Exit:** S1 and S2 driven entirely through the process UI **on both sides** — every step verifiable and
demonstrable by hand, which is what the first real demo needs. Then the same runs again with Van Moer's
UI idle and its mock backoffice driving instead, over a notification subscription: same process, same
connector image, advancing unattended. **And: either process-UI container can be stopped without the
connector caring**, which is the split's whole point.

## M6 — Measure and harden

- The managed document-store profile for the large party; the file store stays the small-party default.
- The mock backoffice as a separate tiny service, so "large supplier automates, small consumer clicks"
  is a real deployment difference rather than a slide.
- **S4c**: a `bench` script that prints containers, resident memory, cold-start time and
  time-to-first-transaction, **for each of the four topologies** (0, 1, 1 and 2 self-run containers per
  party; 4 for the full two-party demo). Record the numbers in `ARCHITECTURE.md §12`.
- Retries, dead letters, replay from log, and re-hosting a stalled instance from a replica.
- Multi-participant-per-connector exercised at least once in a test, to keep the hosted path honest.
- Audit log retention and export.

**Exit:** the cost targets in `AGENT.md` are measured, not claimed. S1, S2, S4a, S4b and S4c all run
from one command.

---

## Deliberately not in scope yet

Named so they are choices rather than omissions:

- **A `public` view-only surface.** A long-lived token in a URL, letting a party with no connector watch
  a process progress. The visibility filter it needs is built in M1, so this is mostly token issuance
  and revocation plus a decision about which role the viewer is filtered as. See
  [PROTOCOL.md §11](PROTOCOL.md#11-deferred-a-public-view-only-surface).
- **Queue channels for notifications** (SQS, AMQP, Pub/Sub). `webhook` and `sse` cover the pilot. The
  `NotificationChannel` port and the subscription model are built so a queue adapter is additive — if
  adding one requires changing subscriptions, notification types or the envelope, that is a design bug.
- **Per-definition or per-role API key scoping.** Flat scopes for the pilot.
- **Verifiable credential gates on transitions.** The hook belongs in the definition schema now
  (`requiresCredential`); enforcement can wait.
- **Remote signers.** The `Signer` interface exists from M1; a second implementation is a later day. A
  hosted connector holding the participant's key is an accepted trade-off, not a blocker — see
  [ARCHITECTURE.md §8.1](ARCHITECTURE.md#81-what-this-does-not-do).
- **A federated catalogue.** A definition is a URL and a participant is a DID, so discovery can be
  layered on top without touching the execution core.
- **Publishing the event log as a stream for third parties.** The visibility filter is the hard part
  and it is built in M1; publication is plumbing.
- **Horizontal scaling of the small profile.** The file adapter is single-writer by design. Scaling out
  means moving to the document-store profile, not making the file store clever.
- **Anything that requires a counterparty to run a workflow engine.** A party must always be able to
  integrate with two HTTP calls and one event connection. If that stops being true, the design has
  regressed.
