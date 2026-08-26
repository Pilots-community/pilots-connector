# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Quick start

**Read [AGENT.md](AGENT.md) first.** It is the standing context for all work in this repo. It covers the scope, non-negotiables, architecture, and working agreements.

This repo is a **clean slate** — ignore the sibling directories (`../pilots-dataspace`, `../pilots-process-service`, etc.) and the parent's earlier documentation. They describe an abandoned approach.

Current status: **M0** — documentation only. No implementation code yet. M1 (the protocol package) is the first milestone to build.

## What we're building

A demonstrator of **process sharing**: a way for two or more logistics companies to run a shared business process from start to finish, with the same connector software, while each keeps its own internal procedures.

**Design goal**: both a one-truck haulier (cheap VPS or laptop, no HTTPS endpoint required) and a terminal operator (Postgres, scale) must be able to run the same image with different configuration.

## Key documents

- [AGENT.md](AGENT.md) — standing context, non-negotiables, tech stack, cost targets
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — terminology, the three artefacts (definition, instance, event), hosting and trust model
- [docs/PROTOCOL.md](docs/PROTOCOL.md) — wire spec: handshake, events, auth, endpoints
- [docs/DEFINITIONS.md](docs/DEFINITIONS.md) — process definition schema, annotated
- [docs/SCENARIOS.md](docs/SCENARIOS.md) — end-to-end walkthroughs (S1, S2, S4a-c)
- [docs/ROADMAP.md](docs/ROADMAP.md) — milestones M1–M6 from empty repo to running demo
- [docs/definitions/](docs/definitions/) — five real example process definitions

## Non-negotiables

These are settled decisions. Do not re-litigate; flag if you think one is wrong.

1. **One runtime primitive: the `Instance`.** A quotation and a service execution are the same thing with different `kind` values. A standing quotation is a definition whose first transition auto-fires — not a special case in code.

2. **Every change is a transition.** One mutating endpoint. A transition applies an optional state change and optional JSON Merge Patch to the instance's data. "Update a field" and "advance the state" are not two mechanisms.

3. **`roles` is an array with cardinality from day one.** Bilateral-by-assumption is the single most expensive mistake in this problem space. First demo is two parties; adding a third must be a definition change, never a redesign.

4. **Hosting is declared per definition** via `"hostedBy": "<role>"`. The party in that role runs the **home node**; everyone else is a **peer node**.

5. **Three separate mechanisms for three separate problems**: `seq` (optimistic concurrency via `If-Match`), `prev` + `sig` (tamper evidence + non-repudiation), `Idempotency-Key` (safe retries). Not alternatives.

6. **Hash-chain the event *header*, not the payload.** Commit to payload by `payloadHash`. Field-level visibility means peers legitimately receive redacted events. Header-chaining lets peers verify without holding redacted bytes.

7. **Connections are first-class.** Establish once before any process runs. Never a callback URL per request. Declared delivery channel: `webhook` (we POST) or `stream` (SSE, no inbound endpoint required).

8. **Two distinct auth layers**: node-to-node (JWS bearer, DID key), human-to-UI (session, scoped to participant).

9. **Multi-tenancy readiness, not multi-tenancy.** Every table carries `participantId`. Demo runs one participant per node. This costs almost nothing now and enables hosted "connector-as-a-service" later.

10. **The node serves its own built UI.** One container per party.

11. **Timers and abort paths from the start.** `deadline` / `onDeadline` on transitions, terminal states reachable via `from: ["*"]`. Cheap now, miserable to retrofit.

12. **Signing is a plugin interface.** Default local Ed25519. A remote signer can be added later. Never let key management block the state machine.

## Stack and structure

```
pilots-service/
  packages/protocol/   Zod schemas, JCS canonicalisation, sign/verify, definition linter.
                       THIS PACKAGE IS THE SPEC. Behaviour not expressed here as schema
                       or tested function is not decided. Tests live here.
  apps/node/           NestJS (Fastify adapter) + Drizzle. SQLite dev, Postgres prod.
  apps/ui/             Vite + React + TS + Tailwind + shadcn + TanStack Query.
                       Built into node image and served by it.
  docs/                Design documents (below).
```

**pnpm workspace.** Key libraries: `zod`, `drizzle-orm`, `jose`, `did-resolver` + `web-did-resolver`, `canonicalize`, `better-auth`.

