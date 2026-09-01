# Stack

*Finalised 2026-08-26, before implementation. Standing rules in [../AGENT.md](../AGENT.md). Every entry
here is a decision someone can overturn — but not silently, and not without saying what the change buys.*

## 1. Rules for this file

1. **A dependency must say what it buys.** Container count, cold start and resident memory are
   acceptance criteria, not preferences.
2. **Prefer boring.** JSON Schema, JCS, `did:web`, JWS, JSON Merge Patch, SSE, RFC 7807. The composition
   is the contribution; the parts should be unsurprising.
3. **Spec behaviour is hand-rolled in `packages/protocol`.** Merge patch and duration parsing are *the
   specification*. A dependency there hides the thing we are defining.
4. **Everything external is a port.** No library gets to be load-bearing in a way that makes it hard to
   replace — see the ports table in [TESTING.md](TESTING.md).

## 2. Foundation

| Component | Choice | Notes |
|---|---|---|
| Runtime | **Node 24 LTS** | pinned via `.nvmrc` and `engines` |
| Language | **TypeScript**, `strict: true` | plus `noUncheckedIndexedAccess` |
| Package manager | **pnpm** workspaces | no Turborepo yet — see §7 |
| Task running | **pnpm scripts** | `pnpm test` runs unit + contract + scenario |
| Lint / format | **ESLint 9** (flat config) + **Prettier** + **typescript-eslint** | one lint run, inline in the editor |
| Boundary rule | **eslint-plugin-boundaries** | `process-ui → client, protocol` allowed; `process-ui → connector` forbidden |
| Tests | **Vitest** | workspace mode; fast enough to run on save |
| CI, build, publish | **GitHub Actions** | tests; the only place the Mongo conformance tier runs; publishes images to GHCR |
| Internal deploy | **Bitbucket Pipelines** + **Terraform** | separate infra repo, consumes GHCR images by tag. M7 — see §9 |

### 2.1 Module format

Not uniform, and deliberately so:

| Workspace | Format | Why |
|---|---|---|
| `packages/protocol`, `packages/client` | **dual ESM + CJS**, built with **tsup** | consumed by a CJS connector, ESM UIs, and possibly third parties |
| `apps/connector` | **CommonJS** | NestJS supports ESM but the ecosystem, its CLI and its decorator tooling are CJS-first. See §5.2. |
| `apps/process-ui`, admin UI | **ESM** | Vite native |

Chasing ESM into the connector would buy nothing and cost a week of tooling friction.

## 3. `packages/protocol` — the spec

| Need | Choice | Why |
|---|---|---|
| Protocol schemas | **zod 4** | The spec itself. Pin v4: `z.toJSONSchema()` is native, removing `zod-to-json-schema`. |
| Definition-supplied schemas | **Ajv**, 2020-12 dialect | A definition's `data` and `patch` are *user-supplied JSON Schema*. zod cannot validate those. |
| Canonicalisation | **canonicalize** | JCS RFC 8785, before every hash and every signature |
| Hashing | `node:crypto` | `sha256` for the event chain, the audit chain and attachments |
| Signing / JWS | **jose** | Ed25519 (`EdDSA`), compact JWS, bearer verification |
| DID resolution | **did-resolver** + **web-did-resolver** | `did:web` over ordinary HTTPS |
| IDs | **ulidx** | monotonic, sortable, seedable for the deterministic `IdGenerator` |
| JSON Merge Patch | **hand-rolled** | RFC 7386 is ~15 lines. It is spec behaviour and belongs here, tested. |
| ISO 8601 durations | **hand-rolled, restricted subset** — `P#D`, `PT#H`, `PT#M` | All a `deadline` ever needs. The linter rejects anything outside the subset, so the definition surface stays small. |
| Build | **tsup** | dual output; no decorators here, so esbuild is fine |

**Two validators, two jobs — do not unify them.** `zod` validates the protocol's own fixed shapes (event
header, instance, connection, API key, audit entry, subscription, offering). `Ajv` validates the
user-supplied schemas carried inside a definition. `packages/protocol` legitimately depends on both.

## 4. `apps/connector`

