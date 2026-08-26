# Scenarios

*What the demo must do. Each step maps to an endpoint in [PROTOCOL.md](PROTOCOL.md) and a transition in
[definitions/](definitions/). If a step has no endpoint, the protocol is incomplete — that is what this
document is for.*

Every scenario here is first a **hermetic scenario test** — two connector instances in one process, fake
clock, memory store, no containers — and only then a container demo. See
[TESTING.md §3.3](TESTING.md#33-scenario--the-load-bearing-tier). The tables below name the surface each
call sits on, because that is the part the component split makes load-bearing.

Two participants throughout:

| | DID | Profile |
|---|---|---|
| **Acme Shipping** (small) | `did:web:acme-shipping.example` | File store, no database container, local key, `stream` peer delivery, no public endpoint. A person clicks in the **process UI**, which holds an API key. |
| **Van Moer** (large) | `did:web:vanmoer.example` | Managed document store, public endpoint, `webhook` **local** delivery into a mock backoffice that auto-responds. No process UI. |

Same connector image, two configuration files. That difference is the entire "small consumer and large
supplier on one stack" claim, and it should be visible in the demo rather than argued in a slide. Note
that the two sides differ in a second way now: Acme runs a second container for the UI and Van Moer does
not, because Van Moer integrates its own systems instead.

**How to read the `Call` column.** Acme's process UI never addresses Van Moer. It calls Acme's connector
on `/api/local/v1`, and Acme's connector relays to Van Moer's `/api/peer/v1` because the definitions are
`hostedBy: weigher` / `transporter`. Written as `local → peer` below. See
[PROTOCOL.md §4.1](PROTOCOL.md#41-relay-by-hostedby).

---

## S0 — Connect

Prerequisite for everything else. Runs once, and it is **operator** work rather than integration work.

| # | Actor | Surface | Call | Result |
|---|---|---|---|---|
| 1 | Acme operator | admin | `POST /api/admin/v1/connections` `{ toDid, delivery: "stream" }` | Acme's connector sends the request |
| 2 | Acme connector | peer | `POST vanmoer/api/peer/v1/connections/requests` | `202`, Van Moer holds it `PENDING_INBOUND` |
| 3 | Van Moer connector | — | resolves `did:web:acme-shipping.example`, checks the DID document's host matches `fromBaseUrl`, verifies the request JWS | trust established; audited |
| 4 | Van Moer operator | admin | `POST /api/admin/v1/connections/{id}/accept` | audited with the admin session |
| 5 | Van Moer connector | peer | `POST acme/api/peer/v1/connections/{id}/accepted` `{ delivery: "webhook", deliveryUrl }` | both sides `ACTIVE` |
| 6 | Acme connector | peer | opens `GET vanmoer/api/peer/v1/stream` (SSE) | events now flow |

**Note what Acme never needed:** a domain with an inbound route, a TLS certificate, a firewall rule, or
a callback URL per request. It publishes one static `did.json` and holds one outbound connection.

**Note what Acme's UI never needed:** any knowledge of this. Connections are operator state, exposed to
integrators read-only via `GET /api/local/v1/connections`.

Demo deployments may seed steps 1–5 from configuration. The handshake must still work when they do not.

---

## S1 — Standing quotation: container weighing

Proves: standing quotations need no negotiation code path; state-dependent field visibility is enforced
by the runtime; attachments are content-addressed; the relay is invisible to the caller.

Definitions: [`container-weighing-quotation`](definitions/container-weighing-quotation.json) (standing),
[`container-weighing`](definitions/container-weighing.json). Both `hostedBy: weigher`, so **Van Moer
hosts both instances** and Acme holds verified replicas.

| # | Actor | Surface | Action | State after |
|---|---|---|---|---|
| 1 | Acme UI | local → peer | `GET /api/local/v1/offerings?peer=vanmoer` | sees `container-weighing` at a fixed price, conditions `terminal`, `containerType` |
| 2 | Acme UI | local → peer | `POST /instances` with the quotation definition and the offering URI | quotation `agree` fires automatically (`auto: true`) → **`AGREED`** at `seq 1` |
| 3 | Acme UI | local → peer | `POST /instances` with the service definition + `quotationId` | service **`ORDERED`** |
| 4 | Acme UI | local → peer | `POST …/transitions` `announceTruck` `{ truckPlate, expectedAt }`, `If-Match: 1` | **`TRUCK_ANNOUNCED`** |
| 5 | Van Moer backoffice | local | `weigh` `{ grossMass: { value, unit, measuredAt } }` | **`WEIGHED`** |
| 6 | Acme UI | local | reads the instance | `grossMass` is **absent** — no grant matches `shipper` in `WEIGHED`. The event header still verifies; only the value is withheld. |
| 7 | Van Moer backoffice | local | `recordPayment` `{ paymentReference }` | **`PAID`** |
| 8 | Acme UI | local | reads the instance | `grossMass` is **now present** — the `whenState: ["PAID","VGM_ISSUED"]` grant matches. Nothing was re-sent; the same stored event is filtered differently. |
| 9 | Van Moer backoffice | local | `issueVgm` with a PDF attachment `{ sha256, mime, size }` | **`VGM_ISSUED`** (terminal) |
| 10 | Acme UI | local | `GET /api/local/v1/attachments/{sha256}` | certificate bytes, hash checked against the event header |

Step 6→8 is the point of the scenario. The withheld field is a genuine commercial rule, and it is
enforced in one place in the runtime rather than by whoever assembled the message.

Two things the surface column makes visible. Van Moer's backoffice and Acme's UI use **the same API**,
authenticated the same way — one is a person clicking and one is a machine reacting, and the connector
cannot tell the difference. And Acme's UI made every call to its own connector; the relay to Van Moer
never appears in its code.

---

## S2 — Negotiated quotation: container transport

Proves: quotation and service are one primitive; the quotation runs in parallel without blocking;
`links` advances a second instance from a signed event in a first; optimistic concurrency works.

Definitions: [`container-transport-quotation`](definitions/container-transport-quotation.json),
[`container-transport`](definitions/container-transport.json). Both `hostedBy: transporter`.

| # | Actor | Surface | Action | Quotation | Service |
|---|---|---|---|---|---|
| 1 | Acme UI | local → peer | `POST /instances` — quotation, with pickup, dropoff, container type | `REQUESTED` | — |
| 2 | Acme UI | local → peer | `POST /instances` — service, referencing `quotationId` | `REQUESTED` | **`PENDING_CONTRACT`** |
| 3 | Van Moer backoffice | local | local delivery webhook fires; auto-quotes: `offer` `{ price: 320 EUR, pickup.earliest +1d }` | `OFFERED` | `PENDING_CONTRACT` |
| 4 | Acme UI | local → peer | `counter` `{ pickup.earliest: original, notes }` | `COUNTERED` | `PENDING_CONTRACT` |
| 5 | Van Moer backoffice | local | `offer` `{ price: 355 EUR }` | `OFFERED` | `PENDING_CONTRACT` |
| 6 | Acme UI | local → peer | `accept` | **`AGREED`** | — |
| 7 | *runtime* | — | link `quotation:AGREED → startExecution` fires on the service instance | `AGREED` | **`CONTRACTED`** |
| 8 | Van Moer backoffice | local | `assign` `{ vehiclePlate, driverName, plannedPickupAt }` | | **`ASSIGNED`** |
| 9 | Acme UI | local | reads | | `driverName` absent — granted to `shipper` only from `PICKED_UP` |
| 10 | Van Moer backoffice | local | `pickup` `{ actualPickupAt, containerNumber }` | | **`PICKED_UP`**, `driverName` now visible |
| 11 | Van Moer backoffice | local | `deliver` `{ deliveredAt, proofOfDelivery }` + PDF | | **`DELIVERED`** (terminal) |

Three things to demonstrate explicitly alongside the happy path:

- **The service instance exists from step 2**, sitting in `PENDING_CONTRACT` while the quotation is
  still being negotiated. This is IDEA.md's "the quotation process does not block execution", made
  concrete: the instance is real and addressable, it simply cannot advance yet.
- **Concurrency**: have Acme send `counter` twice with the same `If-Match`. The second returns `409`
  with the current `seq` — **passed through the relay unchanged**, not rewritten into a `502`. Then
  repeat with the same `Idempotency-Key` and confirm the original result comes back rather than a second
  transition.
- **The deadline path**: leave an offer unanswered past `PT24H` and watch `expire` fire with `by: []` — a
  transition no participant can invoke by hand. In the scenario test this is a fake-clock advance, not a
  shortened duration and a wait.

---

## S3 — Three parties

Proves the model is not bilateral. **Not executed in the first milestone.**

[`container-transport-with-terminal`](definitions/container-transport-with-terminal.json) must load,
lint and render under exactly the same schema as the two-role definitions. Compare the two files
side by side: one extra entry in `roles`, three extra transitions, two extra visibility grants. No
schema change, no engine change, no second wire format.

Note the `price` grant excludes `terminal` — a terminal operator sees the movement and the driver, not
the commercial terms. That is the shape every real multi-party logistics process has.

The acceptance test for this milestone is simply that all five definitions lint. Until M1 replaces it:

```bash
python3 tools/lint-definitions.py docs/definitions
```

---

## S4 — The demos that actually sell the architecture

Happy paths convince nobody. These do. **S4a and S4b are scenario tests first** — they run in
milliseconds in `pnpm test` — and container demos second. They were manual steps in the M0 plan, which
was a mistake: they are the two most important behaviours in the design.

### S4a — Offline catch-up

Stop Acme's connector mid-process. Van Moer continues, advancing the instance two or three steps.
Restart Acme.

Expected: the connector reconnects, sends `Last-Event-ID`, receives everything it missed, verifies the
chain, and converges. **No operator action, no resync tool, no lost process.** Contrast with holding
process state in memory, where a restart loses everything in flight.

*As a scenario test:* drop the in-process transport, advance the instance on the host, reattach, assert
convergence and a fully verified chain.

### S4b — Tamper detection

With the process running, edit an event directly in Van Moer's store — change a price, or drop an event.
With the file adapter this is literally editing a JSON file, which makes the demo better, not worse.

Expected: Acme's next verification fails at the `prev` hash or the `from` state, the UI says so plainly
and in red, and the audit log carries a `chain.verify` / `failed` entry.

Do not make this failure recoverable by resyncing. It is a hard error and must look like one.

### S4c — Cold start

```bash
docker compose up
```

Expected: **three containers** for the full-self-hosting demo — Acme's connector, Acme's process UI, Van
Moer's connector — both connectors healthy, connection established, first transaction completed in
**under 60 seconds**, with container count and resident memory printed at the end.

Measure it for each topology, since the container count is the claim: 2 self-run for full self-hosting,
1 for the headless integrator, 0 for fully hosted. Note that **neither connector needs a database
container**.

Measure it. Do not assert it. The number is the argument.

### S4d — Refused actions leave a trail

New, and it exists because the audit log was added for exactly this. Nothing here produces a business
event, so before the audit log there was no record any of it happened.

| Attempt | Expected |
|---|---|
| An API key without `instances:write` fires a transition | `403`, audit entry `outcome: "denied"`, no event |
| Acme fires a transition whose `by` lists only `weigher` | `403`, audit entry, no event |
| A peer presents a JWS that fails verification | `401`, audit entry with the peer DID, application log warning |
| A connection request is rejected by the operator | connection `REJECTED`, audit entry with the admin session |
| The relay target is unreachable | `502 peer-unreachable` — **not** a `409` — audit entry, retryable |

Expected: five entries in the audit log, an unbroken audit hash chain across them, and five lines in the
application log. The point to make out loud: **the event log is silent about all of this, by design.**
