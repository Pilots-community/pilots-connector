# AGENT.md — standing context for `pilots-service`

Read this first. It is the entry point for any session working in this repo.

## Scope of this file

This repo is a **clean slate**. Sibling directories (`../pilots-dataspace`, `../pilots-process-service`,
`../pilots-client-app`, `../pilots-infra`, `../pilots-process-modeler`) and the parent directory's
`../AGENT.md`, `../PROPOSAL.md`, `../PLAN.md`, `../CURRENT_STATE.md` describe **an earlier, abandoned
approach**. They are **not authority here**. Do not inherit their vocabulary, their architecture, or
their constraints. You may glance at them for inspiration on a specific problem, but never cite them
as a reason to do something.

If a decision seems to require knowledge of that earlier work, it is the wrong decision.

## What we are building

A demonstrator of **process sharing**: a way for two or more logistics companies to run a shared
business process from start to finish, all parties running the same connector software, while each
keeps its own internal procedures.

The canonical example. A Shipper wants a container moved from A to B. It asks a Transporter for a
quotation, gets a price, agrees, and the transport is executed. Trivially simple as a business
process — and yet today every transporter has its own procedures, its own integrations, and its own
formats. We want one shared language for that process, with room for each party's own way of working.

Two things must both be true of whatever we build:

- **A one-truck haulier can afford to run it.** One container, no public HTTPS endpoint required, no
  key ceremony, runs on a cheap VPS or a laptop.
- **A terminal operator can run it at scale.** Same image, different configuration: Postgres, a
  webhook into their backoffice, many concurrent processes.

If a design choice makes one of those false, it is the wrong choice.

## Non-negotiables

These are settled. Do not re-litigate them; if you think one is wrong, say so explicitly and ask.

1. **One runtime primitive: the `Instance`.** A quotation and a service execution are the same thing
   with different definitions (`kind: "quotation" | "service"`). A quotation *is* a state machine.
   A standing quotation is a definition whose first transition auto-fires — not a special case in code.

2. **Every change is a transition.** A transition applies an optional state change and an optional
   JSON Merge Patch to the instance's data document. There is exactly **one** mutating endpoint.
   "Update a field" and "advance the state" are not two mechanisms.

3. **`roles` is an array with cardinality, from day one.** The first demo runs two parties. Adding a
   third must be a change to a definition file, never a redesign. Bilateral-by-assumption is the
   single most expensive mistake available in this problem space.

4. **Hosting is declared per definition** via `"hostedBy": "<role>"`. Not "the supplier always", not
   "whoever started it always". The party in that role runs the **home node** for instances of that
   definition; everyone else is a **peer node**.

5. **Three separate mechanisms for three separate problems.** `seq` (monotonic per instance) for
   optimistic concurrency via `If-Match`. `prev` + `sig` (hash chain + signature) for tamper evidence
   and non-repudiation. `Idempotency-Key` for safe retries. These are not alternatives to each other.

6. **Hash-chain the event *header*, commit to the payload by `payloadHash`.** Field-level visibility
   means peers legitimately receive redacted events. If the chain covered payloads, verification would
   fail on exactly the events that matter most. Header-chaining lets a peer verify the whole chain
   without holding bytes it is not allowed to see.

7. **Connections are first-class and established before any process runs.** Two participants complete
   a connection handshake once; processes then flow over that connection. **Never a callback URL per
   request.** The connection declares its delivery channel once — `webhook` (we POST to them) or
   `stream` (they hold an SSE connection to us, requiring no inbound endpoint on their side).

8. **Two distinct auth layers.** Node-to-node is a JWS bearer signed by the participant's DID key and
   verified by resolving `did:web`. Human-to-UI is an ordinary session (Better Auth) scoped to a
   participant. Conflating these is a common and painful error.

9. **Multi-tenancy readiness, not multi-tenancy.** Every table carries `participantId` and the signer
   interface is keyed by participant. The demo runs one participant per node. This costs almost
   nothing now and makes hosted "connector-as-a-service" possible later without a rewrite.
   (`did:web` supports path segments, so a hosted tenant gets a real DID: `did:web:host:t:acme`.)

10. **The node serves its own built UI.** One container per party, not two.

11. **Timers and abort paths exist from the start.** `deadline` / `onDeadline` on transitions, and
    terminal states reachable via `from: ["*"]`. Both are cheap now and miserable to retrofit.

12. **Signing is a plugin interface, default local Ed25519.** A remote signer can be added later.
    Never let key management block the state machine.

## The honest limitation

The party named in `hostedBy` physically holds the instance's bytes. Visibility rules govern who may
*read* which fields; they do not blind the host. What the architecture guarantees instead is that
**the host cannot lie**: every event is signed by whoever acted, chained to its predecessor, and
independently verifiable by every peer holding a replica.

State this unprompted whenever the hosting model comes up. Do not oversell it.

## Working agreements

- **Simplicity is a hard requirement, not a preference.** Container count and time-to-first-transaction
  are acceptance criteria. If a change adds a container or a dependency, say what it buys.
- **Be concise.** These documents are inputs to live architecture discussions, not reports. No novels.
- **Ask when unsure, or when sources conflict.** Matteus decides.
- **Prefer boring, standard pieces.** JSON Schema, JCS (RFC 8785), `did:web`, JWS, JSON Merge Patch,
  SSE. The composition is the contribution; the parts should be unsurprising.
- **Never commit private keys, and never hardcode credentials** — not even in demo seed scripts.
- **`packages/protocol` is the spec.** If behaviour is not expressed there as a schema or a function
  with tests, it is not decided. Documentation and code must not be allowed to drift apart.

## Cost targets

Absolute, not relative to anything:

| Target | Value |
|---|---|
| Containers per party | 1 (+ Postgres only for the large-party profile) |
| Memory, small-party profile | < 150 MB |
| `docker compose up` → first transaction | < 60 s |
| Inbound public HTTPS endpoint required | No, for a party using `stream` delivery |
| Onboarding a new participant | Publish one static `did.json`, accept one connection request |

## Repo layout and stack

```
pilots-service/
  packages/protocol/   Zod schemas, JCS canonicalisation, sign/verify, definition linter.
                       This package IS the spec. Tests live here.
  apps/node/           NestJS (Fastify adapter) + Drizzle. SQLite in dev, Postgres in prod.
  apps/ui/             Vite + React + TS + Tailwind + shadcn + TanStack Query.
                       Built into the node image and served by it.
  docs/                Design documents (below).
```

pnpm workspace. Key libraries: `zod`, `drizzle-orm`, `jose`, `did-resolver` + `web-did-resolver`,
`canonicalize`, `better-auth`. Documents carry an `@context` so they are JSON-LD/ODRL-projectable,
but there is **no JSON-LD processor on the hot path**.

## Key files

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — terminology, the three artefacts, hosting, trust model
- [docs/PROTOCOL.md](docs/PROTOCOL.md) — wire spec: handshake, events, auth, the endpoint list
- [docs/DEFINITIONS.md](docs/DEFINITIONS.md) — the process definition schema, annotated
- [docs/definitions/](docs/definitions/) — four real definitions used by the scenarios
- [docs/SCENARIOS.md](docs/SCENARIOS.md) — the end-to-end walkthroughs we are building toward
- [docs/ROADMAP.md](docs/ROADMAP.md) — milestones from empty repo to running demo
- [docs/IDEA.md](docs/IDEA.md) — the original meeting sketch. Superseded; kept for provenance.
