# Protocol

*The wire specification. Concepts in [ARCHITECTURE.md](ARCHITECTURE.md); the schema for the definition
documents referenced here is in [DEFINITIONS.md](DEFINITIONS.md).*

All paths are relative to a connector's base URL. All bodies are `application/json` unless stated. All
errors are RFC 7807 `application/problem+json`.

## 1. Three surfaces

The auth boundary is visible in the URL. Nothing is accepted across a boundary: a session is never a
bearer token, an API key never authenticates a peer.

| Surface | Prefix | Auth | Callers |
|---|---|---|---|
| **Peer** | `/api/peer/v1/*` | JWS bearer, `did:web`-resolved (§2.1) | other connectors |
| **Integration** | `/api/local/v1/*` | API key + scopes, `X-Actor-Ref` (§2.2) | backoffice, own UI, demo UI's BFF |
| **Admin** | `/api/admin/v1/*` | admin session (§2.3) | the connector's own admin UI |
| — | `/.well-known/did.json` | none | anyone. Static; not a surface. |

**No privileged path.** Our demo process UI is an ordinary API-key client on `/api/local/v1`. Every
capability it has is available to any third-party UI or backoffice on the same terms. If a feature ever
needs a route only our UI can use, that is a design failure, not a shortcut.

## 2. Identity and authentication

### 2.1 Peer — node ↔ node

A participant is identified by a **`did:web` DID**, resolved over ordinary HTTPS. There is nothing to
run: the participant publishes a static document at `https://<domain>/.well-known/did.json` containing
an Ed25519 verification method.

Every cross-connector request carries a short-lived JWS bearer token signed by the calling
participant's key:

```
Authorization: Bearer <compact JWS>

header  { "alg": "EdDSA", "kid": "did:web:acme-shipping.example#key-1", "typ": "JWT" }
claims  { "iss": "did:web:acme-shipping.example",
          "aud": "did:web:vanmoer.example",
          "iat": 1756032842, "exp": 1756033142, "jti": "…" }
```

The receiver resolves `iss`, checks that `kid` belongs to `iss`, checks the signature, checks `aud` is
itself, checks `exp` and `iat` against a small skew allowance, refuses a token whose lifetime exceeds
the ceiling — a year-long "short-lived token" is a password — and rejects a replayed `jti`. The replay
check is **last**, after the signature has proven the token genuine: burning a `jti` on an unverified
token would let anyone invalidate a peer's real tokens by forging copies of them. A `jti` is unique
within its issuer, not globally, so two peers choosing the same random id cannot cancel each other's
calls. Tokens are short-lived and minted per request or
per short window — **nothing expires in the middle of a business process**, because the token
authenticates the call, not the process.

There is no handshake, no negotiation, and no session to establish before a call. The only
prerequisite is an `ACTIVE` connection between the two participants (§3).

Every rejection here is recorded in the application log and the audit log (§6).

### 2.2 Integration — API key + actor reference

An integrator authenticates with a key scoped to one participant:

```
Authorization: ApiKey ak_live_7f3c…
X-Actor-Ref:   alice@acme.example
```

A key record holds `participantId`, a label, the **hashed** secret, scopes, created-by, created-at,
last-used-at, revoked-at and an optional expiry. The secret is displayed once at creation and never
retrievable afterwards. Keys are created and revoked on the admin surface (§5.3).

Scopes, deliberately few:

| Scope | Grants |
|---|---|
| `instances:read` | read instances, read the event log |
| `instances:write` | create instances, apply transitions |
| `events:read` | subscribe to local delivery / the local SSE stream |
| `attachments:read` / `attachments:write` | fetch / upload content-addressed documents |
| `connections:read` | list connections and their status |
| `definitions:read` | read the definition registry and offerings |

Per-definition and per-role scoping is a named later refinement. Flat scopes for the pilot.

**`X-Actor-Ref` is asserted, not proven.** The connector authenticates the *key*, not the person behind
it. The header is an opaque, length-limited string — an email, an internal user id, a service name — and
the connector treats it as an audit hint. It is:

- recorded in the audit log on every call,
- attached to the resulting event as **unsigned local metadata**,
- **never** part of the signed event header, and therefore never replicated to a peer.

That last point is deliberate. Peers do not need your employees' identities, and a signed, replicated
chain cannot be retracted. If individual-level non-repudiation is ever required, it becomes a signed
header field behind an explicit definition flag — a decision to take on purpose, not by default.

The event's `actor` is always the **participant's** DID (§4.1).

### 2.3 Admin — human ↔ admin UI

