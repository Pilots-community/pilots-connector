# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Quick start

**Read [AGENT.md](AGENT.md) first.** It is the standing context for all work in this repo. It covers the
scope, non-negotiables, architecture, and working agreements.

This repo is a **clean slate** — ignore the sibling directories (`../pilots-dataspace`,
`../pilots-process-service`, etc.) and the parent's earlier documentation. They describe an abandoned
approach.

Current status: **M3 complete** — two connectors talk. The scenario harness stands whole connectors up
in one process, and S0, S1, S4a, S4b, S4d and S5 run as tests in ~2.6 s with no containers.
`docker compose up` gives two connectors, zero databases, and a first relayed transaction ~6 s in.
M4 (quotations, links, deadlines) is the next milestone.

## What we're building

A demonstrator of **process sharing**: a way for two or more logistics companies to run a shared business
process from start to finish, with the same connector software, while each keeps its own internal
procedures.

**Design goal**: both a one-truck haulier (cheap VPS or laptop, no HTTPS endpoint required, no database
container) and a terminal operator (managed document store, scale) must be able to run the same image
with different configuration — or have someone else host it for them entirely. The two differ in
**deployment profile only**; either can be supplier or consumer, in either direction, at the same time.

## Three deliverables, not one program

| Deliverable | What it is | Container |
|---|---|---|
| `apps/connector` | The core. Three API surfaces + a **minimal admin UI**, built in and served by it. | 1 |
| `apps/process-ui` | Demo process management UI, for orgs not building their own integration. | 1, optional |
| `packages/protocol`, `packages/client` | The spec, and the typed client + OpenAPI doc third parties integrate against. | — |

Deployment topologies (`[…]` is one container):

| Setup | Shape | Self-run containers |
|---|---|---|
| Full self-hosting | `[process-ui]` + `[connector + admin UI]` | 2 |
| Semi-lightweight | `[process-ui]` + third-party `[connector + admin UI]` | 1 |
| Fully lightweight | third-party `[process-ui]` + third-party `[connector + admin UI]` | 0 |
| Headless integrator | `[connector + admin UI]`, own systems on the local API | 1 |

## Key documents

- [AGENT.md](AGENT.md) — standing context, non-negotiables, tech stack, cost targets
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — components, terminology, the three artefacts, the three logs, hosting and trust
- [docs/PROTOCOL.md](docs/PROTOCOL.md) — wire spec: the three surfaces, auth, events, endpoints
- [docs/DEFINITIONS.md](docs/DEFINITIONS.md) — process definition schema, annotated
- [docs/STACK.md](docs/STACK.md) — the finalised tech stack, and what each dependency buys
- [docs/TESTING.md](docs/TESTING.md) — the four test tiers and why scenario tests are hermetic
- [docs/SCENARIOS.md](docs/SCENARIOS.md) — end-to-end walkthroughs (S0–S4)
- [docs/ROADMAP.md](docs/ROADMAP.md) — milestones M1–M6 from empty repo to running demo
- [docs/definitions/](docs/definitions/) — five real example process definitions
- [docs/superpowers/specs/](docs/superpowers/specs/) — design decision records, with the reasoning

## Non-negotiables

These are settled decisions. Do not re-litigate; flag if you think one is wrong. The authoritative
wording is in [AGENT.md](AGENT.md).

1. **One runtime primitive: the `Instance`.** A quotation and a service execution are the same thing with
   different `kind` values. A standing quotation is a definition whose first transition auto-fires — not a
   special case in code.

2. **Every change is a transition.** One mutating endpoint. A transition applies an optional state change
   and an optional JSON Merge Patch. "Update a field" and "advance the state" are not two mechanisms.

