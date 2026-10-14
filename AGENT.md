# AGENT.md — standing context for `pilots-service`

Read this first. It is the entry point for any session working in this repo. test

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

- **A one-truck haulier can afford to run it.** One container, no database container, no public HTTPS
  endpoint required, no key ceremony. Runs on a cheap VPS or a laptop — or on someone else's hosting.
- **A terminal operator can run it at scale.** Same image, different configuration: a managed document
  store, a webhook into their backoffice, many concurrent processes.
- **Either of them can be the supplier or the consumer, at the same time.** The two profiles above differ
  in deployment, never in role. See non-negotiable 3.

If a design choice makes one of those false, it is the wrong choice.

## The three things we ship

Not one program. Three, so that using your own UI or your own backend is the normal path rather than a
special case.

| Deliverable | What it is | Container |
|---|---|---|
| `apps/connector` | The core. Three API surfaces plus a **minimal admin UI**, built in and served by it. | 1 |
| `apps/process-ui` | Demo process management UI, for organisations not building their own integration. | 1, optional |
| `packages/protocol`, `packages/client` | The spec, and the typed client + OpenAPI document third parties integrate against. | — |

This yields the deployment options that matter, where `[…]` is one container:

| Setup | Shape | Self-run containers |
|---|---|---|
| Full self-hosting | `[process-ui]` + `[connector + admin UI]` | 2 |
| Semi-lightweight | `[process-ui]` + third-party `[connector + admin UI]` | 1 |
| Fully lightweight | third-party `[process-ui]` + third-party `[connector + admin UI]` | 0 |
| Headless integrator | `[connector + admin UI]`, own systems on the local API | 1 |

## Non-negotiables

These are settled. Do not re-litigate them; if you think one is wrong, say so explicitly and ask.

1. **One runtime primitive: the `Instance`.** A quotation and a service execution are the same thing
   with different definitions (`kind: "quotation" | "service"`). A quotation *is* a state machine. A
   standing quotation is a definition whose first transition auto-fires — not a special case in code.

2. **Every change is a transition.** A transition applies an optional state change and an optional
   JSON Merge Patch to the instance's data document. There is exactly **one** mutating endpoint.
   "Update a field" and "advance the state" are not two mechanisms.

3. **Multi-party from day one, and role-symmetric.** `roles` is an array with cardinality, always.
   Hosting is declared per definition via `"hostedBy": "<role>"` — not "the supplier always", not
   "whoever started it" — and **resolved per instance**, because a definition names a role while only an
   instance names the participant filling it. Adding a third participant must be a change to a definition
   file, never a redesign. Bilateral-by-assumption is the single most expensive mistake available in this
   problem space.

   **No participant is typed.** "Supplier" and "consumer" describe a role in one instance, never a kind of
   company and never a kind of connector. A transporter is supplier to a freight forwarder and consumer to
   its own subcontractor, under the *same definition*, at the same time — its connector is home node for
   one instance and verifying replica of another. A participant becomes a supplier by **publishing an
   offering**, which is a store record created at runtime, not configuration and not a deployment
   decision. Any code that decides local-vs-remote per *definition* rather than per *instance* breaks
   this, silently, while a one-sided demo still passes.

4. **The event log is the record.** Hash-chain the event *header* and commit to the payload by
   `payloadHash`, so a peer can verify a complete history including events whose payload it was never
   allowed to see. Three separate mechanisms for three separate problems: `seq` + `If-Match` for
   optimistic concurrency, `prev` + `sig` for tamper evidence and non-repudiation, `Idempotency-Key`
   for safe retries. They are not alternatives to each other.

5. **Connections are first-class and established before any process runs.** Two participants complete a
   handshake once; processes then flow over that connection. **Never a callback URL per request.** The
   connection declares its delivery channel once — `webhook` or `stream` (SSE, requiring no inbound
   endpoint).

6. **A party with no UI is a first-class participant.** *Local* delivery is separate from peer delivery
   and is configuration, not protocol: the operator registers **notification subscriptions** in the admin
   UI, filtered by definition, state and transition. The type that matters is **`action.required`** — it
   is our turn — computed from the definition, carrying the signed event and the list of available
   transitions, so an internal system can act without holding a state machine of its own. `channel` is a
   port: `webhook` and `sse` now, **queues later**, with no change to the subscription model.

7. **Three API surfaces, three auth layers, no privileged path.**
   `/api/peer/v1` (JWS bearer, `did:web`) · `/api/local/v1` (API key + scopes) · `/api/admin/v1`
   (admin session). Never conflated, never interchangeable. **Anything our demo UI can do, a third
   party's UI can do, over the same surface with the same auth.** If that stops being true, "bring your
   own UI" is a false claim.