| Need | Choice | Why |
|---|---|---|
| HTTP framework | **NestJS 11** + **Fastify adapter** | DI for the six ports; guards map one-to-one onto the three auth surfaces |
| Logging | **pino** | Fastify-native, structured JSON to stdout, CloudWatch-shaped. Carries the `audit` flag. |
| Admin sessions | **built-in bootstrap token → session** (§10.1) | admin surface only. Never accepted on `/api/local/v1` or `/api/peer/v1`. `better-auth` deferred. |
| API key hashing | **HMAC-SHA256 with a server-side pepper** | see §4.1 |
| SSE | **hand-rolled**, both ends | `text/event-stream`, `id:`, `data:`. We need custom `Last-Event-ID` catch-up anyway, and `EventSource` cannot send an `Authorization` header — which a peer stream must. |
| Store — memory | in-process maps | test default |
| Store — file | `node:fs` + in-process async mutex + write-temp/fsync/rename | the adapter is *documented* single-writer single-process, so this is sufficient and dependency-free |
| Store — mongo | **mongodb** driver | unique indexes on `{participantId, instanceId, seq}` and on idempotency keys; multi-document **transactions** for `appendEvent`, so it requires a replica set and refuses to start without one. Loaded through a dynamic import, so the small profile never pulls it in at runtime. |
| Mongo in CI | GitHub Actions **service container** | boring; one dependency fewer than testcontainers |
| Timers | **scan loop over the `timers` collection, driven by `Clock`** | never `setTimeout` — see §4.2 |
| Static admin UI | **@fastify/static** | the admin UI is built by Vite and served by the connector |
| Container | `node:24-alpine`, multi-stage | resident memory is an acceptance criterion |

### 4.1 API key hashing — not a password KDF

An API key is a 256-bit CSPRNG secret, not a human password. Argon2 and bcrypt exist to slow brute force
of *low-entropy* input; against a random 256-bit key they buy nothing, and you would pay their cost on
**every API call**.

```
key given to the client:   ak_live_<id>_<secret>
stored:                    id        (indexed, plaintext)
                           HMAC-SHA256(pepper, secret)
lookup:                    by id, then constant-time compare
```

The pepper lives in configuration, so a store-only compromise yields nothing usable. Reaching for argon2
here is a reflex worth resisting; it is the wrong tool and an active throughput problem.

### 4.2 Timers are a scan loop, not `setTimeout`

`setTimeout` fails three requirements at once: it does not survive a restart, it cannot be driven by a
fake clock, and it has no meaning for the file store. A `timers` collection scanned against the `Clock`
port satisfies all three, and makes deadline tests instant.

## 5. Consequences of choosing NestJS

Stated up front so they are setup steps rather than surprises.

### 5.1 Vitest needs an SWC transform

esbuild — which Vitest uses — does not emit decorator metadata, so Nest's DI would receive `undefined`
for constructor parameter types. Fix is one plugin:

```ts
// vitest.config.ts  (apps/connector only)
import swc from 'unplugin-swc'
export default { plugins: [swc.vite()] }   // emits decorator metadata
```

`packages/protocol` has no decorators and needs none of this — its Vitest config stays plain, which
matters because that is the tier that must run on save.

### 5.2 CommonJS for the connector

See §2.1. Nest's CLI, its schematics and most of its ecosystem are CJS-first. `packages/*` ship dual
output precisely so this is a non-issue at the boundary.

### 5.3 Measure memory at M2, not M6

Nest plus `reflect-metadata` costs roughly 30–50 MB of baseline RSS over plain Fastify, which is worth
knowing before committing to it.

**So the memory and cold-start check moves into M2's exit criteria.** If the framework blows the target,
M2 is when swapping it is still cheap; discovering it at M6 would be discovering it too late. This is the
one place where choosing the heavier option changes the plan rather than just the code.

**Resolved at M2: it does not.** In a `--memory=1g` container running the file store, after S1 has run,
the connector uses **~82 MiB — 8 % of the limit**. Process RSS on a laptop reads higher (~130–145 MB)
because it counts shared and mapped pages, but the container's working set is what a deployment is sized
against. NestJS stays, and this section's trigger is spent.

