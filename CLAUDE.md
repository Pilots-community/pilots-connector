# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Quick start

**Read [AGENT.md](AGENT.md) first.** It is the standing context for all work in this repo. It covers the
scope, non-negotiables, architecture, and working agreements.

This repo is a **clean slate** — ignore the sibling directories (`../pilots-dataspace`,
`../pilots-process-service`, etc.) and the parent's earlier documentation. They describe an abandoned
approach.

Current status: **M6.5 complete** — an open foundation. A participant **writes their own process in the
UI or as JSON**, publishes it over the integration surface, and runs it with a counterparty who has
never seen it: the peer's connector fetches the document, checks it against the hash the events are
signed against, and holds it for an operator who accepts once per definition and is never asked again.
The connector refuses a definition with no reachable good ending, and refuses an *instance* that could
only ever be cancelled. Nothing in the connector, the protocol, the client or either base UI names a
logistics term. On top of it sits the BPMN modeler (sub-project 1 of the BPMN track,
[spec 2026-11-17](docs/superpowers/specs/2026-11-17-bpmn-modeler-design.md)): a Diagram tab on the
Authoring view that draws a definition and edits the same JSON. 806 tests (~10 s, no containers) and
17 Playwright specs.

M6 before it is measured and hardened: every topology started cold and counted by
`pnpm bench:topologies` (2 containers headless, 4 with a UI, 4 with a backoffice, **0 databases** in all
of them, first transaction 5.6–11.4 s). A party with no UI is a container of its own
(`apps/mock-backoffice`); a large party adds one overlay file for a managed document store; a host that
loses its store re-hosts from the replicas of the peers it was hosting for. M7 (publish and deploy) is
**event-triggered** — it starts on the supervisor's word, not on a milestone finishing.

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
- [docs/ROADMAP.md](docs/ROADMAP.md) — milestones M1–M7 from empty repo to running demo
- [README.md](README.md#running-the-demo) — how to set the demo up locally and what to show in it
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

11. **A definition is data, not deployment.** Any valid process must run on an unmodified connector:
    authored at runtime, published over the local API, adopted by a peer who has never seen it. **No
    domain vocabulary in the connector, the protocol, the client or either base UI** — no logistics
    terms in identifiers, user-visible strings or placeholder values. A definition-specific branch
    anywhere in the connector is a design bug, not a shortcut.

12. **Validity is the linter's job, and viability is the connector's.** A definition must have a
    reachable fulfilled ending and no state nothing can leave. Separately, an *instance* whose
    definition reaches fulfilment only through a link relation it has not anchored is refused at
    creation — a valid definition can still yield an unrunnable instance, and `dead-end-state` cannot
    see it because `cancel` from `*` satisfies it for every state.

13. **Timers and abort paths from the start.** `deadline` / `onDeadline` on transitions, terminal states
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
  packages/client/       Typed local-API client + a committed OpenAPI document, so a
                         non-TypeScript integrator generates their own rather than
                         reimplementing this one. Depends on the protocol, never on the connector.
  packages/bpmn/         A definition as a BPMN-style diagram (`toDiagram`) and every edit as a
                         command on the definition (`applyCommand`). Pure, browser-safe: the
                         protocol and zod are type-only imports. Never parsed back, so lossless.
  apps/connector/        NestJS (Fastify adapter). Three API surfaces + admin UI.
    src/peer/            The peer surface as a plain function, the Transport port, the in-process
                         and HTTP adapters, bearer tokens, and the relay. The Nest controller is a
                         thin shell over PeerSurface, so scenario tests and containers run the same
                         authentication, routing and checks.
    src/connections/     The handshake, its trust checks, and the state that gates process traffic.
    src/delivery/        Peer delivery: outbound webhook + stream, the stream hub, the stream client.
    src/replication/     Applying a peer's events. Where "the host cannot lie" is enforced.
    src/notifications/   Local delivery: subscriptions, envelopes, channels, retry, dead letters.
    src/links/           `links` evaluation. Advances one instance from a signed event in another,
                         and records which event in the resulting header's `cause`.
    src/deadlines/       The deadline scan loop. Driven by Clock, never setTimeout.
    src/attachments/     Content-addressed documents: upload, cross-connector pull, and read
                         permission derived from `visibility` rather than declared again.
    src/recovery/        `rebuild` (refold from our own log, refuse an edited one) and `recover`
                         (pull an instance back from a peer). The re-hosting path.
    src/definitions/     The registry, the `definitions` store collection, and the service that
                         publishes ours and adopts a peer's. Authoring is on the **local** surface
                         (`definitions:write`); adopting is on the **admin** surface, because it is a
                         trust decision. A published definition is immutable and content-addressed.
    src/store/           Repository port, memory/file/mongo adapters, conformance suite.
                         Connector-internal by design — do not promote to a shared package.
    src/admin-ui/        Minimal admin UI: connections, API keys, offerings, subscriptions, audit log.
  apps/mock-backoffice/  A participant with no UI, as a container. One API key, no definition,
                         no state machine — it posts back the transition id it was offered.
  apps/process-ui/       Demo process management, its own container.
    src/server/          The BFF: holds the one API key, owns its own user accounts
                         (better-auth), turns a signed-in user into an `X-Actor-Ref`, and
                         verifies the event log itself rather than trusting the connector.
    src/web/             The SPA shell. Transitions and forms rendered from the definition,
                         so a new process needs no UI work.
      views/             Processes (grouped by whose turn it is), detail, start, offerings.
      graph/             `toGraph` — definition + event log to nodes and edges, pure and
                         unit-tested — and the React Flow surface. Read-only now; the same
                         model an editor mutates at Iteration 2.
      modeler/           The Diagram tab: palette, canvas, properties panel, over one draft
                         shared with the JSON tab. Drafts and layout stay in the browser.
      live/              The `ChangeFeed` port. Polling and window-focus adapters today; a
                         notification-driven nudge is a third adapter, not a rewrite.
  tests/e2e/             Playwright. Wiring and UI only, never protocol behaviour.
  docs/                  Design documents.
```

**Boundary rule, lint-enforced:** `apps/process-ui` may import `packages/client` and `packages/protocol`.
It may **never** import from `apps/connector`. A gap there is a gap in the local API.
`apps/process-ui` may also import `packages/bpmn`, which may import only `packages/protocol`; connector
**tests** may import `packages/bpmn`, the connector itself may not. The SPA consumes `packages/bpmn` as a
built package, so build `packages/protocol` and then `packages/bpmn` before `dev:web`.

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
pnpm demo:env                                # writes a gitignored .env with fresh credentials
docker compose up                            # 4 containers (2 connectors + 2 UIs), 0 databases
docker compose up org-a org-b               # the headless profile: connectors only
pnpm bench:topologies                        # every topology, started cold and counted (S4c)

# two overlays, each adding one container. Always pass the same -f files to
# `down` as to `up`, or the overlay's containers and volumes outlive the demo.
docker compose -f docker-compose.yml -f docker-compose.automated.yml up   # +backoffice
docker compose -f docker-compose.yml -f docker-compose.mongo.yml up       # +document store
pnpm --filter @pilots/protocol build && pnpm --filter @pilots/bpmn build   # once, before dev:web — the SPA imports their build
pnpm --filter @pilots/process-ui dev         # BFF on :4000
pnpm --filter @pilots/process-ui dev:web     # SPA on :5175, proxying the BFF

pnpm openapi:export     # regenerate packages/client/openapi.json from the code
pnpm test:e2e           # Playwright. Needs `docker compose up` first.
pnpm test:e2e:install   # one-time browser download

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

**Every topology** — `pnpm bench:topologies` starts each one cold and counts what is running. The
container count *is* the argument, so it is counted rather than asserted.

| Topology | Self-run per party | Containers | Databases | Healthy | First transaction |
|---|---|---|---|---|---|
| Headless integrator | 1 | 2 | **0** | 5.5 s | 5.6 s |
| Automated party | 1 + a backoffice | 4 | **0** | 11.2 s | 11.4 s |
| Full self-hosting | 2 | 4 | **0** | 11.1 s | 11.3 s |
| Fully hosted | **0** | 0 | **0** | — | — |

Against a 60 s target. Memory as the cgroup reports it: connector ~84–89 MiB / 1 GB · UI ~50–52 MiB /
512 MB · backoffice ~33 MiB / 256 MB. (Re-measured at M6.5, which added the definitions collection
and the authoring surface: the connector grew ~3 MiB and the UI ~7 MiB, both still under 11% of their
limits.) Image size: connector 236 MB · UI 264 MB.

*Fully hosted* has nothing to time — the hosted party runs no containers, which is the claim rather
than a gap; the shape is proven in the scenario tier (`hosted-tenants.test.ts`). *Automated party* and
*full self-hosting* cost the same, which is the point of the split: a backoffice instead of a UI is a
different container, not a different connector.

**The managed document-store profile** — `docker compose -f docker-compose.yml -f
docker-compose.mongo.yml up`: connector on Mongo ~91 MiB, file-store connector ~84 MiB, database
**~127 MiB in a container of its own**. That container is one party's honest price; the headline
*0 databases* belongs to the small profile and stays true there.

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
| **M4** — quotations, links, deadlines ✅ **done** | `quotationId`, `links` evaluation with `cause` in the header, deadline scan loop (fake-clock tested), content-addressed attachments, offering discovery | Met: S2 as a scenario test and across two containers — counter-offer loop, the link firing `startExecution`, `409` through the relay, an offer expiring on `PT24H`; 427 tests, ~2.9 s |
| **M5** — process UI + integration surface ✅ **done** | `packages/client` + OpenAPI, `apps/process-ui` as its own container, generic transition rendering, event log with verification status, boundary lint rule, Playwright | Met: S1 through the UI on both sides; four containers, 0 databases, first transaction ~12 s; `org-a-ui` stopped mid-process and the connector carried on; 7 Playwright specs. The mock-backoffice container run moves to M6 |
| **M6** — measure and harden ✅ **done** | Managed document store profile, mock backoffice as a service, `bench` for all four topologies, retries / dead letters / replay / re-hosting, multi-participant test, audit retention | Met: every topology started cold and counted — 2/4/4/0 containers, **0 databases** in all of them, first transaction 5.6–11.4 s against 60 s; 506 tests, ~4 s. Found three real bugs, including a large party regenerating its signing key on every restart |
| **M6.5** — open foundation ✅ **done** | Definition authoring in the UI and from JSON (`definitions:write` on the local surface, dry-run lint + immutable publish), four new lint rules (`no-fulfilled-path`, `no-fireable-exit`, `starts-link-dependent`, `unfulfillable-state`), `definitionHash` in the instance genesis, creation refused when no fulfilled state is reachable, peer definitions fetched and adopted once per definition with a structural diff, all domain vocabulary removed from the connector and base UIs | Met: a process authored in Org A's browser, adopted by Org B's operator and run to completion across two containers; 644 tests, 15 Playwright specs (806 and 17 after the modeler); the demo's dead end is prevented rather than encountered |
| **M7** — publish and deploy *(current target, event-triggered: starts when collaboration begins, on the supervisor's word — not on M6 completing)* | Two CI systems split by audience: **Bitbucket Pipelines → AWS ECR** (our demos) and **GitHub Actions → GHCR** (participants, maybe public). Terraform **in this repo**, single-org scope. `did:web` hosting as a separate module. Origin migrates to GitHub, Bitbucket becomes mirror | Tagged release publishes both images; Pipelines deploys one participant to ECS from Terraform, no manual step; a third party can run `infra/examples/single-org-aws` with only committed files + their own tfvars; secret scan over full history clean |

## Working agreements

- **Simplicity is a hard requirement.** Container count and time-to-first-transaction are acceptance
  criteria. If a change adds a container or dependency, say what it buys.
- **Prefer boring, standard pieces.** JSON Schema, JCS (RFC 8785), `did:web`, JWS, JSON Merge Patch, SSE,
  RFC 7807. The composition is the contribution.
- **The demo's two organisations are `org-a` and `org-b`.** Identifiers are neutral and committed; the
  names on screen are `ORG_A_NAME` / `ORG_B_NAME` in the gitignored `.env`. No real company name goes
  into code, config, tests or a definition.
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
- **Both sides run the demo UI in the first demo**: every step verifiable by hand; Org B additionally
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
