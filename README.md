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

**M1 through M6 are built — two parties run a negotiated process end to end, each through their own UI,
and every deployment topology has been started cold and measured.**

| | |
|---|---|
| [`packages/protocol`](packages/protocol) | The specification: schemas, JCS, signing and chain verification, peer bearer tokens, the state-machine evaluator, the visibility filter, the definition linter, a JSON Schema export |
| [`apps/connector`](apps/connector) | The connector: the store (memory + file + Mongo, one conformance suite), all three API surfaces, the connection handshake, the relay, peer replication, local delivery, links, deadlines, attachments, API keys and scopes, the hash-chained audit log, and a minimal admin UI it serves itself |
| [`packages/client`](packages/client) | The integration surface: a typed client for the local API and a committed OpenAPI document, so a non-TypeScript integrator generates their own |
| [`apps/process-ui`](apps/process-ui) | The demo process UI, its own container: a BFF holding one API key and owning its own users, and a SPA that renders transitions and forms **from the definition** — a new process needs no UI work |
| [`apps/mock-backoffice`](apps/mock-backoffice) | A participant with no UI, as a container: it holds one API key, reacts to `action.required`, and has no copy of the definition and no state machine of its own |

`pnpm demo:env && docker compose up` runs **four containers and zero databases** — two connectors and two process UIs —
with the first transaction about twelve seconds in, started by a person in a browser and relayed to the
other party. Stop either UI and the process carries on: it is a client, not part of the runtime. The scenarios that actually argue for the design — a party going offline
mid-process and catching up, and a host caught rewriting history — run as ordinary tests in
milliseconds, with no containers at all.

A negotiated quotation runs alongside the transport it authorises: the service instance exists from the
start, waiting, and a `link` advances it the moment the price is agreed. Deadlines fire from a scan loop
over stored state, so an offer expiring after a day is a test that advances a clock rather than one that
sleeps.

A party with no UI is a container too. Add one overlay file and Org B's backoffice applies `weigh`,
`recordPayment` and `issueVgm` unattended while Org A clicks in a browser, over an ordinary API key —
neither connector can tell which side had a person on it. A large party runs the same image against a managed document
store by adding one overlay file; a party that loses that store gets its hosted processes back from the
replicas of the peers it was hosting for, verifying every signature including its own.

[docs/ROADMAP.md](docs/ROADMAP.md) M7 — publish and deploy — is next, and starts on the supervisor's
word rather than on M6 finishing.

```bash
pnpm install
pnpm test               # 506 tests, ~4 s, no network, no containers, no real clock
pnpm lint:definitions   # check docs/definitions against the schema and the linter
pnpm build

docker compose up       # the full demo: 4 containers, 0 databases
pnpm bench:topologies   # every topology, started cold and counted
node apps/connector/scripts/bench.mjs   # the numbers below, measured
```

## Running the demo