## 6. UIs

| Need | Choice | Applies to |
|---|---|---|
| Build | **Vite** | admin UI, process UI |
| Framework | **React** + **TypeScript** | both |
| Styling | **Tailwind** + **shadcn/ui** | both |
| Server state | **TanStack Query** | both |
| Routing | **TanStack Router** | process UI. The admin UI is small enough to need almost none. |
| Process UI server | **Fastify** + **better-auth** | thin BFF: holds the API key, owns its own users, proxies via `packages/client` |
| E2E | **Playwright** | `webServer` starts local processes; containers only for S4c |

The process UI's BFF is deliberately the same server stack as the connector. A third party should be able
to read it as *"this is how you integrate"* rather than *"this is a framework demo"*.

## 7. Not in the stack

Named so each is a choice rather than an omission.

| Absent | Because |
|---|---|
| An ORM, SQL, migrations | document store behind a port; `instance.data` was always an app-validated blob |
| A JSON-LD processor on the hot path | documents carry `@context` for projection, nothing more |
| A workflow / BPMN engine | the definition **is** the state machine; requiring a counterparty to run an engine is a design regression |
| A message broker | the `queue` notification channel is a later **adapter**, not a dependency |
| Redis | nothing needs a second datastore; idempotency and timers live in the store |
| Turborepo / Nx | caching we do not need yet. Add when build time justifies it. |
| testcontainers | a GitHub Actions service container does the one job we need |
| `zod-to-json-schema` | zod 4 does it natively |
| argon2 / bcrypt | wrong tool for high-entropy keys — §4.1 |
| A DI framework in `packages/protocol` | it is pure functions. Ports are constructor arguments. |

## 8. Build, publish and deploy

Not built until **M7**, and only once the application runs locally. Recorded here so the shape is a
decision rather than a discovery.

### 8.1 Two CI systems, split by audience

Both build and both publish. Same Dockerfiles, same tests, same `pnpm` scripts — they differ only in who
the images are for.

| | System | Registry | Audience |
|---|---|---|---|
| Our demos | **Bitbucket Pipelines** | **AWS ECR** (private) | T-Mining's hosted demos, ECS or similar |
| Collaboration | **GitHub Actions** | **GHCR**, possibly public | other participants running the same setup |

**Both CI files are thin shims**, ~20 lines each, calling commands that also run locally. Build logic
lives in the repo, never in a CI system — so two configs cost almost nothing to keep in step, and a
contributor can run the pipeline on a laptop.

**Origin moves.** Bitbucket is origin through the build phase. When participants start collaborating,
GitHub becomes origin and Bitbucket becomes the mirror, so PRs land where the other participants work
while our own tooling keeps running off the mirror. The cutover is an event, not a milestone.

### 8.2 Terraform: in this repo, one organisation

`infra/modules/{connector,process-ui,did-hosting}` plus a complete runnable
`infra/examples/single-org-aws`. Anyone can stand up their own connector and UIs; process sharing still
needs a counterparty's connector, which is the design, not a gap.

**AWS is the reference implementation, not an abstraction.** `docker compose` is the zero-cloud path;
another cloud is an additive sibling module. Terraform abstracting over three clouds is a fiction that
costs more than it returns.

**`did:web` hosting is a separate module** — one static file over HTTPS at the participant's own domain.
Not the connector service, because keeping them apart is what preserves "no inbound endpoint required".

### 8.3 What must never enter this repo

The boundary is not deploy-code vs application-code. It is **reusable infrastructure code** vs **one
organisation's values and state**:

| Committed | Never committed |
|---|---|
| Terraform modules and a runnable example | account ids, ARNs, VPC/subnet ids, real hostnames |
| `terraform.tfvars.example`, `backend.tf.example` | `terraform.tfvars`, real backend config, any `*.tfstate` |
| The *names* of secrets the connector reads | any secret *value* |
| Both CI configs | registry credentials, pipeline secured variables |

So a live deployment is a private `terraform.tfvars` plus Bitbucket secured variables. No second repo is
needed for the module — only, at most, for one org's values.

