# Architecture

*Authoritative. Supersedes [IDEA.md](IDEA.md). Standing rules in [../AGENT.md](../AGENT.md).*

## 1. The idea in one paragraph

A shared business process is described **once**, as a declarative definition that names roles, states,
transitions and who may make each move. A running process is **one authoritative instance**, hosted by
the party the definition designates, advanced only through signed transitions, and reconstructible
from a hash-chained event log that every participant replicates and verifies. Each party runs the same
node software; how they drive it — a person clicking, or a backoffice reacting to a webhook — is their
own business.

## 2. Terminology

| Term | Meaning |
|---|---|
| **Node** | The software. Everybody runs the same one. |
| **Participant** | A legal entity with a DID. Lives on a node; a node may host several. |
| **Connection** | A verified, persistent, bidirectional relationship between two participants. Established once, before any process runs. |
| **Definition** | A process description: roles, states, transitions, data schema, visibility, links. |
| **Instance** | A running process. `kind` is `quotation` or `service`. |
| **Home node** | The node of the participant holding the role named in the definition's `hostedBy`. Stores the authoritative instance. |
| **Peer node** | Every other participant's node. Holds a verified replica. |
| **`requester` / `provider`** | The two generic protocol roles. Business roles (`shipper`, `weigher`, `transporter`, `terminal`) come from the definition. |

Deliberately **not** used as protocol terms: *consumer/producer* (collides with messaging),
*customer/supplier* (fine as UI labels, too narrow for three-party processes).

## 3. Runtime shape

```
  Party A — small                                Party B — large
  ┌────────────────────────────┐                 ┌────────────────────────────┐
  │ node  (1 container)        │                 │ node  (1 container)        │
  │  · serves its own UI       │ ──── HTTPS ───▶ │  · serves its own UI       │
  │  · SQLite                  │  signed JWS     │  · Postgres                │
  │  · local Ed25519 key       │                 │  · signer plugin           │
  │  · verified event replica  │ ◀─── events ─── │  · webhook → backoffice    │
  │  · no inbound endpoint     │   over the      │  · public HTTPS endpoint   │
  └────────────────────────────┘   Connection    └────────────────────────────┘
```

Two containers for the whole two-party demo. Same image, two configuration files. That difference —
and only that difference — is what separates the haulier from the terminal operator.

## 4. The three artefacts

### 4.1 Definition

One document per process. See [DEFINITIONS.md](DEFINITIONS.md) for the annotated schema and
[definitions/](definitions/) for real examples.

```jsonc
{
  "@context": "https://pilots.example/process/v1",
  "id": "container-transport", "version": "1.0.0", "kind": "service",
  "roles": [ { "id": "shipper", "cardinality": 1 },
             { "id": "transporter", "cardinality": 1 } ],
  "hostedBy": "transporter",
  "initialState": "PENDING_CONTRACT",
  "terminalStates": ["DELIVERED", "CANCELLED"],
  "data": { /* JSON Schema for the instance's data document */ },
  "transitions": [ /* … */ ],
  "visibility": { "price": ["shipper", "transporter"] },
  "links": [ { "onEvent": "quotation:AGREED", "triggers": "startExecution" } ]
}
```

Two properties matter more than they look:

- **Multi-party is free.** A third participant is one more entry in `roles` plus its transitions. Not
  a redesign. This is the whole scaling argument: integration effort grows with the number of
  *processes*, not with the number of *pairs of companies*.
- **`links` is how parallel processes connect.** An instance may subscribe to another instance's
  event stream and auto-fire a transition when a matching signed event arrives. It earns itself
  immediately — it is how an agreed quotation starts the service execution waiting behind it — and it
  generalises to linking genuinely separate processes later.

### 4.2 Instance

```jsonc
{ "id": "018f2c…",
  "kind": "service",
  "definition": "container-transport@1.0.0",
  "participants": { "shipper": "did:web:acme-shipping.example",
                    "transporter": "did:web:vanmoer.example" },
  "quotationId": "018f2b…",
  "state": "ASSIGNED",
  "seq": 3,
  "data": { /* validated against the definition's `data` schema */ } }
```

The instance is **derived by folding its event log**, and also stored materialised so reads are cheap.
The log is the truth; the materialised row is a cache. Any peer can rebuild the instance from events
it has verified itself — which is what makes hosting a mechanical role rather than a position of trust.