Everything below has been run as written. The demo has two organisations, `org-a` and `org-b`. The
identifiers are neutral and fixed; the **names on screen are two environment variables**, so a demo for
a particular audience carries their names without a line of code changing — see
[Who the two organisations are](#who-the-two-organisations-are).

### What you need

| | |
|---|---|
| Node | 24 (`>=24 <25` — the repo pins it) |
| pnpm | 11 (`corepack enable` picks up the pinned version) |
| Docker | with `docker compose` v2, for the container demo only |

The test suite needs none of that beyond Node: no containers, no network, no database.

```bash
pnpm install
pnpm test               # 506 tests, ~4 s
```

### First run

```bash
pnpm demo:env
docker compose up
```

`demo:env` writes a **gitignored `.env`** with freshly generated credentials. It has to exist before
compose starts, because the compose file carries variable *names* and never values — nothing secret can
reach the repository by accident. Re-running it adds anything missing and rotates nothing.

Four containers, zero databases, healthy in about eleven seconds:

| | | |
|---|---|---|
| Org A's connector | http://localhost:3000 | admin UI at [`/admin/`](http://localhost:3000/admin/), token in `.env` as `ORG_A_ADMIN_TOKEN` |
| Org A's process UI | http://localhost:4000 | sign in as `alice@org-a.example` / `OrgA_123` (also in `.env`) |
| Org B's connector | http://localhost:3001 | admin UI at [`/admin/`](http://localhost:3001/admin/), token in `.env` as `ORG_B_ADMIN_TOKEN` |
| Org B's process UI | http://localhost:4001 | sign in as `bob@org-b.example` / `OrgB_123` (also in `.env`) |

The connectors are already connected to each other: `PILOTS_CONNECTIONS` seeds the handshake at boot so
that `up` reaches a first transaction inside a minute. That is a shortcut for the demo, not a
replacement — the handshake works without it, and `s0-connect.test.ts` is what proves it.

**Filling forms in a demo.** Every form carries a **Fill with sample data** button, generated from the
definition's own JSON Schema rather than from a table of field names — so a container number is random
but matches its pattern, a price clears its minimum, and a pickup window opens before it closes. Press
it again for a different payload. It is switched on by `PILOTS_UI_DEMO_TOOLS`, **a flag of its own
rather than a reading of `NODE_ENV`**: a deployed demo node runs `NODE_ENV=production` because it is a
deployment and still wants the affordance. Off unless asked for; compose sets it for both UIs.

**Every credential above is a fixed value from `.env`**, not something to go find in a log —
`PILOTS_SEED_ADMIN_TOKEN` and `PILOTS_UI_SEED_EMAIL`/`PILOTS_UI_SEED_PASSWORD` set them from
configuration the same way `PILOTS_SEED_API_KEY` does. All three are refused under
`NODE_ENV=production`: `/api/admin/v1` is meant to sit behind network-level access control rather than
be its own perimeter (see [Who the two organisations are](#who-the-two-organisations-are) and
[docs/ARCHITECTURE.md §4](docs/ARCHITECTURE.md)), so fixing its bootstrap token in a *local* `.env`
costs nothing — a real deployment never puts this port on the public internet in the first place. If you
would rather read it the way an operator without `PILOTS_SEED_ADMIN_TOKEN` has to:

```bash
docker compose logs org-a | grep -o '"adminToken":"[^"]*"'
```

If you have already restarted and lost track of a token that was *not* seeded, `docker compose down -v
&& docker compose up` starts over with a fresh identity.

### A first process, in two browsers

Put the two process UIs side by side — each names its organisation and its DID in the header, so which
is which is never in doubt. Processes are grouped by the question you actually arrive with:
**Your turn**, **Waiting on them**, **Quotations**, **Done** — with completed and stopped
distinguished, because a process that finished and one that was cancelled are not the same news.

1. **In Org A's UI** (`:4000`), sign in, open **Start**, and either pick a published **offering** —
   "Org B offers container weighing → *Start one*" — or choose `container-weighing@1.0.0` directly.
   Either way the **state machine is drawn before you commit**, so you can see the shape of what you
   are starting. Pick *Us* for `shipper` and Org B for `weigher`, fill in a container number and a
   terminal, and start it. Note what you never type: a DID. Roles come from the definition and *Us*
   is resolved by the UI's backend.
2. The instance appears at `ORDERED`. **Only `announceTruck` is offered** — the other transitions belong
   to the weigher, and the connector computed that from the definition rather than the UI guessing.
   Apply it.
3. **Switch to Org B's UI** (`:4001`). The same instance is there, marked *your turn*, offering `weigh`
   and nothing else. Weigh it.
4. Back in Org A's UI, open the instance and look at `grossMass`. **It is not there.** The definition
   grants that field to the shipper only from `PAID`, and it was withheld on the way out — Org A's
   connector never received it. Record the payment from Org B's side and it appears.
5. **Watch the other screen while you act.** Neither UI needs a reload: each polls every five seconds
   and on regaining focus, so Org B's move appears on Org A's list on its own. If you have a
   transition form half-filled when the other party moves, you get a banner saying so and **your
   entries are left alone** — and submitting anyway is refused with a `409`, because the form still
   carries the `seq` it was opened against. The UI's staleness handling and the protocol's
   concurrency control are the same mechanism.
6. **Look at the diagram** on the instance. The path actually taken is drawn bold, the current state
   is filled, and what remains is dimmed — so "where is this process" is one glance rather than a
   state name to interpret. Abort states sit in a lane below, and a `["*"]` transition like `cancel`
   is drawn once from an *any state* marker rather than once per state it could fire from.
7. Open the **event log** on either side. Every event is signed and chained, and the status beside it
   is the result of a check the UI's backend ran itself against the published keys — not something
   the connector asserted about itself.

### The UI is a client, not the runtime

```bash
docker compose stop org-a-ui
```

Carry on from Org B's side. Peers keep delivering, subscriptions keep firing, deadlines keep scanning.
Start it again and it shows the current state, having held none of it. This is the point of the split,
and it is worth doing once in front of an audience.

### Driving it with no UI at all

The process UI is one client of a documented API. Here is the same start, over `curl`, with the API key
`demo:env` generated:

```bash
set -a; . ./.env; set +a

ID=$(curl -s -X POST http://localhost:3000/api/local/v1/instances \
  -H "authorization: ApiKey $ORG_A_API_KEY" \
  -H 'x-actor-ref: dispatcher@org-a' \
  -H 'content-type: application/json' \
  -d '{"definition":"container-weighing@1.0.0",
       "participants":{"shipper":"did:web:org-a.example","weigher":"did:web:org-b.example"},
       "data":{"containerNumber":"MSCU1234567","terminal":"869"}}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["instance"]["id"])')
```

Advance it. `If-Match` is required, not optional — it is what makes a concurrent write a `409` instead
of a silent overwrite:

```bash
curl -s -X POST "http://localhost:3000/api/local/v1/instances/$ID/transitions" \
  -H "authorization: ApiKey $ORG_A_API_KEY" \
  -H 'x-actor-ref: dispatcher@org-a' \
  -H 'if-match: "1"' \
  -H 'content-type: application/json' \
  -d '{"transition":"announceTruck","patch":{"truckPlate":"1-ABC-123"}}'
```

And read it from the **other** organisation's connector, which has its own verified copy:

```bash
curl -s "http://localhost:3001/api/local/v1/instances/$ID" \
  -H "authorization: ApiKey $ORG_B_API_KEY" -H 'x-actor-ref: ops@org-b'
```

Every call went to the caller's *own* connector. Neither client addressed a peer, and neither knew which
side was hosting.

### A party with no UI at all

Org B can run a back-office system instead of a screen. One overlay adds it:

```bash
docker compose -f docker-compose.yml -f docker-compose.automated.yml up
```

Start a weighing from Org A's UI and stop clicking. Org B's backoffice applies `weigh`, `recordPayment`
and `issueVgm` on its own, over an ordinary API key, and Org B's audit log records
`weighbridge-controller` as the actor. It holds **no copy of the definition and no state machine** — it
is told it is its turn and what it may do, and posts the transition id back.

### A large party's document store

The other overlay puts Org B's connector on a managed document store, leaving Org A on the file store —
**the same image, different configuration**, which is the deployment claim in one command:

```bash
docker compose -f docker-compose.yml -f docker-compose.mongo.yml up
```

This is the one shape that costs a database container, and it costs it for one party.

> **Pass the same `-f` files to `down` as to `up`.** A `down -v` that does not name an overlay leaves
> that overlay's containers and volumes behind.

### Losing a connector's store, and getting it back

Worth showing, because it is the honest answer to "what happens when the host dies". Run it on the
managed-store overlay, where the documents live in the database and the **signing key does not** — which
is the split that makes it possible:

```bash
docker compose -f docker-compose.yml -f docker-compose.mongo.yml up -d
```

Start a weighing and advance it once, then destroy Org B's document store while leaving its key:

```bash
docker rm -f pilots-service-org-b-1 pilots-service-mongo-1
```

```bash
docker volume rm pilots-service_org-b-mongo
```

```bash
docker compose -f docker-compose.yml -f docker-compose.mongo.yml up -d org-b mongo
```

It comes back as the **same participant** — no "first boot" line in its log, because `/data` still holds
its key — with no processes at all. Ask it to fetch one back, using the admin token it printed on its
real first boot:

```bash
SID=$(curl -s -X POST http://localhost:3001/api/admin/v1/sessions -H 'content-type: application/json' -d '{"token":"adm_PASTE_YOURS"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["session"]["id"])')
```

```bash
curl -s -X POST "http://localhost:3001/api/admin/v1/instances/$ID/recover" -H "authorization: Session $SID" -H 'content-type: application/json' -d '{}'
```

```json
{
  "instanceId": "01M1H5A1…",
  "from": "did:web:org-a.example",
  "applied": 2,
  "seq": 2,
  "state": "TRUCK_ANNOUNCED",
  "home": true,
  "redacted": 0
}
```

It pulled the instance back from Org A's replica, verified every signature on the way in — including the
ones it made itself — and is the home node again, able to write the next event. `POST
…/instances/$ID/rebuild` then refolds it from that log and answers `"verified": true`.

Two honest limits, both visible in that response. `redacted` counts events whose payload the peer was
never allowed to see: the host lost those fields with its disk, and what it kept is the ability to prove
what happened. And on the **file** profile there is nothing to demonstrate this way — `/data` holds the
store *and* `secrets.json`, so losing one loses the other, and a connector that loses its key comes back
as a different participant for whom nothing previously signed still verifies. That is correct, and it is
why the two are kept separable.

### Who the two organisations are

The identifiers are fixed and neutral, so nothing about any particular company is committed:

| | |
|---|---|
| participant id | `org-a`, `org-b` |
| DID | `did:web:org-a.example`, `did:web:org-b.example` — the reserved `.example` TLD, so they resolve nowhere |
| compose services | `org-a`, `org-a-ui`, `org-b`, `org-b-ui` |

The **names on screen** are separate, and live in `.env`:

```bash
ORG_A_NAME="Northbound Freight"
ORG_B_NAME="Dockside Terminal"
```

`docker compose up -d` and both that organisation's screens — process UI and admin UI, header and
browser tab — carry the new name, while the DID underneath does not move. That separation is the point:
a label is configuration, an identity is not.

### Starting over

```bash
docker compose down -v          # containers and their volumes: fresh identities next time
pnpm demo:env                   # rotate credentials by deleting .env first
```

### Running the pieces without Docker

```bash
pnpm build
pnpm --filter @pilots/connector start        # :3000, needs `pnpm build` first
pnpm --filter @pilots/connector dev:ui       # admin UI on :5174, proxying :3000
pnpm --filter @pilots/process-ui dev         # the BFF on :4000
pnpm --filter @pilots/process-ui dev:web     # the SPA on :5175, proxying the BFF
```

One connector with no configuration comes up on the memory store with a generated identity, which is
enough to explore the admin UI and the local API. `apps/connector/.env.example` lists what it reads.

## Measured, not claimed

Every topology, started cold by `pnpm bench:topologies` — the container count is the argument, so it is
counted rather than asserted:

| Topology | Self-run per party | Containers | Databases | First transaction |
|---|---|---|---|---|
| Headless integrator | 1 | 2 | **0** | 5.6 s |
| Automated party | 1 + a backoffice | 4 | **0** | 11.4 s |
| Full self-hosting | 2 | 4 | **0** | 11.3 s |
| Fully hosted | **0** | 0 | **0** | — nothing to start |

Against a 60 s target. One container, zero databases — `docker run --memory=1g`, file store, after S1
has run:

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