3. **Multi-party from day one, and role-symmetric.** `roles` is an array with cardinality; hosting is
   declared per definition via `"hostedBy": "<role>"` but **resolved per instance** (a definition names a
   role; only an instance names the participant). Adding a third party must be a definition change, never
   a redesign. **No participant is typed** — supplier/consumer is a role in one instance, so the same
   connector is supplier to one peer and consumer of another under the same definition simultaneously.
   Publishing an offering is what makes a participant a supplier, and it is a runtime store record.
   Deciding local-vs-remote per definition rather than per instance breaks this silently.

4. **The event log is the record.** Hash-chain the event *header*, commit to the payload by `payloadHash`
   (so peers can verify redacted events). Three mechanisms for three problems: `seq` + `If-Match`
   (concurrency), `prev` + `sig` (tamper evidence), `Idempotency-Key` (safe retries).

5. **Connections are first-class**, established before any process runs. Never a callback URL per request.
   Peer delivery channel declared once: `webhook` or `stream` (SSE, no inbound endpoint needed).

6. **A party with no UI is a first-class participant.** Local delivery is configuration, not protocol:
   **notification subscriptions** registered in the admin UI, filtered by definition/state/transition.
   **`action.required`** ("it is our turn") is computed from the definition and carries the signed event
   plus the available transitions, so an internal system needs no state machine. `channel` is a port —
   `webhook` + `sse` now, **queues later**, no change to the subscription model.

7. **Three API surfaces, three auth layers, no privileged path.** `/api/peer/v1` (JWS bearer, `did:web`)
   · `/api/local/v1` (API key + scopes, `X-Actor-Ref`) · `/api/admin/v1` (admin session). Anything our
   demo UI can do, a third party's UI can do, over the same surface.

8. **Three logs, three jobs.** Application (stdout; every rejected auth and refused change) · audit (in
   the store, locally hash-chained, never replicated; who did what, including denials) · event (signed,
   chained, replicated). The logger can flag an entry for the audit sink at its call site.

9. **Persistence is a port; the store is document-oriented.** Every document carries `participantId`.
   Memory (test default) / file (small party, zero infrastructure) / Mongo (large party), one conformance
   suite. No ORM, no SQL, no migrations.

10. **Everything external is a port, and tests are hermetic.** `Clock`, `IdGenerator`, `Signer`, peer
   `Transport`. No unit, contract or scenario test may need a network, container, real clock, or a
   filesystem outside a temp dir. Default signer is local Ed25519; key management never blocks the state
   machine.

11. **Timers and abort paths from the start.** `deadline` / `onDeadline` on transitions, terminal states
    reachable via `from: ["*"]`.

## The honest limitations

State both unprompted when the topic comes up; do not oversell either.

- **The host holds the bytes.** Visibility rules govern who may *read* fields; they do not blind the host.
  The guarantee is that **the host cannot lie** — every event signed, chained, independently verifiable.
- **A hosted connector holds your signing key.** An **accepted** trade-off, like using a payment
  processor: the answer is provider compliance, not architecture. `Signer` stays a plugin interface.

## Stack and structure

```
pilots-service/
  packages/protocol/     THE SPEC. Zod schemas, JCS canonicalisation, sign/verify, evaluator,
                         visibility filter, definition linter, JSON Schema export. Tests live here.
  packages/client/       Typed local-API client + OpenAPI doc. The integration surface.
  apps/connector/        NestJS (Fastify adapter). Three API surfaces + admin UI.
    src/peer/            The peer surface as a plain function, the Transport port, the in-process
                         and HTTP adapters, bearer tokens, and the relay. The Nest controller is a
                         thin shell over PeerSurface, so scenario tests and containers run the same
                         authentication, routing and checks.
    src/connections/     The handshake, its trust checks, and the state that gates process traffic.
    src/delivery/        Peer delivery: outbound webhook + stream, the stream hub, the stream client.
    src/replication/     Applying a peer's events. Where "the host cannot lie" is enforced.
    src/notifications/   Local delivery: subscriptions, envelopes, channels, retry, dead letters.
    src/store/           Repository port, memory/file/mongo adapters, conformance suite.
                         Connector-internal by design — do not promote to a shared package.
    src/admin-ui/        Minimal admin UI: connections, API keys, offerings, subscriptions, audit log.
  apps/process-ui/       Demo process management. BFF (holds the API key, owns its own users) + SPA.
  tests/e2e/             Playwright. Wiring and UI only, never protocol behaviour.
  docs/                  Design documents.
```