An ordinary session, issued by Better Auth, scoped to one participant on that connector. It authorises
the admin surface only. It is never accepted by another connector, it is never accepted on
`/api/local/v1` or `/api/peer/v1`, and it never substitutes for a DID signature.

The demo process UI does **not** use this. It owns its own user accounts and holds an API key. The
connector is not an identity provider for anything except its own admin UI — which is what keeps a
third-party-hosted connector from ending up holding your user accounts.

### 2.4 Signing

Signing goes through a `Signer` interface keyed by participant:

```ts
interface Signer {
  did(participantId: string): Promise<string>
  /** The DID URL of the verification method, e.g. `did:web:acme.example#key-1`. */
  keyId(participantId: string): Promise<string>
  /** A raw EdDSA (Ed25519) signature over exactly the bytes given. */
  sign(participantId: string, signingInput: Uint8Array): Promise<Uint8Array>
}
```

The port is deliberately at the level a **remote** signer can implement. A KMS or an HSM offers "sign
these bytes"; it does not offer "produce a compact JWS". Putting JWS assembly behind the port would make
the one implementation we care about impossible to write, so assembly lives in `packages/protocol`
(`crypto/jws.ts`) where it is specified and tested once, whatever holds the key.

The default implementation holds a local Ed25519 key. Remote signers are additional implementations of
this interface. Key management must never sit on the critical path of the state machine.

The connector is the only component that ever holds a key. An integrator never signs anything, which is
why the local API relays (§4.1) rather than letting clients address peers directly.

## 3. Connections

Two participants establish a connection once. Everything else flows over it. **There is no per-request
callback URL.**

### 3.1 Handshake

```
A                                                    B
│  POST /api/peer/v1/connections/requests            │
│  Authorization: Bearer <JWS signed by A>           │
│  { fromDid, fromBaseUrl, displayName,              │
│    delivery: "webhook" | "stream",                 │
│    deliveryUrl?, message? }                        │
├───────────────────────────────────────────────────▶│  202 Accepted
│                                                    │  status PENDING_INBOUND
│                                                    │
│                              (B's operator accepts in the ADMIN UI, or
│                               auto-accepts from a configured allowlist)
│                                                    │
│  POST /api/peer/v1/connections/{id}/accepted       │
│  { delivery, deliveryUrl? }                        │
│◀───────────────────────────────────────────────────┤
│  both sides ACTIVE                                 │
```

Note which surface each call sits on. `POST /api/admin/v1/connections/{id}/accept` is the **local**
call B's admin UI makes to approve; `/api/peer/v1/connections/{id}/accepted` is the **remote** callback
B then makes to A. A rejection is `POST /api/peer/v1/connections/{id}/rejected`.

Accepting or rejecting a connection is an administrative act and is recorded in the audit log with the
admin session that did it.

### 3.2 Connection lifecycle

| State | Meaning |
|---|---|
| `PENDING_INBOUND` | A peer has requested a connection; our operator has not yet decided. |
| `PENDING_OUTBOUND` | We have requested a connection; the peer has not yet decided. |
| `ACTIVE` | Both sides agreed. Processes may flow. **Every instance and transition call requires an `ACTIVE` connection between the caller and the home node.** |
| `DEGRADED` | Active, but peer delivery is failing. Events accumulate and are delivered on recovery or pulled with `?since=`. Not an error state for the business process. |
| `REJECTED` | The peer declined. Terminal; a new request starts a new connection. |
| `REVOKED` | Either side ended it. Existing instances become read-only rather than disappearing — history is not deleted. |

### 3.3 Trust checks on accept

1. Resolve `did:web` from `fromDid`.
2. Confirm the DID document's host matches the origin of `fromBaseUrl`. `did:web` is domain-bound by
   construction, so this proves the caller controls the domain it claims — the same property TLS
   gives you, and enough to build on.
3. Verify the request JWS against a key in that document.
4. Optionally require a verifiable presentation (membership, accreditation, mandate). Not needed for
   the first demo; the hook exists so it can be added without a protocol change.

Demo deployments may seed connections as `ACTIVE` from configuration. The handshake must still work.

### 3.4 Peer delivery

The connection records a delivery channel **per direction**. Both carry the identical signed event
object; only the transport differs.

- **`webhook`** — the home node POSTs a batch of signed events to the peer's registered `deliveryUrl`.
  Retries with exponential backoff; failures park the connection in `DEGRADED` and events are picked
  up on the next successful delivery or by a `?since=` pull. One URL, registered once.
- **`stream`** — the peer holds an SSE connection to `GET /api/peer/v1/stream`. The SSE `id:` field
  carries a global cursor; on reconnect the peer sends `Last-Event-ID` and receives everything it
  missed. A peer using `stream` needs **no inbound endpoint, no DNS entry and no certificate**.

Both are pull-recoverable: `GET /api/peer/v1/instances/{id}/events?since=<seq>` is always
authoritative, and a peer that has missed anything can catch up without operator involvement.

### 3.5 Peer delivery is not local delivery

Do not conflate these:

| | Between | Channels | Declared where |
|---|---|---|---|
| **Peer delivery** (§3.4) | connector ↔ connector | `webhook`, `stream` | on the connection, at handshake |
| **Local delivery** (§4.4) | connector → your own systems | `webhook`, SSE, later `queue` | on a notification subscription, in the admin UI |

A large party's "webhook into the backoffice" is *local* delivery. It has no protocol standing.

## 4. The local API

The surface an integrator actually writes against. It mirrors the resource endpoints and **relays
transparently**.

### 4.1 Relay by `hostedBy`

An integrator calls its **own** connector, always. It never addresses a peer and it never learns which
node hosts what.

```
POST  /api/local/v1/instances
      Authorization: ApiKey …      X-Actor-Ref: alice@acme.example
      { "definition": "container-transport@1.0.0",
        "participants": { "shipper": "did:web:acme…", "transporter": "did:web:vanmoer…" }, … }

  → definition's hostedBy names the ROLE `transporter`
  → participants.transporter = did:web:vanmoer… — not one of ours
  → relay to  vanmoer/api/peer/v1/instances,  signed JWS, ACTIVE connection required
  → return the peer's 201 Created as our own
