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
baseline RSS over plain Fastify ([STACK.md §5.3](STACK.md#53-measure-memory-at-m2-not-m6)). M2 is when
swapping the framework would still be cheap; finding out at M6 would be finding out too late.
*Measured at M2: ~82 MiB in a 1 GB container, so the framework stays.*

## M3 — Two connectors: connections, delivery, replication, and the scenario harness ✅ done

The milestone where it becomes a *shared* process. The harness came **first**, because it is what made
the rest of the milestone testable — and it paid for itself immediately: S4a, S4b and S5 were caught,
written and proven before a second container existed.

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

**Exit — met.** S0, S1, S4a, S4b, S4d and S5 run as scenario tests in `pnpm test`: 24 files, 412 tests,
about 2.6 seconds, no containers and no network. S1 also runs with an **automated participant** — a
fixture that subscribes to `action.required` and posts back the transition the envelope names, with no
UI, no human, no copy of the definition and no state machine of its own. The Mongo adapter passes the
same 111-case conformance suite as memory and file, against a real replica set.

Then, across containers: `docker compose up` brings up **two connectors and zero databases**, both
healthy in ~5.7 s, first relayed transaction at ~6.0 s against a 60 s target, ~82–86 MiB each against a
1 GB limit. S1 runs end to end across both — including `grossMass` withheld before payment and
released after — and Org A's replica verifies independently against Org B's published key. S4a was
run against the containers too: Org A stopped mid-process, Org B advanced two steps, Org A restarted
and converged with no operator action.

**Two things changed in the spec while building this**, both recorded in
[PROTOCOL.md](PROTOCOL.md#7-events):

- **`genesis` on every event header.** Authority is judged against the definition and the participants
  map, and neither lived in the log — so a replica had to take the sender's word for them. A home node
  could have handed over a perfectly signed, perfectly chained history with a participants map naming
  somebody who was never in the instance.
- **The actor signs, not the home node.** §7.1 and §7.3 both say the verifying key is the *actor's*;
  §9's prose said "the home node signs", which cannot be both. The relay now signs before it forwards,
  using the `seq` and `prev` `If-Match` already implies.

## M4 — Quotations, links, deadlines ✅ done

- `POST /instances` accepting a `quotationId`; quotation and service instances side by side.
- `links` evaluation: subscribe to a related instance's events, fire the named transition on a match,
  and record *which signed event* caused the advance.
- Deadline scheduling and `onDeadline` firing; transitions with `by: []` invocable only by the runtime.
  **Tested by advancing the fake clock — no test sleeps.**
- Attachments: content-addressed store, upload, `GET /attachments/{sha256}`, visibility-filtered on both
  surfaces.
- Standing quotations surfaced through offerings (the offering itself landed in M2).

**Exit — met.** S2 runs as a scenario test and across two containers: the service instance created up
front and provably unable to advance, the counter-offer loop, the link firing `startExecution` when the
quotation reaches `AGREED`, `driverName` withheld at `ASSIGNED` and released at `PICKED_UP`, a `409` on
a stale `If-Match` passed through the relay unchanged, and an offer expiring on its `PT24H` deadline —
by advancing a fake clock, not by shortening the duration. 427 tests, ~2.9 s, no containers.

Attachments landed with it: content-addressed upload, cross-connector pull, and read permission
**derived from `visibility`** rather than declared again. The store port's conformance suite now covers
document bytes too, and Mongo passes all 123 cases against a real replica set.

**One spec change**, recorded in [PROTOCOL.md §7.1](PROTOCOL.md#71-format): **`cause` on the event
header.** A transition with `by: []` is one no participant may invoke by hand, so it was the single
place a host could have invented history unchallenged. `cause` names the signed event that justified it,
and a counterparty can find that event in the instance it already holds and check the claim. Verified
across containers: the `startExecution` the transporter's connector wrote points at exactly the
`accept` event the shipper independently holds.

**One correction.** The zod schema said a `deadline` is "measured from entry into the `from` state".
The linter, [DEFINITIONS.md](DEFINITIONS.md) and every shipped definition say it arms on entry into the
transition's **`to`** state — and only that reading can ever fire, since `offer` leads to `OFFERED` and
`expire` applies in `OFFERED`. The comment was the outlier and is now fixed.

## M5 — The process UI and the integration surface ✅ done

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

**Exit — met, with one part carried to M6.** S1 runs end to end through the process UI on **both**
sides: two UIs, two user accounts, two connectors, and a person clicking. Org A never types a DID — the
role selects come from the definition and "Us" is resolved by the BFF. And the split holds: with
`org-a-ui` stopped, Org B issued the VGM, Org A's *connector* replicated it, and the UI came back
showing `VGM_ISSUED` having held no state at all.

`pnpm demo:env && docker compose up` now gives the full demo: **four containers, zero databases**, all
healthy in ~11.3 s, first transaction through the UI at ~11.6 s against a 60 s target, ~45 MiB per UI
and ~52 MiB per connector.

`demo:env` generates a **gitignored** `.env` that compose reads automatically, so the compose file
carries variable names and never values — a connector and its UI simply agree on one key. Remotely the
same variables come from a secret manager, and `PILOTS_SEED_API_KEY` is refused under
`NODE_ENV=production` regardless, because a key whose value was decided outside the connector is a
demo convenience rather than a deployment pattern.

**Carried to M6:** the same run with Org B's UI idle and a mock backoffice driving over a
notification subscription. The behaviour is proven — an automated participant runs S1 in the scenario
tier with no UI and no human — but not yet as a container in the demo.

**Three things this milestone found, which is what a UI is for.**

- **The boundary lint rule was silently inert.** `eslint-plugin-boundaries` had no module resolver, so
  it classified nothing and reported nothing, from M2 until now. Adding
  `eslint-import-resolver-typescript` makes it refuse `apps/process-ui → apps/connector` — verified by
  writing the violation and watching it fail. A lint rule is quiet whether it works or not; the only
  proof is watching it refuse something.
- **The local API could not answer "who am I".** A client needs its own DID to fill a `participants`
  map — a definition names a role, and only an instance names who fills it — and nothing on the
  surface said. `GET /api/local/v1/me` closes it. This is exactly the gap the boundary rule exists to
  surface: the fix belongs in the API, not in the UI's configuration.
- **A key minted at boot was not audited.** The demo's integration key is generated by the runtime
  rather than through the admin controller, so it appeared with no record of where it came from —
  which is the one thing the audit log exists to prevent.

## M6 — Measure and harden ✅ done

- The managed document-store profile for the large party; the file store stays the small-party default.
- The mock backoffice as a separate tiny service, so "one side automates, the other clicks" is a real
  deployment difference rather than a slide.
- **S4c**: a `bench` script that prints containers, resident memory, cold-start time and
  time-to-first-transaction, **for each of the four topologies** (0, 1, 1 and 2 self-run containers per
  party; 4 for the full two-party demo). Record the numbers in `ARCHITECTURE.md §12`.
- Retries, dead letters, replay from log, and re-hosting a stalled instance from a replica.
- Multi-participant-per-connector exercised at least once in a test, to keep the hosted path honest.
- Audit log retention and export.

**Exit — met.** `pnpm bench:topologies` starts each topology cold and counts what is actually running:
2 containers headless, 4 with a UI, 4 with a backoffice, **0 databases** in every one, first transaction
5.6–11.4 s against a 60 s target. The numbers are in
[ARCHITECTURE.md §12.1](ARCHITECTURE.md#121-measured-at-m6) and the targets in `AGENT.md` now say
*measured* rather than *target*. S1, S2, S4a, S4b and S4c all run from one command.

The automated participant became a container: Org A clicks in a browser while Org B's backoffice
applies `weigh`, `recordPayment` and `issueVgm` unattended, over an ordinary API key with an ordinary
`X-Actor-Ref` — Org B's audit log says `weighbridge-controller`, and neither connector can tell which
side had a person on it.

Both new shapes are **overlays**, not modes: `docker-compose.automated.yml` adds the backoffice and the
subscription that feeds it, `docker-compose.mongo.yml` adds the document store. `docker compose up`
stays the four-container two-party demo, because a party's own back-office system is that party's fifth
container rather than the demo's — a distinction Playwright made for us, by failing when the backoffice
started answering for Org B before the test could click.

**Four things this milestone found**, three of them bugs that only a harder look would surface.

- **A large party regenerated its signing key on every restart.** The secret store was chosen by
  `adapter === 'file'`, so the *managed* profile — the party most likely to restart — kept its key in
  memory. Every restart minted a new key, republished a new DID document, and left every event it had
  ever signed unverifiable, while the connector came up looking healthy. The rule is now durability,
  not adapter, in a named function with a test. Found by running the profile rather than by reading it.
- **A degraded subscription lost its notifications permanently.** Only `ACTIVE` subscriptions were
  recorded, so the moment a backoffice had a bad minute, everything it had not yet received was dropped
  rather than delayed. `PAUSED` is the only status that should stop the recording, because an operator
  asked for it.
- **`action.required` fired on the wrong edge.** It announced the transition from nothing-available to
  something-available, rather than *entering a state where something is available*, so a party that was
  already able to act was told nothing when its turn came round again.
- **Recovery had to be split in two.** "Rebuild from the log" and "recover from a peer" look like one
  operation and are not: one needs the instance identity the log commits to by hash but does not
  contain, and the other is handed it by the peer. Conflating them would have made a wiped store
  unrecoverable and a corrupt cache a network call.

Re-hosting is the part worth demonstrating in person. Destroy the host's document store, leave its
signing key where it belongs — in a secret manager, not on the dead disk — and the connector comes back
as the *same participant*, pulls its hosted processes from the replicas of the peers it was hosting for,
verifies every signature including its own, and carries on writing at the next `seq`. What it cannot
recover are fields the peer was never allowed to see; `recover` counts them rather than pretending.

## M6.5 — Open foundation: authoring, validating and adopting definitions ✅ done

The demonstrator's point is **process sharing**, not the five processes that happen to be committed.
M6.5 is what makes that true in the software rather than in the prose: a participant writes their own
process, publishes it on their own integration surface, and runs it with a counterparty who has never
seen it — no shared definitions directory, no redeploy, no operator copying a file.

Prompted by a failure. Driving the demo by hand dead-ended in a state whose only offered action was
*cancel*, because `container-transport` is contracted by a quotation and the process UI never set
`quotationId`. The tempting fix — teach the UI about that pair of definitions — was the wrong one, and
what came out of asking why is the shape of the milestone.

**What it delivered**

- **A definition can be valid while an instance under it is not.** `links` are declared per definition
  and anchored per instance, so a link-fired transition is walkable only when the relation it names is
  set. The connector now walks the definition at creation across only the edges *something can fire for
  this instance*, and refuses a creation from which no `fulfilled` state is reachable — naming the
  relation that would unlock it. Pure graph reachability; no definition is named anywhere in the code.
- **Four lint rules the previous twenty-five could not express.** `dead-end-state` asks whether *a*
  terminal state is reachable, and a `cancel` from `*` satisfies that for every state — so it could
  essentially never fire. Added: `no-fulfilled-path`, `no-fireable-exit` (nothing at all can leave this
  state), `starts-link-dependent` (a warning: correct, but not startable alone) and
  `unfulfillable-state`. The two transport definitions now warn, correctly.
- **`definitionHash` in the instance genesis.** It pinned `id@version` — a name, not the bytes — so two
  connectors could hold different documents under one ref and each believe the other agreed. Breaking,
  and done while nothing was published.
- **Authoring on the integration surface.** `POST /api/local/v1/definitions/lint` (dry run, stores
  nothing) and `POST /api/local/v1/definitions` behind a new `definitions:write` scope, so a third
  party's UI or a build pipeline can publish exactly as our own UI does. Definitions live in the store;
  the boot directory is a seed. Immutable once published: identical bytes are idempotent, different
  bytes under one `id@version` are a conflict.
- **Adoption, decided once per definition.** A peer's unknown definition is fetched over the peer
  surface that already served it, checked against the hash the genesis pins, and held pending. An
  operator accepts or rejects it in the admin UI, with a **structural diff** against the version they
  last accepted; every later instance under that ref runs without asking. A pending adoption is a
  **wait, not a fault** — the connection stays healthy, nothing is written to the audit log per retry,
  and the line is not dropped.
- **A JSON editor in the process UI** with diagnostics from the connector as you type and the state
  diagram redrawing beside it. The document stays authoritative; the diagram is a projection, which is
  what a canvas editor will mutate later. Editor **layout is stored outside the document**, because the
  hash covers the bytes and dragging a box must not invalidate instances.
- **No domain vocabulary** in the connector, the protocol, the client or either base UI.

**Exit** — met: a process authored in Org A's browser, adopted by Org B's operator, and run to
completion across two containers; 644 unit/contract/scenario tests and 15 Playwright specs; the demo's
dead end is now prevented rather than encountered.

Full design record: [2026-09-04-open-foundation-design.md](superpowers/specs/2026-09-04-open-foundation-design.md).

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
- The demo DIDs use the reserved `.example` TLD (`did:web:org-a.example`), so the scenarios and
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
- **Visual editing of definitions.** M6.5 chose its pieces for it — `toGraph` works from a definition
  with no instance, every diagnostic carries a JSON Pointer so a canvas can highlight the offending
  node, and layout is stored outside the document — but no canvas is built.
- **Migration.** Two halves, and only one is hard. *Completed instances staying readable across
  connector versions* is largely already true: the event log is the record and the materialised
  instance is a cache `rebuild` regenerates from it, so the question is only whether an old event still
  parses. If a schema-version marker is ever wanted for that, it belongs on the **unsigned**
  `StoredEvent` wrapper, where it can be added at any time with no chain break — nothing about
  migration needs to be inside a signed header, so nothing got cheaper by riding along with M6.5's
  `definitionHash` change. *Migrating an in-flight instance to a new definition version* is the hard
  half, and it is a **protocol** question rather than an operational one: `definition` and
  `definitionHash` sit in the immutable genesis, so an instance is pinned to `id@version` for life —
  which is exactly what makes its authority checkable. "Migrate in-flight to 1.1.0" therefore means
  either a successor instance linked to the original, or breaking the invariant the chain's
  trustworthiness rests on. It deserves its own design record.
- **Splitting the audit log from a process-event query.** The audit log currently records both
  `auth.apiKey` denials and successful `transition.apply`. The first is the only record that the thing
  happened; the second duplicates an event already signed, chained and replicated — which is why
  `audit/prune` had to exist at M6, pruning a chain that should have been small. The test is *"is this
  entry the only record that this happened?"*: keep `auth.*` (especially denials), `apiKey.create`,
  `session.create`, `admin.tokenSeed`, `connection.gate`, `chain.verify`, `definition.accept`,
  `definition.reject` and every `denied`/`failed` outcome; drop the successful process traffic. The
  "connector-owned, filterable process log" that motivates this is best built as a **query over the
  events already stored** — cross-instance history filterable by peer, definition, state, transition
  and time — rather than a fourth log. Today `GET /api/local/v1/events` is a live stream only, so the
  gap is history, not records. An index has nothing to keep consistent. M6.5's adoption entries are
  already written against the sharpened rule.
- **Anything that requires a counterparty to run a workflow engine.** A party must always be able to
  integrate with two HTTP calls and one event connection. If that stops being true, the design has
  regressed.
