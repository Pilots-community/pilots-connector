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

The receiver resolves `iss`, checks the signature against the key named by `kid`, checks `aud` is
itself, checks `exp`, and rejects a replayed `jti`. Tokens are short-lived and minted per request or
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
  sign(participantId: string, payload: Uint8Array): Promise<string>  // compact JWS
}
```

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
| `GET` | `/api/local/v1/connections` | Our connections and their status. |
| `POST` | `/api/local/v1/connections` | Initiate an outbound connection request. |
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
| `action.required` | The instance entered a state where **at least one transition is available to one of our roles** | "It is our turn." The one an automated backoffice actually needs. |
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
    "at":          "2026-08-24T09:14:02Z",
    "prev":        "sha256:9f3c…",
    "payloadHash": "sha256:1a7b…",
    "attachments": [ { "sha256": "…", "mime": "application/pdf", "size": 41022 } ]
  },
  "payload": { "price": { "value": 320, "currency": "EUR" } },
  "sig": "<compact JWS over the canonicalised header>"
}
```

- `seq` starts at 1 and increases by 1 per instance. Assigned by the home node.
- `prev` is `sha256` of the canonicalised **header** of event `seq - 1`; `null` for `seq == 1`.
- `payloadHash` is `sha256` of the canonicalised payload, or of the empty object when there is none.
- `to` and `payload` are both optional — a transition may change state, patch data, or do both.
- `actor` is the **participant's** DID. The `X-Actor-Ref` of the caller who caused it is stored locally
  alongside the event and in the audit log; it is not in the header and not replicated.

### 7.2 Canonicalisation

**JCS, RFC 8785**, applied before every hash and every signature. Use the `canonicalize` package. Do
not hand-roll key ordering. An implementation that skips this appears to work perfectly until a second
implementation exists.

### 7.3 Verification

On receiving events for an instance, a peer must:

1. Verify `sig` over the canonicalised header, using a key from the resolved DID document of `actor`.
2. Check `actor` holds a role in the instance permitted by the definition to make `transition`.
3. Check `prev` equals the hash of the header it already holds at `seq - 1`.
4. Check `from` matches the state it computed after `seq - 1`.
5. If the payload is present, check `payloadHash` matches it.

A failure at step 3 or 4 means the host has rewritten history. It is a hard error: surface it, audit it
as `chain.verify` / `failed`, do not retry, do not silently resync.

**Redacted payloads are not verification failures.** When visibility rules withhold fields, the payload
arrives partial or absent. The header still verifies, the chain still verifies, and the instance's
visible state is still exact. Only the withheld values are unknown — which is the intent.

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
| `POST` | `/api/peer/v1/instances` | Start a quotation or a service instance. |
| `GET` | `/api/peer/v1/instances` \| `/{id}` | Read, visibility-filtered. `ETag: <seq>`. |
| `POST` | `/api/peer/v1/instances/{id}/transitions` | **The one mutating call.** |
| `GET` | `/api/peer/v1/instances/{id}/events?since=<seq>` | Signed log, visibility-filtered. |
| `GET` | `/api/peer/v1/stream?since=<cursor>` | SSE across every instance the caller participates in. |
| `GET` | `/api/peer/v1/attachments/{sha256}` | Content-addressed document bytes. |

### 9.1 `POST /instances`

Identical body on both surfaces. On the local surface it may be relayed (§4.1).

```jsonc
// request
{ "definition": "container-transport-quotation@1.0.0",
  "participants": { "shipper": "did:web:acme-shipping.example",
                    "transporter": "did:web:vanmoer.example" },
  "offering": "urn:offering:vanmoer:container-transport",
  "data": { "pickup": { … }, "dropoff": { … }, "window": { … } } }

// 201 Created, Location: …/instances/018f2b…, ETag: "1"
```

Rejected with `422` if the caller's DID is not among `participants`, if the definition forbids the
caller's role from creating an instance, or if `data` fails the definition's `data` schema.

If the referenced offering carries a **standing** quotation, the node creates the quotation instance
and immediately auto-fires its initial transition, so it is returned already in `AGREED`. Same code
path as a negotiated quotation — the definition differs, the runtime does not.

### 9.2 `POST /instances/{id}/transitions`

```jsonc
// request  — If-Match: "3"   Idempotency-Key: <uuid>
{ "transition": "quote",
  "patch": { "price": { "value": 320, "currency": "EUR" } },
  "attachments": [ { "sha256": "…", "mime": "application/pdf", "size": 41022 } ] }

// 200 OK, ETag: "4"  → the resulting signed event and the new instance state
```

The home node checks, in order: the connection is `ACTIVE`; the caller holds a role listed in the
transition's `by`; the instance's current state is in the transition's `from`; the patch validates
against the transition's `patch` schema and the resulting data document validates against the
definition's `data` schema; any `guards` hold. Then it assigns `seq`, builds the header, signs, appends
the event and the materialised instance atomically, writes the audit entry, evaluates `links`, and
delivers to peers and to local delivery targets.

Any check that fails produces an audit entry with `outcome: "denied"` and no event.

`patch` is **JSON Merge Patch (RFC 7386)** against the instance's `data` document. `null` deletes a key.

### 9.3 Errors

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