```

Resolution is **two steps and per request**: the definition names a *role*, only the `participants` map
names the *participant*. If that participant is one of ours the call is served locally with no relay.
Same request, same response shape, either way — `hostedBy` stays an implementation detail of the
connector rather than something every client must understand.

**The same connector does both, for the same definition, concurrently.** Swap `participants` so that
`transporter` is us and this exact call is local. That is not an edge case; it is how a transporter acts
as supplier to a freight forwarder and as consumer to a subcontractor at once
([ARCHITECTURE.md §3.3](ARCHITECTURE.md#33-every-connector-is-both-supplier-and-consumer)). Any
implementation that decides local-vs-remote from the definition alone, or caches it per definition, is
wrong — and would still pass a one-sided demo.

### 4.2 Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/local/v1/connections` | Our connections and their status. **Read-only**: connections are operator state, established on the admin surface (§5.1). |
| `GET` | `/api/local/v1/offerings?peer=<did>` | Browse a peer's offerings. Relayed. |
| `GET` | `/api/local/v1/definitions/{id}@{version}` | A definition plus its content hash. |
| `POST` | `/api/local/v1/instances` | Start a quotation or a service instance. Relayed by `hostedBy`. |
| `GET` | `/api/local/v1/instances` \| `/{id}` | Read, visibility-filtered. `ETag: <seq>`. |
| `POST` | `/api/local/v1/instances/{id}/transitions` | **The one mutating call.** Relayed. |
| `GET` | `/api/local/v1/instances/{id}/events?since=<seq>` | Signed log, visibility-filtered. |
| `GET` | `/api/local/v1/events?since=<cursor>` | SSE across every instance this participant is in. |
| `GET` | `/api/local/v1/notifications?since=<cursor>` | Replay notifications after an outage. Authoritative (§4.4). |
| `POST` \| `GET` | `/api/local/v1/attachments[/{sha256}]` | Content-addressed documents. |

### 4.3 Relay error semantics

A `409`, `422` or `403` from the home node **passes through unchanged** — it is the integrator's
problem to resolve, and rewriting it would only obscure it.

A peer that is unreachable is **not** the same thing and gets its own problem type:

| Status | Problem type | When |
|---|---|---|
| `502` | `urn:pilots:problem:peer-unreachable` | The home node did not answer, or the connection is `DEGRADED`. Retryable. |
| `502` | `urn:pilots:problem:peer-response-invalid` | The peer answered but the response failed verification. Not retryable. |
| `409` | *(pass-through)* | The home node reported a real `seq` conflict. |

Collapsing a network fault into a business conflict would make retry logic on the integrator's side
unwriteable. Every relay failure is recorded in the audit log with the peer DID and the outcome.

### 4.4 Local delivery — notification subscriptions

How a party with **no UI at all** runs processes: its internal systems are told when something needs
doing, and they answer on the local API. This is the path that makes a fully automated participant
possible, so it is specified rather than left as "register a webhook".

