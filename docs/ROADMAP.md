# Roadmap

*From an empty repo to S1 and S2 running. Every milestone ends in something you can show someone, not
in a document.*

## Guiding constraints

1. **`docker compose up`, one command, under a minute.** If a milestone adds a container or a
   dependency, it must say what that buys.
2. **`packages/protocol` is the spec.** Behaviour that is not a schema or a tested function there is
   not decided. This is the one rule that prevents documentation and runtime from drifting apart.
3. **Signatures are stubbed behind an interface until M3.** In dev mode the node trusts the asserted
   DID. Real crypto must not block the state machine — but the interface must exist from M1 so that
   switching it on is a configuration change, not a refactor.

---

## M1 — The protocol package

One package, no server. This is the milestone that decides whether the design is real.

- Zod schemas: definition, instance, event header, event, connection, offering.
- JCS canonicalisation (RFC 8785), `sha256` helpers, event-header hashing.
- `Signer` interface + local Ed25519 implementation; `verify()` against a resolved `did:web` document.
- Chain verification: given an ordered list of headers, confirm `prev` linkage, `from`/`to` continuity
  and signatures. Must pass with **redacted payloads**.
- State machine evaluator: given a definition, a current instance and a proposed transition, return the
  next instance or a typed error. Pure function, no I/O.
- JSON Merge Patch (RFC 7386) application and patch-schema validation.
- Visibility filter: given a definition, a role and an instance or event, return the filtered view.
- Definition linter, replacing `tools/lint-definitions.py` (then delete that file).
- JSON Schema export, so the definitions can be validated by non-TypeScript implementations.

**Exit:** `pnpm --filter protocol test` is green; the five definitions in `docs/definitions/` load and
lint; a tampered event fails verification; a redacted event does not.

## M2 — The node, single party

`apps/node`. NestJS + Fastify, Drizzle, SQLite.

- Drizzle schema — `participants`, `connections`, `definitions`, `instances`, `events`, `attachments`,
  `idempotency_keys`. **`participantId` on every table from the first migration.**
- Definition registry: load from disk, verify content hash, cache, serve.
- `POST /instances`, `GET /instances[/{id}]`, `POST /instances/{id}/transitions`,
  `GET /instances/{id}/events` — running against the M1 evaluator.
- `If-Match` / `409` / `428`, `Idempotency-Key`, RFC 7807 errors.
- `auto` transitions fire on state entry — which is what makes standing quotations work.
- `GET /.well-known/did.json` served from configuration.

**Exit:** one node, one container. S1's full weighing sequence runs against it with `curl`, single-party,
no counterparty. Visibility filtering demonstrably withholds `grossMass` before `PAID`.

## M3 — Two nodes: connections, delivery, replication

The milestone where it becomes a *shared* process.

- Connection handshake — request, accept, accepted, rejected — with `did:web` resolution and the
  domain-binding check. Config-seeded connections as a demo shortcut.
- Delivery: `webhook` push with backoff, and `stream` (SSE) with `Last-Event-ID` catch-up. Both emit the
  identical signed event object.
- Peer replication: verified local replica of every instance the participant is in; `?since=` pull as the
  authoritative recovery path.
- Node-to-node auth switched on: JWS bearer, DID resolution, `aud` and `exp` checks, `jti` replay
  rejection. Dev-mode trust becomes a flag that refuses to start under production config.
- Event signing switched on for real.

**Exit:** two nodes, `docker compose up`, S1 runs end to end across both, and each side's replica
verifies against the other's. **S4a (offline catch-up) and S4b (tamper detection) both demonstrable** —
these are the milestone's real acceptance tests, not the happy path.

## M4 — Quotations, links, deadlines

- `POST /instances` accepting a `quotationId`; quotation and service instances side by side.
- `links` evaluation: subscribe to a related instance's events, fire the named transition on a match,
  and record *which signed event* caused the advance.
- Deadline scheduling and `onDeadline` firing; transitions with `by: []` invocable only by the runtime.
- Attachments: content-addressed store, upload, `GET /attachments/{sha256}`, visibility-filtered.
- `GET /offerings`, including standing quotations.

**Exit:** **S2 runs end to end**, including the counter-offer loop, the auto-started service instance,
the `409` on a stale `If-Match`, and an offer expiring on its deadline.

## M5 — The UI

`apps/ui`, built into the node image. One container per party, still.

- Connection list; send, accept and reject connection requests.
- Offerings browser; start a quotation or a service instance.
- Instance list and detail: current state, the data document as the caller may see it, and the
  available transitions for *this* participant's role — rendered generically from the definition, so a
  new definition needs no UI work.
- Event log with per-event verification status. **A broken chain must be loud and red.**
- Better Auth sessions scoped to a participant.

**Exit:** S1 and S2 driven entirely through the UI on the Acme side, while the Van Moer side is driven
by its mock backoffice over a webhook. Two profiles, one image — the claim made visible.

## M6 — Measure and harden

- Postgres profile for the large party; SQLite stays the small-party default.
- The mock backoffice as a separate tiny service, so "large supplier automates, small consumer clicks"
  is a real deployment difference rather than a slide.
- **S4c**: a `bench` script that prints containers, resident memory, cold-start time and
  time-to-first-transaction. Record the numbers in `ARCHITECTURE.md §9`.
- Retries, dead letters, replay from log, and re-hosting a stalled instance from a replica.
- Multi-participant-per-node exercised at least once in a test, to keep the SaaS path honest.

**Exit:** the cost targets in `AGENT.md` are measured, not claimed. S1, S2, S4a, S4b and S4c all run
from one command.

---

## Deliberately not in scope yet

Named so they are choices rather than omissions:

- **Verifiable credential gates on transitions.** The hook belongs in the definition schema now
  (`requiresCredential`); enforcement can wait.
- **Remote signers.** The `Signer` interface exists from M1; a second implementation is a later day.
- **A federated catalogue.** A definition is a URL and a participant is a DID, so discovery can be
  layered on top without touching the execution core.
- **Publishing the event log as a stream for third parties.** The visibility filter is the hard part
  and it is built in M1; publication is plumbing.
- **Anything that requires a counterparty to run a workflow engine.** A party must always be able to
  integrate with two HTTP calls and one event connection. If that stops being true, the design has
  regressed.