Enforced by: `.gitignore` (already covers all of the above, before any of it exists), and **secret
scanning in CI from M1**.

### 8.4 Secrets, and why the key generates itself

Signing key, API-key pepper and better-auth secret are injected at runtime from a secret manager. An
image with a baked key is a committed key one layer down.

Better: **the connector generates its Ed25519 key on first boot**, writes the private half to the
configured secret store, and publishes the public half in `did.json`. No human, repo or pipeline variable
ever handles a private key — the rule stops being something to remember and becomes structurally true.
Designed in at M2, because retrofitting it after deployment exists is much harder.

### 8.5 Publishability starts at M1

The repo is expected to become public. **Git history cannot be un-leaked**, so every rule in §8.3 applies
from the first commit, not from M7. The demo DIDs already use the reserved `.example` TLD, so the
scenarios and definitions are publishable as they stand — keep it that way.

## 9. Version policy

Pin exact versions in `package.json`; no `^` ranges in the pilot. Renovate or manual bumps, deliberately,
with the test suite as the gate. We are heading for a field-tested demo, and a transitive surprise during
a demo costs more than a stale minor version.

---

## 10. Amendment, M2 — what implementation changed

Four deviations from the table above, recorded rather than absorbed. Each is reversible.

### 10.1 `better-auth` deferred for the *connector* admin — with the real reason

An earlier draft of this note claimed better-auth "wants a user table and a database adapter" and would
not fit a document store. **That was wrong**, and checking beats assuming: better-auth 1.7.2 ships
`memory`, `mongodb`, `kysely`, `drizzle` and `prisma` adapters. The Mongo one lands in M3 with the Mongo
store, so adopting it later is configuration, not an integration project.

The actual reason is a design one. **The connector is deliberately not an identity provider** — that is
what keeps a third-party-hosted connector from ending up holding your user accounts
([PROTOCOL.md §2.3](PROTOCOL.md#23-admin--human--admin-ui)). Its admin has no users, no email, no
passwords and no sign-up: it is **one operator per connector**. Adopting an auth library there would mean
*inventing* an admin account with a password to give the library something to manage — more surface, not
less, and a human password is the one case where §4.1's argument would flip and demand argon2.

So the connector's admin uses the primitive that fits a single operator's first run, the same one Grafana,
Vault and Jupyter use: a 256-bit token generated on first boot, printed once, stored only as
`HMAC-SHA256(pepper, token)`, exchanged for a session. It is **92 lines with four methods**
(`create`, `signIn`, `verify`, `signOut`) and it hand-rolls no cryptography — `createHmac`,
`randomBytes` and `timingSafeEqual` from `node:crypto` do the work.

**This must not grow into an auth library.** The trigger is explicit: *the moment a second operator, a
password login, account recovery, or sessions that survive a restart is wanted, adopt better-auth rather
than extending this.* By then Mongo is already there and the adapter is off the shelf.

**better-auth's real home in this project is the process UI's BFF** (§6), which owns actual user
accounts. That is still the plan, and it is where the library earns its keep.

### 10.2 `ajv-formats` added

`format: "date-time"` appears in four of the five shipped definitions. Without `ajv-formats`, Ajv ignores
`format` entirely, so those constraints would be decorative. One small dependency, and the alternative is
a definition schema that silently does not mean what it says.

### 10.3 TypeScript pinned to 5.9.3, not 7.x

TypeScript 7 is current, but `tsup`'s declaration bundler crashes under it today, and M2 needed NestJS
decorator metadata to keep working. §9's version policy — pin exact, prefer a stale minor over a
transitive surprise — points at 5.9. Revisit when the toolchain has caught up.

### 10.4 The admin UI is Tailwind without shadcn/ui

§6 named shadcn/ui. The admin UI has five screens and about a dozen controls; shadcn's generator,
`components.json` and Radix dependencies would be more scaffolding than component. The markup follows the
same idiom, so adding shadcn later is additive rather than a rewrite. **The process UI at M5 is where
shadcn earns its place** — it is the one a third party reads as "this is how you integrate".