A **notification subscription** is admin-configured state, created once and owned by the operator:

```jsonc
{ "id": "sub_7f3c", "participantId": "…", "label": "backoffice-prod",
  "channel": "webhook",
  "target": { "url": "https://backoffice.internal/pilots/hook",
              "headers": { "X-Internal-Route": "weighing" },
              "secretRef": "env:BACKOFFICE_HOOK_SECRET" },
  "notify": ["action.required", "state.changed"],
  "filter": { "definitions": ["container-weighing@1.0.0"],
              "kinds":       ["service"],
              "states":      ["TRUCK_ANNOUNCED", "WEIGHED"],
              "transitions": ["weigh", "recordPayment"] },
  "status": "ACTIVE" }
```

Every `filter` key is optional and they AND together; an absent key matches everything. An empty
`filter` with `notify: ["event"]` is the firehose.

#### Notification types

| Type | Fires when | Why an internal system wants it |
|---|---|---|
| `action.required` | The instance **entered a state** where at least one transition is available to one of our roles | "It is our turn." The one an automated backoffice actually needs. Read this literally: it fires on each state change where something is available, not only on the edge from nothing-available to something-available. Most definitions carry a `cancel` available from `*`, so an edge-triggered version would fire once at creation and never again — and a backoffice would never be told it was time to weigh. A pure data patch does not re-announce a turn that has not moved. |
| `action.cleared` | We are no longer the party who must act | Lets a work queue drain itself instead of growing forever. |
| `state.changed` | Any state change on an instance we participate in | Progress tracking, dashboards, ERP status sync. |
| `event` | Every signed event, state change or not | Mirroring the log. Includes pure data patches. |

`action.required` is computed, not configured: for the instance's current state, the connector asks the
definition which transitions list one of our roles in `by`. Nothing new is declared in a definition to
support it — it falls out of the state machine that already exists, and `packages/protocol` exposes the
same `availableTransitions(definition, instance, roles)` function that the UI uses to render buttons.
One rule, three consumers: notifications, the UI, and the permission check.

#### Envelope

```jsonc
{ "notification": "action.required",
  "subscription": "sub_7f3c",
  "cursor":       "0000000041",
  "at":           "2026-08-26T09:14:02Z",
  "instance":     { "id": "018f2c…", "definition": "container-weighing@1.0.0",
                    "state": "TRUCK_ANNOUNCED", "seq": 4 },
  "available":    [ { "transition": "weigh", "role": "weigher" } ],
  "event":        { "header": { … }, "payload": { … }, "sig": "…" } }
```

The **signed event is carried whole**, so an internal system may verify it independently instead of
trusting its own connector. `available` is what turns a notification into an instruction: the internal
system reads the transition id and posts it straight back to
`POST /api/local/v1/instances/{id}/transitions`. It needs no copy of the definition and no state
machine of its own.

#### Channels

`channel` is a port with one implementation for now:

| Channel | Status | Notes |
|---|---|---|
| `webhook` | **now** | POST the envelope (batched) to `target.url`. `X-Pilots-Signature` carries an HMAC over the body using the shared secret, so the internal system can authenticate the caller across its own network. |
| `sse` | now | Hold `GET /api/local/v1/events?since=<cursor>`, filtered by the same subscription. For an internal system that cannot accept inbound connections either. |
| `queue` | **later** | SQS / AMQP / Pub-Sub. Deliberately deferred — the subscription model above does not change when it arrives, only the adapter does. |

Adding a queue adapter must not require touching subscriptions, notification types or the envelope. If
it does, this model is wrong.

#### Delivery guarantees

- **At-least-once, ordered per instance.** An internal system must tolerate a duplicate; the
  `Idempotency-Key` it sends on the resulting transition is what makes that safe end to end.
- **Retry with exponential backoff**, then park the subscription in `DEGRADED` and dead-letter.
- **Replay from a cursor.** `GET /api/local/v1/notifications?since=<cursor>` is authoritative, so a
  backoffice that was down catches up without operator involvement — the same recovery shape as peer
  delivery.
- **Visibility-filtered** exactly as a read would be. A notification never carries a field its
  recipient could not have read from `GET /instances/{id}`.
- Every delivery failure is audited (`delivery.fail`) and logged.

### 4.5 Offerings and symmetry

`GET /api/local/v1/offerings?peer=<did>` browses what a peer provides; the participant's own offerings
are managed on the admin surface (§5.1). There is no flag anywhere that marks a connector as a supplier
or a consumer:

