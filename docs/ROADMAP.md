# Roadmap

*From an empty repo to S1 and S2 running. Every milestone ends in something you can show someone, not
in a document.*

## Guiding constraints

1. **`docker compose up`, one command, under a minute.** If a milestone adds a container or a
   dependency, it must say what that buys.
2. **`packages/protocol` is the spec.** Behaviour that is not a schema or a tested function there is
   not decided. This is the one rule that prevents documentation and runtime from drifting apart.
3. **Signatures are stubbed behind an interface until M3.** In dev mode the connector trusts the
   asserted DID. Real crypto must not block the state machine — but the interface must exist from M1 so
   that switching it on is a configuration change, not a refactor.
4. **Tests stay hermetic.** No milestone may introduce a unit, contract or scenario test that needs a
   network, a container or a real clock. See [TESTING.md](TESTING.md).

---

## M1 — The protocol package

One package, no server. This is the milestone that decides whether the design is real.

- Zod schemas: definition, instance, event header, event, connection, offering, **API key, audit entry,
  notification subscription**. `zod` 4, so JSON Schema export is `z.toJSONSchema()`.
- **Ajv** (2020-12) wired for the JSON Schema *inside* a definition — `data` and `patch`. Distinct job
  from zod; see [STACK.md §3](STACK.md#3-packagesprotocol--the-spec).
- JCS canonicalisation (RFC 8785), `sha256` helpers, event-header hashing, **audit-entry chaining**
  (the same primitive, applied to a second chain).
- `Signer` interface + local Ed25519 implementation; `verify()` against a resolved `did:web` document.
- **`Clock` and `IdGenerator` port definitions**, with deterministic test implementations. Nothing
  downstream may read the wall clock or generate an id directly.
- Chain verification: given an ordered list of headers, confirm `prev` linkage, `from`/`to` continuity
  and signatures. Must pass with **redacted payloads**.
- State machine evaluator: given a definition, a current instance and a proposed transition, return the
  next instance or a typed error. Pure function, no I/O.
- **`availableTransitions(definition, instance, roles)`** — which transitions this participant may fire
  right now. One rule with three consumers: `action.required` notifications, the UI's buttons, and the
  permission check. Pure function; belongs here so the three cannot disagree.
- JSON Merge Patch (RFC 7386) application and patch-schema validation.
- Visibility filter: given a definition, a role and an instance or event, return the filtered view.
- Definition linter, replacing `tools/lint-definitions.py` (then delete that file).
- JSON Schema export, so the definitions can be validated by non-TypeScript implementations.

- **Secret scanning in CI**, from the first pipeline. The repo is expected to go public (M7), and history
  cannot be un-leaked, so this is cheap now and impossible later.

**Exit:** `pnpm --filter protocol test` is green; the five definitions in `docs/definitions/` load and
lint; a tampered event fails verification; a redacted event does not.

## M2 — The connector, single party

`apps/connector`. NestJS + Fastify. No database container.

- **The store**: repository port, memory and file adapters, and the conformance suite
  ([TESTING.md §3.2](TESTING.md#32-contract)). `participantId` on every document from the first write.
  The two operations that shape the port — atomic `appendEvent`, `claimIdempotencyKey` — are the ones
  the suite is really about.
- Definition registry: load from disk, verify content hash, cache, serve.
- **Offerings**: schema, admin publish / update / withdraw, and `GET /offerings`. Publishing an offering
  is what makes a participant a supplier, so it belongs with the store and the admin UI rather than at
  M4 — nothing about it is protocol-hard.
- **Home-node resolution is per instance from the first write**: definition names a role, the instance's
  `participants` map names the participant, and the stored instance carries the resolved `home` flag.
- **All three API surfaces exist from the start**, even where thin: `/api/peer/v1`, `/api/local/v1`,
  `/api/admin/v1`. Retrofitting a surface split later would touch every route.
- **API keys and scopes**: creation, hashing at rest, revocation, scope enforcement, `X-Actor-Ref`.
- **The audit log**: hash-chained, every admin action, every mutating local call, every refusal.
- **The application logger**: structured stdout, with the `audit` flag that routes an entry to the audit
  sink from one call site.
- `POST /instances`, `GET /instances[/{id}]`, `POST /instances/{id}/transitions`,
  `GET /instances/{id}/events` on the local surface, running against the M1 evaluator.
- `If-Match` / `409` / `428`, `Idempotency-Key`, RFC 7807 errors.
- `auto` transitions fire on state entry — which is what makes standing quotations work.
- `GET /.well-known/did.json` served from configuration.
- **The signer bootstraps its own key**: on first start, generate Ed25519, write the private half to the
  configured secret store (env / file / secret manager, behind the same port), publish the public half in
  `did.json`. No key is ever typed, committed or passed through a pipeline variable. Cheap here; awkward
  to retrofit once deployment exists.
- **Notification subscriptions**: the schema, admin CRUD, and the `NotificationChannel` port with the
  in-memory adapter. Delivery machinery itself lands in M3; the model exists here so the store and the
  admin UI carry it from the first write.
- **The admin UI starts here**, minimal: mint and revoke an API key, browse the audit log, register a
  notification subscription. It is needed to *operate* this milestone.

**Exit:** one container, no database. S1's full weighing sequence runs against the **local API** with
`curl` and an API key, single-party, no counterparty. Visibility filtering demonstrably withholds
`grossMass` before `PAID`. The audit log shows every call, including a deliberately refused one.

**Plus a measured number: resident memory and cold-start time.** NestJS costs roughly 30–50 MB of
baseline RSS over plain Fastify, so the < 150 MB target is a real constraint rather than a comfortable
one ([STACK.md §5.3](STACK.md#53-measure-memory-at-m2-not-m6)). M2 is when swapping the framework would
still be cheap; finding out at M6 would be finding out too late.

## M3 — Two connectors: connections, delivery, replication, and the scenario harness

The milestone where it becomes a *shared* process. The harness comes **first**, because it is what makes
the rest of the milestone testable.

- **The in-process `Transport` and the scenario harness**: two connector instances in one process, fake
  clock, memory store. S0–S2 become hermetic tests before a container demo exists.
- Connection handshake — request, accept, accepted, rejected — with `did:web` resolution and the
  domain-binding check. Accept and reject on the **admin** surface; `accepted` / `rejected` on the
  **peer** surface. Config-seeded connections as a demo shortcut.
- **Peer delivery**: `webhook` push with backoff, and `stream` (SSE) with `Last-Event-ID` catch-up. Both
  emit the identical signed event object.
- **Local delivery / notifications**: the `webhook` and `sse` channel adapters, `action.required` and
  `action.cleared` computed from `availableTransitions`, subscription filtering, at-least-once ordered
  delivery, backoff, dead letters, and cursor replay. Kept clearly distinct from peer delivery.
  Queue adapters are explicitly **not** built here — the port is what makes them a later, additive change.
- **The relay**: the local API resolves `hostedBy` and forwards to the home node, with the
  `peer-unreachable` / `peer-response-invalid` problem types kept separate from a real `409`.
- Peer replication: verified local replica of every instance the participant is in; `?since=` pull as the
  authoritative recovery path.
- Node-to-node auth switched on: JWS bearer, DID resolution, `aud` and `exp` checks, `jti` replay
  rejection. Dev-mode trust becomes a flag that refuses to start under production config.
- Event signing switched on for real.
- **The Mongo adapter**, running the same conformance suite in CI. This is where a single-writer
  assumption would first bite, and the port is still cheap to change.
- Admin UI gains connection accept / reject and the trusted-peer allowlist.

**Exit:** **S4a, S4b and S5 pass as scenario tests, in milliseconds, in `pnpm test`** — those are the
milestone's real acceptance tests, not the happy path. **S5 matters disproportionately here**: it is the
only thing that catches a per-definition hosting shortcut, which the one-directional demo would happily
hide. Plus: **S1 runs with an automated participant** — a test fixture that subscribes to
`action.required` and posts back the transition it names, with no UI and no human in the loop. Then, separately: two containers, `docker compose up`, S1 runs end to end
across both, and each side's replica verifies against the other's.

## M4 — Quotations, links, deadlines

- `POST /instances` accepting a `quotationId`; quotation and service instances side by side.
- `links` evaluation: subscribe to a related instance's events, fire the named transition on a match,
  and record *which signed event* caused the advance.
- Deadline scheduling and `onDeadline` firing; transitions with `by: []` invocable only by the runtime.
  **Tested by advancing the fake clock — no test sleeps.**
- Attachments: content-addressed store, upload, `GET /attachments/{sha256}`, visibility-filtered on both
  surfaces.
- Standing quotations surfaced through offerings (the offering itself landed in M2).

**Exit:** **S2 runs end to end as a scenario test and across two containers**, including the
counter-offer loop, the auto-started service instance, the `409` on a stale `If-Match`, and an offer
expiring on its deadline.

## M5 — The process UI and the integration surface

`apps/process-ui` as its **own container**, and the client package that makes it replaceable. The admin
UI already shipped incrementally in M2 and M3.

- **`packages/client`**: typed local-API client plus an OpenAPI document, so a non-TypeScript integrator
  can generate their own. The same export discipline as M1's JSON Schema export.
- `apps/process-ui`: BFF holding one API key and owning its own user accounts, plus the SPA.
- Offerings browser; start a quotation or a service instance.
- Instance list and detail: current state, the data document as the caller may see it, and the
  available transitions for *this* participant's role — rendered generically from the definition, so a
  new definition needs no UI work.
- Event log with per-event verification status. **A broken chain must be loud and red.**
- **The boundary lint rule**: `apps/process-ui` may import `packages/client` and `packages/protocol`,
  never `apps/connector`.
- **Playwright** arrives: process UI flows plus the admin flows (mint a key, accept a connection, read
  the audit log, see a red chain). Wiring and UI only.

**Exit:** S1 and S2 driven entirely through the process UI **on both sides** — every step verifiable and
demonstrable by hand, which is what the first real demo needs. Then the same runs again with Van Moer's
UI idle and its mock backoffice driving instead, over a notification subscription: same process, same
connector image, advancing unattended. **And: either process-UI container can be stopped without the
connector caring**, which is the split's whole point.

## M6 — Measure and harden

- The managed document-store profile for the large party; the file store stays the small-party default.
- The mock backoffice as a separate tiny service, so "one side automates, the other clicks" is a real
  deployment difference rather than a slide.
- **S4c**: a `bench` script that prints containers, resident memory, cold-start time and
  time-to-first-transaction, **for each of the four topologies** (0, 1, 1 and 2 self-run containers per
  party; 4 for the full two-party demo). Record the numbers in `ARCHITECTURE.md §12`.
- Retries, dead letters, replay from log, and re-hosting a stalled instance from a replica.
- Multi-participant-per-connector exercised at least once in a test, to keep the hosted path honest.
- Audit log retention and export.

**Exit:** the cost targets in `AGENT.md` are measured, not claimed. S1, S2, S4a, S4b and S4c all run
from one command.

## M7 — Publish and deploy

Nothing here changes the application; it packages and ships what M1–M6 built.

**Triggered by an event, not by a milestone.** M7 starts when collaboration with other participants
begins — the same event that moves origin to GitHub (§"The GitHub cutover"). At that point AWS
verification becomes critical, because participants need to run against something real rather than
against a laptop. Until then it is **not a blocker of any kind, and everything stays local**.

**Finishing M6 is not a green light.** The human supervisor says when to release. Do not begin M7 work —
Dockerfiles for publication, CI configs, Terraform — on the strength of the roadmap alone.

### Two CI systems, split by audience — not by job

Both build and both publish. They differ in *who the images are for*.

| | System | Registry | For |
|---|---|---|---|
| Our own demos | **Bitbucket Pipelines** | **AWS ECR** (private) | T-Mining's hosted demos on ECS or similar |
| The collaboration | **GitHub Actions** | **GHCR**, possibly public | other project participants running the same setup |

Same Dockerfiles, same test suite, same `pnpm` scripts. **Both CI files are thin shims** — roughly twenty
lines each, calling commands that also run locally. The build logic lives in the repo, so keeping two CI
configs in step is nearly free and a contributor can run the whole pipeline on a laptop.

- **Images**: `connector` and `process-ui`, multi-stage, **multi-arch amd64 + arm64** — development is on
  arm Macs and servers are not.
- **Tagging**: semver from the git tag, plus the git SHA, plus `latest` on release. Terraform pins an
  explicit version; `latest` in a deploy means the deploy is not reproducible.

### Terraform, in this repo, single-organisation scope

Anyone reading this repo should be able to stand up **their own** connector and UIs on their own
infrastructure. End-to-end process sharing still needs a counterparty's connector — that is a property of
the design, not a gap in the module, and the example's README says so plainly.

```
infra/
  modules/
    connector/        one participant: service, store, secrets wiring
    process-ui/       optional
    did-hosting/      static /.well-known/did.json  — deliberately separate
  examples/
    single-org-aws/   complete and runnable, one participant
      terraform.tfvars.example
      README.md       what you still need from a counterparty
```

**AWS is the reference implementation, not an abstraction.** It is what we run. `docker compose` remains
the zero-cloud path. Another cloud is an additive sibling module someone contributes. Terraform that
abstracts over AWS, GCP and Azure is a fiction that costs more than it returns.

**`did:web` hosting is its own tiny module.** It needs one static file reachable over HTTPS at *the
participant's own domain* — S3 + CloudFront, or any static host at all. Deliberately **not** the connector
service: keeping it separate is what preserves "a `stream`-delivery party needs no inbound endpoint".

### The GitHub cutover

When participants start collaborating, **GitHub becomes origin and Bitbucket becomes the mirror.** PRs
then land natively where the other participants work, while our org tooling and Pipelines keep running off
the mirror.

The cutover is an *event*, driven by collaboration readiness rather than by a milestone. M7's job is to
leave the repo **ready** for it: both CI configs present, no Bitbucket-specific assumption baked in, and
nothing in the history that would embarrass us on a public repo. That last part is not M7 work — see
§"Publishability is an M1 concern" below.

### Secrets never enter an image or the repo

- The Ed25519 signing key, the API-key pepper and the better-auth secret are injected at runtime from a
  secret manager. An image with a baked key is the same mistake as a committed key, one layer down.
- The connector **generates its signing key on first boot**, writes the private half to the configured
  secret store, and serves the public half in `did.json`. No human, no repo and no pipeline variable ever
  handles a private key — the rule becomes structurally true rather than a thing to remember. Designed in
  at M2; see that milestone.

**Exit:** a tagged release publishes both images; Bitbucket Pipelines deploys one participant to ECS from
Terraform with no manual step; a third party can run `infra/examples/single-org-aws` against their own
account using only the committed files plus their own `terraform.tfvars`; and a secret scan over the full
history is clean.

### Publishability is an M1 concern, not an M7 one

Called out here because this is where the reasoning lives, but the work starts immediately.

Since the repository is expected to become public, **every commit from M1 onward is a commit that will be
public.** Git history cannot be un-leaked. So from the first milestone:

- `.gitignore` already excludes `*.tfvars`, `*.tfstate*`, `.terraform/`, backend config and file-store
  data — before any of those exist.
- No account id, ARN, VPC or subnet id, real hostname or internal URL is ever committed. Secret *names*
  are fine; secret *values* and infrastructure identifiers are not.
- The demo DIDs use the reserved `.example` TLD (`did:web:acme-shipping.example`), so the scenarios and
  definitions are publishable as they stand. Keep it that way.
- **Secret scanning runs in CI from M1**, when CI first exists — not from M7, when it would be too late.

---

## Deliberately not in scope yet

Named so they are choices rather than omissions:

- **A `public` view-only surface.** A long-lived token in a URL, letting a party with no connector watch
  a process progress. The visibility filter it needs is built in M1, so this is mostly token issuance
  and revocation plus a decision about which role the viewer is filtered as. See
  [PROTOCOL.md §11](PROTOCOL.md#11-deferred-a-public-view-only-surface).
- **Queue channels for notifications** (SQS, AMQP, Pub/Sub). `webhook` and `sse` cover the pilot. The
  `NotificationChannel` port and the subscription model are built so a queue adapter is additive — if
  adding one requires changing subscriptions, notification types or the envelope, that is a design bug.
- **Per-definition or per-role API key scoping.** Flat scopes for the pilot.
- **Verifiable credential gates on transitions.** The hook belongs in the definition schema now
  (`requiresCredential`); enforcement can wait.
- **Remote signers.** The `Signer` interface exists from M1; a second implementation is a later day. A
  hosted connector holding the participant's key is an accepted trade-off, not a blocker — see
  [ARCHITECTURE.md §8.1](ARCHITECTURE.md#81-what-this-does-not-do).
- **A federated catalogue.** A definition is a URL and a participant is a DID, so discovery can be
  layered on top without touching the execution core.
- **Publishing the event log as a stream for third parties.** The visibility filter is the hard part
  and it is built in M1; publication is plumbing.
- **Horizontal scaling of the small profile.** The file adapter is single-writer by design. Scaling out
  means moving to the document-store profile, not making the file store clever.
- **Anything that requires a counterparty to run a workflow engine.** A party must always be able to
  integrate with two HTTP calls and one event connection. If that stops being true, the design has
  regressed.