## Available commands

Currently only the Python linting tool:

```bash
python3 tools/lint-definitions.py docs/definitions
```

Checks process definitions for: undefined roles/states, duplicate transition IDs, dangling onDeadline / link / visibility references, unreachable states, and states with no path to terminal states. **This is temporary.** Will be replaced by the Zod-based linter in `packages/protocol` (M1), then delete `tools/lint-definitions.py`.

## Roadmap milestones

**M1 — The protocol package** (current target)
- Zod schemas: definition, instance, event header, event, connection, offering
- JCS canonicalisation (RFC 8785), `sha256` helpers, event-header hashing
- `Signer` interface + local Ed25519; `verify()` against resolved `did:web`
- Chain verification: given ordered headers, confirm `prev` linkage, `from`/`to` continuity, signatures — **must pass with redacted payloads**
- State machine evaluator: pure function
- JSON Merge Patch (RFC 7386) application and validation
- Visibility filter: given definition, role, instance/event, return filtered view
- Definition linter (replaces Python tool)
- JSON Schema export for non-TypeScript implementations
- Exit: `pnpm --filter protocol test` green; definitions load and lint; tampered events fail; redacted events pass

**M2 — The node, single party**
- Drizzle schema: `participantId` on every table from the start
- Definition registry, `If-Match` / `409` / `428`, `Idempotency-Key`, RFC 7807 errors
- `auto` transitions fire on state entry
- `GET /.well-known/did.json` from config
- Exit: one node, one container, S1's weighing sequence runs with `curl`, single-party

**M3 — Two nodes: connections, delivery, replication**
- Connection handshake with `did:web` resolution
- Delivery: `webhook` push + backoff, `stream` (SSE) with `Last-Event-ID` catch-up
- Peer replication with verification
- Node-to-node auth (JWS bearer)
- Event signing switched on
- Exit: two nodes, `docker compose up`, S1 runs end-to-end, both sides' replicas verify

**M4 — Quotations, links, deadlines**
- `quotationId` on POST `/instances`
- `links` evaluation: subscribe to related instances
- Deadline scheduling and `onDeadline` firing
- Attachments: content-addressed store
- Exit: S2 runs end-to-end with counter-offer loop, auto-started service, deadline expiry

**M5 — The UI**
- Connection list, offerings browser, instance detail
- Generic transition rendering from definitions
- Event log with verification status
- Better Auth sessions per participant
- Exit: S1 and S2 driven via UI on Acme side; Van Moer via mock backoffice webhook

**M6 — Measure and harden**
- Postgres profile for large party; SQLite stays small-party default
- Mock backoffice as separate service
- Cost target measurements (containers, memory, cold-start, time-to-first-transaction)
- Retries, dead letters, replay, re-hosting
- Multi-participant-per-node exercised in tests
- Exit: cost targets measured, not claimed; S1, S2, S4a-c all run from one command

## Working agreements

- **Simplicity is a hard requirement.** Container count and time-to-first-transaction are acceptance criteria. If a change adds a container or dependency, say what it buys.
- **Prefer boring, standard pieces.** JSON Schema, JCS (RFC 8785), `did:web`, JWS, JSON Merge Patch, SSE. The composition is the contribution.
- **Never commit private keys or hardcode credentials** — not even in demo seed scripts.
- **`packages/protocol` is the spec.** If behaviour is not expressed there as schema or tested function, it is not decided.
- **Simplicity target**: `docker compose up` → first transaction in < 60s; containers per party = 1 (+ Postgres only for large-party profile); memory < 150 MB small-party; no inbound HTTPS for `stream` delivery users.
- Ask when unsure or sources conflict. **The human supervisor decides** on direction questions.
- **Never commit or push.** Git write operations are also blocked in `.claude/settings.json`. When a coherent unit of work is done — a milestone exit criterion met, a test suite green, a logical stopping point before switching tasks — stop and prompt the human supervisor to review and commit, rather than continuing on top of uncommitted work.

## Key decisions and their reasons

- **Redacted events in the chain**: enables field-level visibility without losing verification
- **Connections before processes**: simplifies delivery guarantees and auth
- **`roles` as array**: unlocks multi-party without a redesign
- **M1 before code**: if the protocol design is wrong, no amount of implementation fixes it