8. **Three logs, three jobs.** *Application* (stdout, structured; every rejected auth and refused
   change) · *audit* (in the store, locally hash-chained, never replicated; who did what, including
   what was denied) · *event* (signed, chained, replicated; what happened to the business process).
   The logger can flag an entry for the audit sink at its call site, so the two never drift apart.

9. **Persistence is a port, and the store is document-oriented.** Every document carries
   `participantId`. Three adapters behind one conformance suite: memory (test default), file (small
   party and demo, zero infrastructure), Mongo or a cloud equivalent (large party). This is
   multi-tenancy *readiness*, not multi-tenancy: the demo runs one participant per node, the code never
   assumes it.

10. **Everything external is a port, and tests are hermetic.** `Clock`, `IdGenerator`, `Signer` and peer
   `Transport` are all injectable. **No unit, contract or scenario test may require a network, a
   container, a real clock, or a filesystem outside a temp dir.** Two connectors run in one test
   process. The default signer holds a local Ed25519 key; key management never sits on the critical
   path of the state machine.

11. **A definition is data, not deployment.** Any valid process must run on an unmodified connector:
    written at runtime, published over `/api/local/v1` with `definitions:write`, and adopted by a peer
    who has never seen it. Content-addressed and immutable — a version is an identity, so changing a
    published definition means publishing a new version. **No domain vocabulary anywhere in the
    connector, the protocol, the client or either base UI**: no logistics terms in identifiers,
    user-visible strings or placeholder values, and no branch on a particular definition. The five
    committed definitions are examples; if the connector needs to know about one of them, that is a
    design bug.

12. **Validity is the linter's job; viability is the connector's.** A definition must have a fulfilled
    ending reachable from `initialState` and no reachable state that nothing can leave. Separately, an
    **instance** is refused at creation when no fulfilled state is reachable *for it* — a link-fired
    transition is walkable only when the relation it names is anchored, and that relation lives in the
    immutable genesis, so it can never be supplied later. A valid definition can yield an unrunnable
    instance, and a rule about paths to *any* terminal state cannot see it, because a `cancel` from
    `["*"]` satisfies that for every state.

13. **Timers and abort paths exist from the start.** `deadline` / `onDeadline` on transitions, and
    terminal states reachable via `from: ["*"]`. Both are cheap now and miserable to retrofit.

## The honest limitations

Two. State them unprompted whenever the relevant topic comes up, and do not oversell either.

**The host holds the bytes.** The party named in `hostedBy` physically holds the instance's payloads.
Visibility rules govern who may *read* which fields; they do not blind the host. What the architecture
guarantees instead is that **the host cannot lie**: every event is signed by whoever acted, chained to
its predecessor, and independently verifiable by every peer holding a replica.

**A hosted connector holds your signing key.** In the lightweight topologies, the hosting provider holds
the participant's key. This is an **accepted** trade-off on the same footing as using a payment
processor: the answer is provider compliance, not architecture. `Signer` stays a plugin interface so a
remote signer remains possible, but nothing is blocked on it.

## Working agreements

- **Simplicity is a hard requirement, not a preference.** Container count and time-to-first-transaction
  are acceptance criteria. If a change adds a container or a dependency, say what it buys.
- **Be concise.** These documents are inputs to live architecture discussions, not reports. No novels.
- **Ask when unsure, or when sources conflict.** The human supervisor decides.
- **Prefer boring, standard pieces.** JSON Schema, JCS (RFC 8785), `did:web`, JWS, JSON Merge Patch,
  SSE, RFC 7807. The composition is the contribution; the parts should be unsurprising.
- **Never commit private keys, and never hardcode credentials** — not even in demo seed scripts or test
  fixtures. Test keys are generated at test setup.
- **Assume this repository becomes public.** Origin is Bitbucket during the build phase and moves to
  GitHub when participants collaborate, possibly public ([docs/ROADMAP.md](docs/ROADMAP.md) M7). **Git
  history cannot be un-leaked**, so the discipline starts now, not at M7: no account ids, ARNs, VPC or
  subnet ids, real hostnames or internal URLs in any commit. Secret *names* are fine; secret *values* and
  infrastructure identifiers are not. Demo DIDs stay on the reserved `.example` TLD.
- **The demo's two organisations are `org-a` and `org-b`, and nothing else.** Identifiers
  (`org-a`, `did:web:org-a.example`, the compose services) are neutral and committed; the **names on
  screen** are `ORG_A_NAME` / `ORG_B_NAME` in the gitignored `.env`, defaulting to `Org A` / `Org B`.
  Never put a real company's name into code, config, tests or a definition — a demo for a particular
  audience sets two environment variables, and both that party's screens and its browser tabs follow.
- **`packages/protocol` is the spec.** If behaviour is not expressed there as a schema or a function
  with tests, it is not decided. Documentation and code must not be allowed to drift apart.