**A quotation is an instance too.** `kind: "quotation"`, its own definition, its own state machine.
A service instance references the quotation that authorised it via `quotationId`. The quotation may
still be running while the service instance exists — it just cannot leave `PENDING_CONTRACT` until the
quotation reaches `AGREED`.

### 4.3 Signed event

```jsonc
{ "header": { "instance": "018f2c…", "seq": 4, "transition": "quote",
              "actor": "did:web:vanmoer.example",
              "from": "REQUESTED", "to": "OFFERED",
              "at": "2026-08-24T09:14:02Z",
              "prev": "sha256:9f3c…",
              "payloadHash": "sha256:1a7b…" },
  "payload": { "price": { "value": 320, "currency": "EUR" } },
  "sig": "<JWS over the canonicalised header>" }
```

- The **signature covers the header only**, and the header commits to the payload by hash.
- The chain (`prev`) links headers, so a peer can verify the complete, unbroken history of an instance
  **even for events whose payload it was never allowed to see**. This is not an optimisation; it is
  the thing that makes field-level visibility and tamper evidence coexist.
- Canonicalisation is **JCS (RFC 8785)** before hashing or signing. Non-negotiable — skipping it is
  the classic cross-implementation interop bug.

## 5. Hosting and the trust model

The definition names one role in `hostedBy`. That participant's node is the home node for every
instance of that definition: it holds the authoritative record, assigns `seq`, and is the address
every other participant talks to.

Peers do not take this on faith:

- Every transition is signed by the participant that made it. The host cannot invent a move by someone
  else, because it does not hold their key.
- Every event chains to its predecessor. The host cannot rewrite, reorder, or delete history without
  breaking the chain in a way every replica detects.
- Every peer keeps a full verified replica of the headers. A stalled or unavailable host does not
  destroy the record.

**What this does not do:** the host physically holds the payload bytes. Visibility rules govern who
may read which fields; they do not blind the host. Say this plainly whenever hosting comes up. If a
field must genuinely be withheld from the host, it does not belong in the instance — put a hash in the
instance and exchange the value out of band.

## 6. Connections

Two participants connect **before** any process runs. This replaces per-request callback URLs, and it
is where trust is established once instead of being re-derived on every message.

A connection holds: the peer's DID, its base URL, its status, and the **delivery channel** for events
in that direction:

| Delivery | How it works | Who it suits |
|---|---|---|
| `webhook` | We POST batches of signed events to one URL, registered once at handshake time. | Parties with a public endpoint and a backoffice that prefers push. |
| `stream` | The peer holds an SSE connection to us and receives events on it; reconnects with `Last-Event-ID` and catches up. | Parties behind NAT, on a laptop, or unwilling to run a public HTTPS endpoint. |

Both carry **the identical signed event object**. Transport is configuration, not protocol. That is
what lets the same software serve a one-truck haulier and a terminal operator without a second
codebase — and it is why a small party never needs DNS, a certificate, or an inbound firewall rule.

Handshake and trust checks are specified in [PROTOCOL.md](PROTOCOL.md#2-connections).

## 7. Visibility

`visibility` maps a field path in the instance's data document to the roles that may read it. It is
applied on read (`GET /instances/{id}`), on log replay (`GET /instances/{id}/events`), on the event
stream, and on attachment fetches. There is one enforcement point, and it is not the caller's
good manners.

The demo uses it for something real: the weighed gross mass is withheld from the requester until
payment is recorded. That is a genuine commercial rule, enforced by the runtime rather than by
whoever assembled the message.

## 8. Multi-tenancy readiness

The demo runs one participant per node. The code does not assume it:

- Every table carries `participantId`.
- The signer interface takes a participant, not a global key.
- Configuration holds a *list* of participants.
- `did:web` supports path segments, so a hosted tenant has a real, resolvable DID:
  `did:web:connectors.example.com:t:acme`.

This is a few hours of care now. It is what makes "pay a monthly fee and someone else runs your
connector" possible later without a rewrite — which is the only realistic path to onboarding parties
too small to run any infrastructure at all.

## 9. Cost targets

| Target | Value |
|---|---|
| Containers per party | 1 (+ Postgres for the large-party profile only) |
| Memory, small-party profile | < 150 MB |
| `docker compose up` → first transaction | < 60 s |
| Public HTTPS endpoint required | No, with `stream` delivery |
| Onboarding a participant | Publish one static `did.json`; accept one connection request |

These are acceptance criteria. Measure them; do not assert them.