**Boundary rule, lint-enforced:** `apps/process-ui` may import `packages/client` and `packages/protocol`.
It may **never** import from `apps/connector`. A gap there is a gap in the local API.

**Stack is finalised — see [docs/STACK.md](docs/STACK.md) before adding any dependency.** pnpm
workspace, Node 24, TS strict, **Vitest**. `zod` 4 for protocol shapes, **`Ajv`** (2020-12) for the JSON
Schema *inside* definitions — two validators, two jobs, do not unify. `jose`, `did-resolver` +
`web-did-resolver`, `canonicalize`, `ulidx`, `pino`, `better-auth`, `mongodb` (large-party only).
NestJS 11 + Fastify (**CJS**; `packages/*` are dual ESM+CJS via tsup). Vite + React + Tailwind + shadcn +
TanStack Query; process UI has a thin Fastify BFF. ESLint + Prettier + `eslint-plugin-boundaries`.
Playwright.

Hand-rolled in `packages/protocol` because they are the spec: JSON Merge Patch, restricted ISO 8601
durations. API keys are hashed with **HMAC-SHA256 + pepper, not argon2** (high-entropy secrets — see
STACK.md §4.1). Timers are a **scan loop driven by `Clock`, never `setTimeout`**.

## Available commands

```bash
pnpm install
pnpm test               # unit + contract tiers — no network, no containers, no real clock
pnpm typecheck          # builds packages/protocol first, then checks every project
pnpm lint               # ESLint, including the import-boundary rule
pnpm format             # Prettier. Markdown and .claude/ are excluded on purpose.
pnpm build              # protocol (tsup, dual ESM+CJS), admin UI (vite), connector (nest)
pnpm lint:definitions   # lint docs/definitions against the schema and the linter
pnpm schema:export      # regenerate packages/protocol/schema/*.json from the zod schemas

# the connector
pnpm --filter @pilots/connector start        # needs `pnpm build` first
pnpm --filter @pilots/connector dev:ui       # admin UI on :5174, proxying to :3000
node apps/connector/scripts/bench.mjs        # measured cold start, RSS, first transaction
docker compose up                            # two connectors, 0 databases, connection seeded

# the Mongo adapter runs the same conformance suite, but only when pointed at one.
# It needs a replica set — a standalone mongod cannot do the transactions the port requires.
docker run -d -p 27018:27017 mongo:7 --replSet rs0 --bind_ip_all
docker exec <container> mongosh --eval 'rs.initiate()'
PILOTS_TEST_MONGO_URI='mongodb://localhost:27018/?directConnection=true' pnpm test
```

`pnpm lint:definitions` replaced `tools/lint-definitions.py`, which is deleted. It checks everything the
stopgap did — undefined roles and states, duplicate ids, dangling onDeadline / link / visibility
references, unreachable states, states with no path to a terminal state — plus: JSON Schema validity of
`data`, `patch` and `guards`; deadline coherence; the reserved `create` transition id; outgoing
transitions from a terminal state; and warnings that do not fail a definition.

## Measured, not claimed

**The two-party demo** — `docker compose up`, file store, `mem_limit: 1g` on each, S1 run across both:

| | |
|---|---|
| Containers | **2** (0 databases) |
| Both healthy | ~5.7 s from `up` |
| **First transaction** | **~6.0 s from `up`** — relayed Acme → Van Moer, against a 60 s target |
| Cold start, each | ~330 ms |
| Memory in use, each | **~82–86 MiB — 8% of a 1 GB limit**, after S1 has run across both |
| Image size | 235 MB |