- **Nothing is set in stone until it is implemented, and barely then.** We are in ideation heading for a
  field-tested demo, not production. Prefer the choice that is easier to pivot away from.

## Cost targets

Absolute, not relative to anything:

| Target | Value |
|---|---|
| Self-run containers, headless integrator | 1 — **measured at M6** |
| Self-run containers, with the demo process UI | 2 — **measured at M6** |
| Self-run containers, fully hosted | 0 — **measured at M6**; the hosted shape is proven in the scenario tier |
| Database containers, small-party profile | **0** — file store on a mounted volume |
| Memory, small-party profile | Comfortable in a **1 GB container**, with headroom. Measured at M3: ~82–86 MiB each, two connectors under a 1 GB limit, after S1 has run across both. |
| Containers for the full two-party demo | 4 — two connectors, two process UIs, **0 databases**. Measured at M6 across every topology. |
| `docker compose up` → first transaction | < 60 s. Measured at M6: **~11 s** full self-hosting through the UI, **~11 s** with one side automated, **~6 s** headless. |
| Inbound public HTTPS endpoint required | No, for a party using `stream` delivery |
| Onboarding a new participant | Publish one static `did.json`, accept one connection request |
| Full scenario suite (S0–S4) wall-clock | seconds, no containers. Measured at M6: 496 tests in ~4 s. |

## Repo layout and stack

```
pilots-service/
  packages/protocol/     THE SPEC. Zod schemas, JCS canonicalisation, sign/verify, state machine
                         evaluator, visibility filter, definition linter, JSON Schema export.
                         Tests live here. Also the reference for non-TypeScript implementers.
  packages/client/       Typed local-API client + OpenAPI document. The integration surface:
                         consumed by process-ui, published for third parties.
  apps/connector/        NestJS (Fastify adapter). Three API surfaces + admin UI.
    src/store/           Repository port, memory/file/mongo adapters, conformance suite.
                         Connector-internal by design — nothing outside consumes it.
    src/admin-ui/        Minimal admin UI: API keys, trusted connectors, settings, audit log.
  apps/process-ui/       Demo process management. BFF (holds the API key, owns its own user
                         accounts) + Vite/React SPA. Cannot be a static SPA — it holds a secret.
  tests/e2e/             Playwright. Wiring and UI only, never protocol behaviour.
  docs/                  Design documents (below).
```

**Boundary rule, lint-enforced:** `apps/process-ui` may import `packages/client` and
`packages/protocol`. It may **never** import from `apps/connector`. If the demo UI needs something the
local API does not expose, that is a gap in the local API, not a reason to reach inside.

**Full stack, finalised, with reasons: [docs/STACK.md](docs/STACK.md).** Summary: pnpm workspace,
Node 24, TypeScript strict, **Vitest**. `zod` 4 (protocol shapes) + **`Ajv`** (definition-supplied JSON
Schema) — two validators, two jobs. `jose`, `did-resolver` + `web-did-resolver`, `canonicalize`,
**`ulidx`**, **`pino`**, `better-auth`, `mongodb` (large-party adapter only). NestJS 11 + Fastify for the
connector, **CommonJS** there and dual-output ESM/CJS for `packages/*`. Vite + React + Tailwind + shadcn
+ TanStack Query for both UIs, with a thin Fastify BFF for the process UI. ESLint + Prettier +
`eslint-plugin-boundaries`. Playwright.

Hand-rolled in `packages/protocol` because they *are* the spec: JSON Merge Patch, and a restricted ISO
8601 duration subset. Documents carry an `@context` so they are JSON-LD/ODRL-projectable, but there is
**no JSON-LD processor on the hot path**.

No ORM, no SQL, no migrations, no broker, no Redis, no BPMN engine.

## Key files

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — components, terminology, the three artefacts, hosting, trust
- [docs/PROTOCOL.md](docs/PROTOCOL.md) — wire spec: the three surfaces, auth, events, endpoints
- [docs/DEFINITIONS.md](docs/DEFINITIONS.md) — the process definition schema, annotated
- [docs/definitions/](docs/definitions/) — five real definitions used by the scenarios
- [docs/STACK.md](docs/STACK.md) — the finalised tech stack, and what each dependency buys
- [docs/TESTING.md](docs/TESTING.md) — the four test tiers and why scenarios are hermetic
- [docs/SCENARIOS.md](docs/SCENARIOS.md) — the end-to-end walkthroughs we are building toward
- [docs/ROADMAP.md](docs/ROADMAP.md) — milestones from empty repo to running demo
- [docs/superpowers/specs/](docs/superpowers/specs/) — design decision records, with the reasoning
- [docs/IDEA.md](docs/IDEA.md) — the original meeting sketch. Superseded; kept for provenance.