- **Publishing an offering** makes this participant a supplier. It is a store record created at runtime.
- **Consuming a peer's offering** makes it a consumer, in that instance.
- Both at once is the normal case. One `ACTIVE` connection carries traffic in both directions and for
  either side's offerings; there is no "supplier connection".
- `action.required` (§4.4) is computed from *our roles in that instance*, so it fires correctly whether we
  are provider or requester, with no extra configuration.

## 5. The admin API

The minimal surface for operating your own connector. Everything here is an administrative act and
everything here is audited.

### 5.1 What it covers

| Area | Operations |
|---|---|
| API keys | create (secret shown once), list, revoke |
| Connections | list, accept, reject, revoke; manage the auto-accept allowlist |
| Notification subscriptions | create / update / pause / delete; view `DEGRADED` status, dead letters, and replay from a cursor (§4.4) |
| **Offerings** | publish / update / withdraw. **This is what makes this participant a supplier** — a runtime act, not configuration (§4.5). |
| Definitions | list the registry, register a definition, view content hashes |
| Participants | view; signer configuration |
| Audit log | read and filter (§6.2) |

### 5.2 What it deliberately does not cover

Starting processes, applying transitions, or reading business data. Those are the local API's job, and
routing them through the admin surface would create exactly the privileged path §1 forbids. The admin
UI is for managing the connector, not for running processes.

### 5.3 Key creation

```jsonc
// POST /api/admin/v1/apikeys      (admin session)
{ "label": "backoffice-prod", "scopes": ["instances:read", "instances:write", "events:read"] }

// 201 Created — the ONLY time the secret is returned
{ "id": "ak_7f3c", "secret": "ak_live_7f3c…", "scopes": [ … ], "createdAt": "…" }
```

Audited as `apiKey.create`, with the admin session that did it.

## 6. Logging and audit

