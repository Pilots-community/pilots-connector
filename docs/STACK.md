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
| CI | **GitHub Actions** | the only place the Mongo conformance tier runs |

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
| Admin sessions | **better-auth** | admin surface only. Never accepted on `/api/local/v1` or `/api/peer/v1`. |
| API key hashing | **HMAC-SHA256 with a server-side pepper** | see §4.1 |
| SSE | **hand-rolled** | `text/event-stream`, `id:`, `data:`. We need custom `Last-Event-ID` catch-up anyway. |
| Store — memory | in-process maps | test default |
| Store — file | `node:fs` + in-process async mutex + write-temp/fsync/rename | the adapter is *documented* single-writer single-process, so this is sufficient and dependency-free |
| Store — mongo | **mongodb** driver | unique index on `{instanceId, seq}` and on idempotency keys |
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

Nest plus `reflect-metadata` costs roughly 30–50 MB of baseline RSS over plain Fastify. The < 150 MB
target stays reachable, but it is now a real constraint rather than a comfortable one.

**So the memory and cold-start check moves into M2's exit criteria.** If the framework blows the target,
M2 is when swapping it is still cheap; discovering it at M6 would be discovering it too late. This is the
one place where choosing the heavier option changes the plan rather than just the code.

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

## 8. Version policy

Pin exact versions in `package.json`; no `^` ranges in the pilot. Renovate or manual bumps, deliberately,
with the test suite as the gate. We are heading for a field-tested demo, and a transitive surprise during
a demo costs more than a stale minor version.
