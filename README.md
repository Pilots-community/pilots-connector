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

**M1, M2 and M3 are built — two connectors talk.**

| | |
|---|---|
| [`packages/protocol`](packages/protocol) | The specification: schemas, JCS, signing and chain verification, peer bearer tokens, the state-machine evaluator, the visibility filter, the definition linter, a JSON Schema export |
| [`apps/connector`](apps/connector) | The connector: the store (memory + file + Mongo, one conformance suite), all three API surfaces, the connection handshake, the relay, peer replication, local delivery, API keys and scopes, the hash-chained audit log, and a minimal admin UI it serves itself |

`docker compose up` runs **two connectors and zero databases**, with the first relayed transaction
about six seconds in. The scenarios that actually argue for the design — a party going offline
mid-process and catching up, and a host caught rewriting history — run as ordinary tests in
milliseconds, with no containers at all.

[docs/ROADMAP.md](docs/ROADMAP.md) M4 — quotations, links and deadlines — is next.

```bash
pnpm install
pnpm test               # 412 tests, ~2.6 s, no network, no containers, no real clock
pnpm lint:definitions   # check docs/definitions against the schema and the linter
pnpm build

docker compose up       # one container, no database, admin UI on /admin/
node apps/connector/scripts/bench.mjs   # the numbers below, measured
```

## Measured, not claimed

One container, zero databases. `docker run --memory=1g`, file store, after S1 has run:

| | |
|---|---|
| Image size | 221 MB |
| Cold start | ~220 ms |
| Memory in use | **~82 MiB — 8% of a 1 GB limit** |

And on a laptop, via `apps/connector/scripts/bench.mjs`:

| | file store | memory store |
|---|---|---|
| Cold start | ~450 ms | ~440 ms |
| Time to first transaction, from cold | ~110 ms | ~26 ms |
| Mean write latency | ~35 ms | ~0.9 ms |

The file store's write latency is one `fsync` per event: the honest price of "the log is the record".