Three records, three jobs. See [ARCHITECTURE.md §6](ARCHITECTURE.md#6-the-three-logs).

### 6.1 Application log

Structured JSON to stdout, shaped for an ordinary log sink (CloudWatch and friends). It **must** record
every rejected authentication, every authorisation failure, and every attempt to change something the
caller was not entitled to change — the class of event that by definition produces no business event.

The logger carries an `audit` flag so one call site can reach both destinations:

```ts
log.warn({ audit: { action: 'transition.apply', outcome: 'denied',
                    subject: { instance } },
           problem: 'urn:pilots:problem:role-not-permitted' },
         'transition refused')
```

Which entries carry `audit` is a deliberate per-call-site choice, not a level threshold.

### 6.2 Audit log

Append-only, **locally hash-chained**, unsigned, and **never replicated**.

```jsonc
{ "seq": 41, "at": "2026-08-26T09:14:02Z", "participantId": "…",
  "category": "admin" | "local" | "peer",
  "action":  "apiKey.create" | "connection.accept" | "instance.create" |
             "transition.apply" | "chain.verify" | "delivery.fail" | …,
  "actor":   { "kind": "adminSession" | "apiKey" | "peer" | "runtime",
               "id": "…", "actorRef": "alice@acme.example" },
  "subject": { "instance": "018f2c…" },
  "outcome": "ok" | "denied" | "failed",
  "problem": "urn:pilots:problem:…",
  "request": { "method": "POST", "path": "…", "ip": "…", "jti": "…" },
  "prev":    "sha256:…" }
```

- `prev` is `sha256` of the JCS-canonicalised previous entry. Same primitives as the event chain, so
  this costs nothing new and gives tamper evidence on your own administrative trail with no key
  ceremony.
- **Mutations and denials are always recorded.** Read-auditing is configurable and defaults to denials
  only, or the log drowns in `GET`s.
- Retention is configurable. Entries never leave the connector.

Always audited: every admin action, every mutating local call, every inbound peer call, every JWS
verification failure, every chain verification failure, every delivery failure, and every `4xx` that
represents a refusal.

## 7. Events

### 7.1 Format

```jsonc
{ "header": {
    "instance":    "018f2c…",
    "seq":         4,
    "transition":  "quote",
    "actor":       "did:web:vanmoer.example",
    "from":        "REQUESTED",
    "to":          "OFFERED",
    "at":          "2026-08-24T09:14:02.000Z",
    "prev":        "sha256:9f3c…",
    "payloadHash": "sha256:1a7b…",
    "genesis":     "sha256:c40e…",
    "attachments": [ { "sha256": "…", "mime": "application/pdf", "size": 41022 } ]
  },
  "payload":  { "price": { "value": 320, "currency": "EUR" } },
  "redacted": false,
  "sig": "<detached compact JWS over the canonicalised header>"
}
```

- **Every header field is always present.** Optionality is expressed as `null`, never by omitting a key.
  The header is canonicalised and hashed, so "did you include the key?" would be a cross-implementation
  disagreement waiting to happen. `attachments` is `[]` when there are none.
- `seq` starts at 1 and increases by 1 per instance. Assigned by the home node.
- **`seq` 1 is the instance's creation**, recorded with the reserved transition id `create`, `from: null`
  and `to` equal to the definition's `initialState`, carrying the initial `data` as its payload. Without
  it the log could not reconstruct the instance it describes, and a replica could not rebuild anything.
- `prev` is `sha256` of the canonicalised **header** of event `seq - 1`; `null` for `seq == 1`.
- `payloadHash` is `sha256` of the canonicalised payload, or of the empty object `{}` when there is none.
- `genesis` is `sha256` of the canonicalised **instance genesis** — `{ kind, definition, participants,
  quotationId, offering }`, the fields fixed at creation and never changed afterwards.

  It is on **every** event, not only the first, and its value is identical across an instance's whole
  log. It exists because `definition` and `participants` are exactly what authority is judged
  against — step 2 below checks the actor's role, and a role means nothing without the map that
  assigns it. Those fields do not live in the log, so they travel alongside it, and without `genesis`
  a replica would have to take the sender's word for them. A home node could then hand over a
  perfectly signed, perfectly chained history together with a participants map naming somebody who
  was never in the instance, and "the host cannot lie" would hold for every field except the two that
  decide who is allowed to do what. Putting it on every event means an incremental delivery binds
  identity too, rather than only a full replay from `seq` 1.
- `to` is `null` for a pure data patch — a transition may change state, patch data, or do both.
- `at` is UTC, always `Z`. A canonical record with local offsets in it is one two implementations can
  disagree about.
- `sig` is a **detached** compact JWS (RFC 7515 Appendix F): `<protected>..<signature>`, with the payload
  left out because the event already carries the header. A second, base64url copy of the header inside
  the signature is a copy that could disagree with the first. The protected header is
  `{ "alg": "EdDSA", "kid": "<the actor's DID URL>" }`.
- `redacted` sits on the envelope, **outside** the signed header, and is `true` when the visibility
  filter withheld payload fields from this copy (§7.3). It is a statement about *this copy*, not about
  what happened, which is exactly why it is not signed.
- `actor` is the **participant's** DID. The `X-Actor-Ref` of the caller who caused it is stored locally
  alongside the event and in the audit log; it is not in the header and not replicated.

### 7.2 Canonicalisation

**JCS, RFC 8785**, applied before every hash and every signature. Use the `canonicalize` package. Do
not hand-roll key ordering. An implementation that skips this appears to work perfectly until a second
implementation exists.

### 7.3 Verification

On receiving events for an instance, a peer must:

1. Verify `sig` over the canonicalised header, using a key from the resolved DID document of `actor`.
2. Check `genesis` equals the hash of the instance metadata it was given, and that every event in the
   log carries the same value. Without this, step 3 checks authority against a map the sender chose.
3. Check `actor` holds a role in the instance permitted by the definition to make `transition`.
4. Check `prev` equals the hash of the header it already holds at `seq - 1`.
5. Check `from` matches the state it computed after `seq - 1`.
6. If the payload is present, check `payloadHash` matches it.

A peer that re-presents an event for a `seq` it has already been given must present it **unchanged**:
same header, and any payload still hashing to `payloadHash`. Treating a re-sent event as a harmless
duplicate without checking it is the quietest possible way to miss a rewritten history.

A failure at step 2, 4 or 5 means the host has rewritten history. It is a hard error: surface it, audit it
as `chain.verify` / `failed`, do not retry, do not silently resync.

**A released field is re-sent, and only then.** Visibility is state-dependent: `grossMass` is withheld
from the shipper at `WEIGHED` and granted at `PAID`. Within one connector that is only a filter, and
the same stored event reads differently before and after. **Across connectors it cannot be** — the
peer was never sent the bytes, and no amount of re-filtering conjures them. So when a state change
releases a field, the home node sends the now-visible payload alongside the event that released it.
The receiver accepts it **only** because it hashes to the `payloadHash` its already-verified header
commits to, so this can complete a redacted event and can never replace one. Header, signature and
chain are untouched.

**Redacted payloads are not verification failures.** When visibility rules withhold fields, the payload
arrives partial or absent and the envelope's `redacted` flag is `true`; a verifier then skips step 5 for
that event. (A payload withheld *entirely* is `null` rather than `{}`, so it stays detectable without the flag:
`payload` is `null` while `payloadHash` is not the hash of `{}`.) The header still verifies, the chain still verifies, and the
**state** the instance folds to is still exact, because state folds from headers alone. Only the withheld
values are unknown — which is the intent.

### 7.4 Attachments

Documents are content-addressed. The event header lists `{ sha256, mime, size }`; the bytes are fetched
from `/attachments/{sha256}` on either surface, subject to the same visibility rules. This keeps the log
small, makes documents deduplicated and tamper-evident, and avoids base64 in the event stream.

## 8. Concurrency and idempotency

Three separate mechanisms for three separate problems:

| Problem | Mechanism |
|---|---|
| Two parties act on the same instance at once | `If-Match: <seq>` on the transition call. Mismatch → `409 Conflict` with the current `seq`. Missing → `428 Precondition Required`. |
| The host rewrote history | `prev` hash chain + per-event signature (§7.3). |
| A client retried after a timeout | `Idempotency-Key: <uuid>` header. A repeat with the same key returns the original result rather than applying the transition twice. |

`ETag` on instance reads carries the current `seq`. Both are honoured identically on the peer and local
surfaces; the local surface forwards them across a relay.

Appending the event and updating the materialised instance is **one atomic store operation**
([ARCHITECTURE.md §7.1](ARCHITECTURE.md#71-the-port-is-shaped-by-two-operations)). `Idempotency-Key`
claims require a real unique constraint. These two contracts are why the repository is a port with a
conformance suite rather than an ad-hoc data-access layer.

## 9. Peer endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/.well-known/did.json` | Static DID document. No auth. |
| `GET` | `/api/peer/v1/offerings` | What this participant offers, with the quotation definition that applies to each. |
| `GET` | `/api/peer/v1/definitions/{id}@{version}` | A definition plus its content hash. |
| `POST` | `/api/peer/v1/connections/requests` | Inbound connection request from a peer. |
| `POST` | `/api/peer/v1/connections/{id}/accepted` \| `/rejected` | Remote: peer reports the outcome. |
| `POST` | `/api/peer/v1/deliveries` | A batch of signed events pushed by a home node. The `webhook` channel's endpoint (§3.4). |
| `POST` | `/api/peer/v1/instances` | Start a quotation or a service instance. |
| `GET` | `/api/peer/v1/instances` \| `/{id}` | Read, visibility-filtered. `ETag: <seq>`. |
| `POST` | `/api/peer/v1/instances/{id}/transitions` | **The one mutating call.** |
| `GET` | `/api/peer/v1/instances/{id}/events?since=<seq>` | Signed log, visibility-filtered. |
| `GET` | `/api/peer/v1/stream?since=<cursor>` | SSE across every instance the caller participates in. |
| `GET` | `/api/peer/v1/attachments/{sha256}` | Content-addressed document bytes. |

### 9.1 Who signs, and what a peer call carries

The **participant that acted signs**, never the home node on its behalf. §7.1 says the protected
header's `kid` is the actor's DID URL and §7.3 step 1 says the verifying key comes from the actor's
DID document; a home node cannot produce that signature, and if it could, it could invent the other
party's moves.

So the two surfaces carry different bodies for the same operation, and only the **local** one is the
integrator-facing shape:

- On `/api/local/v1`, a client sends `{ transition, patch, attachments }` with `If-Match`. Its own
  connector evaluates the move, builds the header and signs it.
- On `/api/peer/v1`, the body is `{ instance, event }` — the instance's identity (§7.1's `genesis`
  fields plus `id` and `createdAt`) and the complete signed event.

The caller can build that header because **`If-Match` already tells it everything it needs**: it holds
a verified replica, so `If-Match: 3` means the next event is `seq` 4 and its `prev` is the hash of the
header it holds at 3. If it guessed wrong the home node answers `409` with the real `seq`. That is why
`If-Match` is mandatory rather than advisory.

The home node still checks everything — connection, role, `from` state, both schemas, guards, `seq`,
`prev`, `genesis` and the signature. What it cannot do is forge the caller's half.

Runtime-fired transitions (`auto`, and later `links` and deadlines) have `by: []` and are signed by
the **home node**, because the runtime that fired them is the home node.

### 9.2 `POST /instances`

```jsonc
// local surface — what an integrator sends. Relayed by hostedBy (§4.1).
{ "definition": "container-transport-quotation@1.0.0",
  "participants": { "shipper": "did:web:acme-shipping.example",
                    "transporter": "did:web:vanmoer.example" },
  "offering": "urn:offering:vanmoer:container-transport",
  "data": { "pickup": { … }, "dropoff": { … }, "window": { … } } }

// 201 Created, Location: …/instances/018f2b…, ETag: "1"

// peer surface — what the relay sends on. The creating event is already signed.
{ "instance": { "id": "018f2b…", "kind": "quotation", "definition": "…",
                "participants": { … }, "quotationId": null, "offering": "…",
                "createdAt": "2026-08-24T09:00:00.000Z" },
  "event":    { "header": { … }, "payload": { … }, "redacted": false, "sig": "…" } }

// 201 Created — the body is a delivery: the events, as the caller may see them
```

A successful peer write answers with the events it accepted, filtered for the caller, in the same
shape a delivery uses. The caller converges by **replicating its own reply** — through the ordinary
verifying path, because its own call succeeding is not a reason to skip checking what came back.

Rejected with `422` if the caller's DID is not among `participants`, if the definition forbids the
caller's role from creating an instance, or if `data` fails the definition's `data` schema.

If the referenced offering carries a **standing** quotation, the node creates the quotation instance
and immediately auto-fires its initial transition, so it is returned already in `AGREED`. Same code
path as a negotiated quotation — the definition differs, the runtime does not.

### 9.3 `POST /instances/{id}/transitions`

```jsonc
// local surface — If-Match: "3"   Idempotency-Key: <uuid>
{ "transition": "quote",
  "patch": { "price": { "value": 320, "currency": "EUR" } },
  "attachments": [ { "sha256": "…", "mime": "application/pdf", "size": 41022 } ] }

// 200 OK, ETag: "4"  → the resulting signed event and the new instance state
```

`200`, not `201`: a transition advances an instance, it does not create a resource.

The home node checks, in order: the connection is `ACTIVE`; the event's `genesis` matches the instance
it names; the signature verifies against the actor's published key and the actor is the authenticated
caller; `seq` and `prev` continue the log it holds; the caller holds a role listed in the transition's
`by`; the instance's current state is in the transition's `from`; the patch validates against the
transition's `patch` schema and the resulting data document validates against the definition's `data`
schema; any `guards` hold. Then it appends the event and the materialised instance atomically, writes
the audit entry, evaluates `links`, and delivers to peers and to local delivery targets.

Any check that fails produces an audit entry with `outcome: "denied"` and no event.

`patch` is **JSON Merge Patch (RFC 7386)** against the instance's `data` document. `null` deletes a key.

### 9.4 Errors

RFC 7807 throughout, on all three surfaces.

| Status | When |
|---|---|
| `401` | Missing, malformed, expired or unverifiable credential — bearer JWS, API key, or session. |
| `403` | Authenticated, but: not a participant in this instance; role not permitted this transition; connection not `ACTIVE`; or the API key lacks the required scope. |
| `404` | Unknown instance, or one the caller may not see. Do not distinguish the two. |
| `409` | `If-Match` does not equal the current `seq`. Body carries the current `seq`. |
| `422` | Schema validation failure, illegal `from` state, unknown transition, failed guard. Body lists the individual errors. |
| `428` | `If-Match` absent on a mutating call. |
| `502` | Relay only: peer unreachable or peer response invalid (§4.3). |

## 10. What an integrator actually does

1. Get an API key from the admin UI (or from their hosting provider).
2. `POST /api/local/v1/instances` to start something.
3. `POST /api/local/v1/instances/{id}/transitions` to make each move.
4. Receive notifications — register one subscription, or hold the local SSE stream.

A **fully automated** party does only steps 1 and 4, plus step 3 in response: subscribe to
`action.required`, and when one arrives, post the transition id it names straight back. No UI, no polling,
no copy of the definition, no state machine of its own.

That is the whole list, and note what is absent: no DID to publish, no key to manage, no peer address to
resolve, no catalog, no token lifecycle, no knowledge of who hosts what. Publishing a `did.json` and
accepting connections are one-time **operator** tasks on the admin surface, not integration work.

If this list grows, something has gone wrong.

## 11. Deferred: a `public` view-only surface

Recorded so it is a choice rather than an omission. Not scheduled — see [ROADMAP.md](ROADMAP.md).

A party involved in a process but not running a connector should be able to watch it progress. The
shape: a long-lived, view-only token embedded in a URL, resolving to a filtered read of a single
instance, on a fourth `/api/public/v1/*` surface. It reuses the existing visibility filter, so the hard
part is already built in M1. What needs deciding when it is picked up: token issuance and revocation,
which role the viewer is filtered as, and whether the token grants event history or current state only.
