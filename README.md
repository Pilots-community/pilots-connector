# pilots-service

A demonstrator of **process sharing**: two or more logistics companies running a shared business
process from start to finish, all on the same connector software, each keeping their own way of working.

The design goal is that a one-truck haulier and a terminal operator can both run this — the same image,
two configuration files apart — or have someone else host it for them entirely.

**Start here: [AGENT.md](AGENT.md).** It carries the standing context, the settled decisions, and
pointers to everything else.

## What gets built

Three deliverables, so that bringing your own UI or your own backend is the normal path:

| | | Container |
|---|---|---|
| `apps/connector` | The core: three API surfaces + a minimal admin UI | 1 |
| `apps/process-ui` | Demo process management, for orgs not building their own integration | 1, optional |
| `packages/protocol`, `packages/client` | The spec, and the client + OpenAPI doc for integrators | — |

Which means the small-party deployment is **one container and no database** — the file store is a
mounted volume of JSON — and a fully hosted party runs nothing at all.

## The documents

```
AGENT.md                  standing context — read first
docs/ARCHITECTURE.md      components, the three artefacts, the three logs, hosting and trust
docs/PROTOCOL.md          wire spec: the three API surfaces, auth, events, endpoints
docs/DEFINITIONS.md       the process definition schema, annotated
docs/definitions/         five real definitions used by the scenarios
docs/STACK.md             the finalised tech stack, and what each dependency buys
docs/TESTING.md           the four test tiers, and why scenario tests need no containers
docs/SCENARIOS.md         the end-to-end walkthroughs we are building toward (S0–S4)
docs/ROADMAP.md           milestones from empty repo to running demo
docs/superpowers/specs/   design decision records, with the reasoning
docs/IDEA.md              the original meeting sketch — superseded, kept for provenance
```

## Where the code is

**M1 is built**: [`packages/protocol`](packages/protocol) — the specification, as schemas and tested
functions. Schemas, JCS canonicalisation, signing and chain verification, the state machine evaluator,
the visibility filter, the definition linter, and a JSON Schema export for non-TypeScript
implementations. [docs/ROADMAP.md](docs/ROADMAP.md) M2 (the connector) is next.

```bash
pnpm install
pnpm test               # unit tier: no network, no containers, no real clock
pnpm lint:definitions   # check docs/definitions against the schema and the linter
pnpm typecheck
pnpm lint
pnpm build
```