The limit lives in `docker-compose.yml`, not only in this table, so a connector that outgrows 1 GB
fails `up` instead of quietly making the number stale. The image grew 14 MB at M3 for the Mongo
driver, which the small profile never loads — that is the price of one image serving both profiles.

**One container** — `docker run --memory=1g`, file store, after S1 has run end to end:

| | |
|---|---|
| Containers | **1** (0 databases) |
| Cold start | ~220 ms |
| Memory in use | **~82 MiB — 8% of a 1 GB limit** |

**On a laptop** — `node apps/connector/scripts/bench.mjs`:

| | file store | memory store |
|---|---|---|
| Cold start | ~450 ms | ~440 ms |
| Time to first transaction (cold) | ~110 ms | ~26 ms |
| Process RSS | ~130–145 MB | ~133 MB |
| Mean write latency | ~35 ms | ~0.9 ms |

The two memory figures measure different things: `docker stats` reports the cgroup working set, RSS
counts shared and mapped pages too. **Size against the container figure.** At 8% of 1 GB there is ample
headroom, so [STACK.md §5.3](docs/STACK.md#53-measure-memory-at-m2-not-m6)'s "swap the framework if it
blows the target" trigger is spent — NestJS stays.

**The file store's write latency is one `fsync` per event**, which is the honest price of "the log is the
record"; the materialised instance is a cache the log rebuilds, so it is not fsynced.

## Roadmap milestones

Full detail in [docs/ROADMAP.md](docs/ROADMAP.md).

| Milestone | Scope | Exit |
|---|---|---|
| **M1** — protocol package ✅ **done** | Schemas (incl. API key, audit entry), JCS, chain verification with redacted payloads, `Signer` / `Clock` / `IdGenerator` / `DidResolver` ports, evaluator, merge patch, visibility filter, linter, JSON Schema export | Met: `pnpm test` green (217 tests, under a second); the five definitions lint clean; a tampered event fails, a redacted event passes |
| **M2** — connector, single party ✅ **done** | Store (port + memory + file + conformance), all three surfaces, API keys + scopes, audit log, application logger, `If-Match` / `Idempotency-Key` / RFC 7807, `auto` transitions, admin UI | Met: one container, no database; S1 runs on the local API with `curl` + an API key; the audit log shows every call including refusals, with an intact chain; memory and cold start measured |
| **M3** — two connectors ✅ **done** | Scenario harness + in-process transport **first**, connection handshake, peer + local delivery, the relay, replication, node-to-node auth on, signing on, Mongo adapter + conformance | Met: S0, S1, S4a, S4b, S4d, S5 as scenario tests (412 tests, ~2.6 s, no containers); an automated participant runs S1 with no human; Mongo passes the same conformance suite; two containers, 0 databases, S1 end to end, both replicas verify |
| **M4** — quotations, links, deadlines *(current target)* | `quotationId`, `links` evaluation, deadline scheduling (fake-clock tested), attachment bytes, offering discovery | S2 end to end as a scenario test and across containers |
| **M5** — process UI + integration surface | `packages/client` + OpenAPI, `apps/process-ui` as its own container, generic transition rendering, event log with verification status, boundary lint rule, **Playwright** | S1 and S2 via the process UI on Acme's side, Van Moer via local-delivery webhook; the UI container can stop without the connector caring |
| **M6** — measure and harden | Managed document store profile, mock backoffice as a service, `bench` for all four topologies, retries / dead letters / replay / re-hosting, multi-participant test, audit retention | Cost targets measured, not claimed; S1, S2, S4a–c from one command |
| **M7** — publish and deploy *(event-triggered: starts when collaboration begins, on the supervisor's word — not on M6 completing)* | Two CI systems split by audience: **Bitbucket Pipelines → AWS ECR** (our demos) and **GitHub Actions → GHCR** (participants, maybe public). Terraform **in this repo**, single-org scope. `did:web` hosting as a separate module. Origin migrates to GitHub, Bitbucket becomes mirror | Tagged release publishes both images; Pipelines deploys one participant to ECS from Terraform, no manual step; a third party can run `infra/examples/single-org-aws` with only committed files + their own tfvars; secret scan over full history clean |

## Working agreements

- **Simplicity is a hard requirement.** Container count and time-to-first-transaction are acceptance
  criteria. If a change adds a container or dependency, say what it buys.
- **Prefer boring, standard pieces.** JSON Schema, JCS (RFC 8785), `did:web`, JWS, JSON Merge Patch, SSE,
  RFC 7807. The composition is the contribution.
- **Never commit private keys or hardcode credentials** — not even in demo seed scripts or test fixtures.
  Test keys are generated at test setup.
- **Assume this repo becomes public.** Origin is Bitbucket now, GitHub later, possibly public
  ([ROADMAP.md M7](docs/ROADMAP.md)). Git history cannot be un-leaked, so from M1: no account ids, ARNs,
  VPC/subnet ids, real hostnames or internal URLs in any commit. Secret *names* are fine, values are not.
  Demo DIDs stay on the reserved `.example` TLD.
- **`packages/protocol` is the spec.** If behaviour is not expressed there as schema or tested function,
  it is not decided.
- **Simplicity target**: `docker compose up` → first transaction in < 60s; full two-party demo = 4
  containers (two connectors, two process UIs) and **0 databases**; self-run containers = 1
  headless / 2 with the demo UI / 0 fully hosted; **0 database containers** in the small profile; memory
  comfortable in a 1 GB container; no inbound HTTPS for `stream` delivery users; full S0–S4 suite in seconds with no
  containers.
- **Nothing is set in stone until implemented, and barely then.** We are in ideation heading for a
  field-tested demo, not production. Prefer the choice that is easier to pivot away from.
- Ask when unsure or sources conflict. **The human supervisor decides** on direction questions.
- **Never commit or push.** Git write operations are also blocked in `.claude/settings.json`. When a
  coherent unit of work is done — a milestone exit criterion met, a test suite green, a logical stopping
  point before switching tasks — stop and prompt the human supervisor to review and commit, rather than
  continuing on top of uncommitted work.

## Key decisions and their reasons

- **Split connector / admin UI / process UI**: makes "bring your own UI or backend" the normal path
  rather than a special case, and enables the third-party-hosted topologies
- **Local API relays by `hostedBy`**: keeps the hosting model out of every client, and keeps the connector
  the only thing holding a signing key
- **`X-Actor-Ref` outside the signed header**: peers don't need employee identities, and a replicated
  chain cannot be retracted
- **Audit log alongside the event log**: failed actions produce no event, so without it there is no record
  they happened
- **`action.required` computed, not declared**: it falls out of the state machine (`by` on transitions),
  so notifications, UI buttons and the permission check are one rule with three consumers
- **Both sides run the demo UI in the first demo**: every step verifiable by hand; Van Moer additionally
  subscribes a mock backoffice so the automated path shows alongside the manual one
- **Offerings are runtime data, not config**: publishing one is what makes a participant a supplier, so
  supplier/consumer never becomes a build flag or a deployment mode
- **Home node resolved per instance**: the demo is one-directional, so only a scenario test (S5) catches a
  per-definition shortcut here
- **Document store behind a port**: no migrations, a dev store needing zero infrastructure, and storage
  matching the JSON-native artefacts. Note SQL was never what constrained definitions — `instance.data`
  was always an app-layer-validated blob
- **Mongo adapter at M3, not M6**: memory and file are both single-writer and in-process, so they hide the
  contracts a networked store differs on
- **Hermetic scenario tests**: S4a and S4b are the two most important behaviours in the design and must
  not be things a person checks by hand
- **Redacted events in the chain**: enables field-level visibility without losing verification
- **Connections before processes**: simplifies delivery guarantees and auth
- **`roles` as array**: unlocks multi-party without a redesign
- **M1 before code**: if the protocol design is wrong, no amount of implementation fixes it
