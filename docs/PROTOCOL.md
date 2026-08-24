# Protocol

*The wire specification. Concepts in [ARCHITECTURE.md](ARCHITECTURE.md); the schema for the definition
documents referenced here is in [DEFINITIONS.md](DEFINITIONS.md).*

All paths are relative to a participant's node base URL. All bodies are `application/json` unless
stated. All errors are RFC 7807 `application/problem+json`.

## 1. Identity and authentication

Two layers. Keep them apart.

### 1.1 Node ↔ node

A participant is identified by a **`did:web` DID**, resolved over ordinary HTTPS. There is nothing to
run: the participant publishes a static document at `https://<domain>/.well-known/did.json` containing
an Ed25519 verification method.

Every cross-node request carries a short-lived JWS bearer token signed by the calling participant's
key:

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
prerequisite is an `ACTIVE` connection between the two participants (§2).

### 1.2 Human ↔ UI

An ordinary session, issued by Better Auth, scoped to one participant on that node. It authorises use
of *this* node's UI and API. It is never accepted by another node, and it never substitutes for a DID
signature. A person acting through the UI causes the node to sign an event with the **participant's**
key; the person's identity is recorded as metadata on the event, not as its signer.

### 1.3 Signing

Signing goes through a `Signer` interface keyed by participant:

```ts
interface Signer {
  did(participantId: string): Promise<string>
  sign(participantId: string, payload: Uint8Array): Promise<string>  // compact JWS
}
```

The default implementation holds a local Ed25519 key. Remote signers are additional implementations
of this interface. Key management must never sit on the critical path of the state machine.

## 2. Connections

Two participants establish a connection once. Everything else flows over it. **There is no per-request
callback URL.**

### 2.1 Handshake

```
A                                                    B
│  POST /api/v1/connections/requests                 │
│  Authorization: Bearer <JWS signed by A>           │
│  { fromDid, fromBaseUrl, displayName,              │
│    delivery: "webhook" | "stream",                 │
│    deliveryUrl?, message? }                        │
├───────────────────────────────────────────────────▶│  202 Accepted
│                                                    │  status PENDING_INBOUND
│                                                    │
│                              (B's operator accepts in the UI, or
│                               auto-accepts from an allowlist)
│                                                    │
│  POST /api/v1/connections/{id}/accepted            │
│  { delivery, deliveryUrl? }                        │
│◀───────────────────────────────────────────────────┤
│  both sides ACTIVE                                 │
```

`POST /api/v1/connections/{id}/accept` is the **local** call B's UI makes to approve; `/accepted` is
the **remote** callback B then makes to A. A rejection is `POST /api/v1/connections/{id}/rejected`.

### 2.2 Connection lifecycle

| State | Meaning |
|---|---|
| `PENDING_INBOUND` | A peer has requested a connection; our operator has not yet decided. |
| `PENDING_OUTBOUND` | We have requested a connection; the peer has not yet decided. |
| `ACTIVE` | Both sides agreed. Processes may flow. **Every instance and transition call requires an `ACTIVE` connection between the caller and the home node.** |
| `DEGRADED` | Active, but delivery is failing (webhook unreachable, stream repeatedly dropping). Events accumulate and are delivered on recovery or pulled with `?since=`. Not an error state for the business process. |
| `REJECTED` | The peer declined. Terminal; a new request starts a new connection. |
| `REVOKED` | Either side ended it. Existing instances become read-only rather than disappearing — history is not deleted. |

### 2.3 Trust checks on accept

1. Resolve `did:web` from `fromDid`.
2. Confirm the DID document's host matches the origin of `fromBaseUrl`. `did:web` is domain-bound by
   construction, so this proves the caller controls the domain it claims — the same property TLS
   gives you, and enough to build on.
3. Verify the request JWS against a key in that document.
4. Optionally require a verifiable presentation (membership, accreditation, mandate). Not needed for
   the first demo; the hook exists so it can be added without a protocol change.

Demo deployments may seed connections as `ACTIVE` from configuration. The handshake must still work.

### 2.4 Delivery

The connection records a delivery channel **per direction**. Both carry the identical signed event
object; only the transport differs.

- **`webhook`** — the home node POSTs a batch of signed events to the peer's registered `deliveryUrl`.
  Retries with exponential backoff; failures park the connection in `DEGRADED` and events are picked
  up on the next successful delivery or by a `?since=` pull. One URL, registered once.
- **`stream`** — the peer holds an SSE connection to `GET /api/v1/stream`. The SSE `id:` field carries
  a global cursor; on reconnect the peer sends `Last-Event-ID` and receives everything it missed. A
  peer using `stream` needs **no inbound endpoint, no DNS entry and no certificate**.

Both are pull-recoverable: `GET /api/v1/instances/{id}/events?since=<seq>` is always authoritative,
and a peer that has missed anything can catch up without operator involvement.

## 3. Events

### 3.1 Format

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

### 3.2 Canonicalisation

**JCS, RFC 8785**, applied before every hash and every signature. Use the `canonicalize` package. Do
not hand-roll key ordering. An implementation that skips this appears to work perfectly until a second
implementation exists.

### 3.3 Verification

On receiving events for an instance, a peer must:

1. Verify `sig` over the canonicalised header, using a key from the resolved DID document of `actor`.
2. Check `actor` holds a role in the instance permitted by the definition to make `transition`.
3. Check `prev` equals the hash of the header it already holds at `seq - 1`.
4. Check `from` matches the state it computed after `seq - 1`.
5. If the payload is present, check `payloadHash` matches it.

A failure at step 3 or 4 means the host has rewritten history. It is a hard error: surface it, do not
retry, do not silently resync.

**Redacted payloads are not verification failures.** When visibility rules withhold fields, the payload
arrives partial or absent. The header still verifies, the chain still verifies, and the instance's
visible state is still exact. Only the withheld values are unknown — which is the intent.

### 3.4 Attachments

Documents are content-addressed. The event header lists `{ sha256, mime, size }`; the bytes are fetched
from `GET /api/v1/attachments/{sha256}`, subject to the same visibility rules. This keeps the log small,
makes documents deduplicated and tamper-evident, and avoids base64 in the event stream.

## 4. Concurrency and idempotency

Three separate mechanisms for three separate problems:

| Problem | Mechanism |
|---|---|
| Two parties act on the same instance at once | `If-Match: <seq>` on the transition call. Mismatch → `409 Conflict` with the current `seq`. Missing → `428 Precondition Required`. |
| The host rewrote history | `prev` hash chain + per-event signature (§3.3). |
| A client retried after a timeout | `Idempotency-Key: <uuid>` header. A repeat with the same key returns the original result rather than applying the transition twice. |

`ETag` on instance reads carries the current `seq`.

## 5. Endpoints

Eleven, of which an integrator meets four: create an instance, make a transition, read the instance,
receive events.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/.well-known/did.json` | Static DID document. No auth. |
| `GET` | `/api/v1/offerings` | What this participant offers, with the quotation definition that applies to each. |
| `GET` | `/api/v1/definitions/{id}@{version}` | A definition plus its content hash. |
| `POST` | `/api/v1/connections/requests` | Inbound connection request from a peer. |
| `POST` | `/api/v1/connections/{id}/accept` | Local: operator approves a pending request. |
| `POST` | `/api/v1/connections/{id}/accepted` \| `/rejected` | Remote: peer reports the outcome. |
| `POST` | `/api/v1/instances` | Start a quotation or a service instance. |
| `GET` | `/api/v1/instances` \| `/api/v1/instances/{id}` | Read, visibility-filtered. `ETag: <seq>`. |
| `POST` | `/api/v1/instances/{id}/transitions` | **The one mutating call.** |
| `GET` | `/api/v1/instances/{id}/events?since=<seq>` | Signed log, visibility-filtered. |
| `GET` | `/api/v1/stream?since=<cursor>` | SSE across every instance the caller participates in. |
| `GET` | `/api/v1/attachments/{sha256}` | Content-addressed document bytes. |

### 5.1 `POST /api/v1/instances`

```jsonc
// request
{ "definition": "container-transport-quotation@1.0.0",
  "participants": { "shipper": "did:web:acme-shipping.example",
                    "transporter": "did:web:vanmoer.example" },
  "offering": "urn:offering:vanmoer:container-transport",
  "data": { "pickup": { … }, "dropoff": { … }, "window": { … } } }

// 201 Created, Location: /api/v1/instances/018f2b…, ETag: "1"
```

Rejected with `422` if the caller's DID is not among `participants`, if the definition forbids the
caller's role from creating an instance, or if `data` fails the definition's `data` schema.

If the referenced offering carries a **standing** quotation, the node creates the quotation instance
and immediately auto-fires its initial transition, so it is returned already in `AGREED`. Same code
path as a negotiated quotation — the definition differs, the runtime does not.

### 5.2 `POST /api/v1/instances/{id}/transitions`

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
definition's `data` schema; any `guards` hold. Then it assigns `seq`, builds the header, signs, appends,
updates the materialised instance, evaluates `links`, and delivers to peers.

`patch` is **JSON Merge Patch (RFC 7386)** against the instance's `data` document. `null` deletes a key.

### 5.3 Errors

RFC 7807 throughout.

| Status | When |
|---|---|
| `401` | Missing, malformed, expired or unverifiable bearer JWS. |
| `403` | Authenticated, but not a participant in this instance, or role not permitted this transition, or connection not `ACTIVE`. |
| `404` | Unknown instance, or one the caller may not see. Do not distinguish the two. |
| `409` | `If-Match` does not equal the current `seq`. Body carries the current `seq`. |
| `422` | Schema validation failure, illegal `from` state, unknown transition, failed guard. Body lists the individual errors. |
| `428` | `If-Match` absent on a mutating call. |

## 6. What an integrator actually does

1. Publish a `did.json` at their domain.
2. Accept one connection request.
3. `POST /api/v1/instances` to start something.
4. `POST /api/v1/instances/{id}/transitions` to make each move.
5. Receive events — hold an SSE connection, or register one webhook URL.

No catalog, no negotiation handshake, no transfer setup, no token lifecycle to manage. If this list
grows, something has gone wrong.
