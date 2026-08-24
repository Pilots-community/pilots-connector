# Scenarios

*What the demo must do. Each step maps to an endpoint in [PROTOCOL.md](PROTOCOL.md) and a transition in
[definitions/](definitions/). If a step has no endpoint, the protocol is incomplete — that is what this
document is for.*

Two participants throughout:

| | DID | Profile |
|---|---|---|
| **Acme Shipping** (small) | `did:web:acme-shipping.example` | SQLite, local key, `stream` delivery, no public endpoint. A person clicks in the UI. |
| **Van Moer** (large) | `did:web:vanmoer.example` | Postgres, public endpoint, `webhook` delivery into a mock backoffice that auto-responds. |

Same image, two configuration files. That difference is the entire "small consumer and large supplier
on one stack" claim, and it should be visible in the demo rather than argued in a slide.

---

## S0 — Connect

Prerequisite for everything else. Runs once.

| # | Actor | Call | Result |
|---|---|---|---|
| 1 | Acme | `POST vanmoer/api/v1/connections/requests` `{ fromDid, fromBaseUrl, delivery: "stream" }` | `202`, Van Moer holds it `PENDING_INBOUND` |
| 2 | Van Moer | resolves `did:web:acme-shipping.example`, checks the DID document's host matches `fromBaseUrl`, verifies the request JWS | trust established |
| 3 | Van Moer operator | `POST /api/v1/connections/{id}/accept` (local, from the UI) | — |
| 4 | Van Moer | `POST acme/api/v1/connections/{id}/accepted` `{ delivery: "webhook", deliveryUrl }` | both sides `ACTIVE` |
| 5 | Acme | opens `GET vanmoer/api/v1/stream` (SSE) | events now flow |

**Note what Acme never needed:** a domain with an inbound route, a TLS certificate, a firewall rule, or
a callback URL per request. It publishes one static `did.json` and holds one outbound connection.

Demo deployments may seed step 1–4 from configuration. The handshake must still work when they do not.

---

## S1 — Standing quotation: container weighing

Proves: standing quotations need no negotiation code path; state-dependent field visibility is enforced
by the runtime; attachments are content-addressed.

Definitions: [`container-weighing-quotation`](definitions/container-weighing-quotation.json) (standing),
[`container-weighing`](definitions/container-weighing.json). Both `hostedBy: weigher`, so **Van Moer
hosts both instances** and Acme holds verified replicas.

| # | Actor | Action | State after |
|---|---|---|---|
| 1 | Acme | `GET vanmoer/api/v1/offerings` | sees `container-weighing` at a fixed price, conditions `terminal`, `containerType` |
| 2 | Acme | `POST vanmoer/api/v1/instances` with the quotation definition and the offering URI | quotation `agree` fires automatically (`auto: true`) → **`AGREED`** at `seq 1` |
| 3 | Acme | `POST vanmoer/api/v1/instances` with the service definition + `quotationId` | service **`ORDERED`** |
| 4 | Acme | `POST …/transitions` `announceTruck` `{ truckPlate, expectedAt }`, `If-Match: 1` | **`TRUCK_ANNOUNCED`** |
| 5 | Van Moer | `weigh` `{ grossMass: { value, unit, measuredAt } }` | **`WEIGHED`** |
| 6 | Acme | reads the instance | `grossMass` is **absent** — no grant matches `shipper` in `WEIGHED`. The event header still verifies; only the value is withheld. |
| 7 | Van Moer | `recordPayment` `{ paymentReference }` | **`PAID`** |
| 8 | Acme | reads the instance | `grossMass` is **now present** — the `whenState: ["PAID","VGM_ISSUED"]` grant matches. Nothing was re-sent; the same stored event is filtered differently. |
| 9 | Van Moer | `issueVgm` with a PDF attachment `{ sha256, mime, size }` | **`VGM_ISSUED`** (terminal) |
| 10 | Acme | `GET vanmoer/api/v1/attachments/{sha256}` | certificate bytes, hash checked against the event header |

Step 6→8 is the point of the scenario. The withheld field is a genuine commercial rule, and it is
enforced in one place in the runtime rather than by whoever assembled the message.

---

## S2 — Negotiated quotation: container transport

Proves: quotation and service are one primitive; the quotation runs in parallel without blocking;
`links` advances a second instance from a signed event in a first; optimistic concurrency works.

Definitions: [`container-transport-quotation`](definitions/container-transport-quotation.json),
[`container-transport`](definitions/container-transport.json). Both `hostedBy: transporter`.

| # | Actor | Action | Quotation | Service |
|---|---|---|---|---|
| 1 | Acme | `POST /instances` — quotation, with pickup, dropoff, container type | `REQUESTED` | — |
| 2 | Acme | `POST /instances` — service, referencing `quotationId` | `REQUESTED` | **`PENDING_CONTRACT`** |
| 3 | Van Moer backoffice | webhook fires; auto-quotes: `offer` `{ price: 320 EUR, pickup.earliest +1d }` | `OFFERED` | `PENDING_CONTRACT` |
| 4 | Acme | `counter` `{ pickup.earliest: original, notes }` | `COUNTERED` | `PENDING_CONTRACT` |
| 5 | Van Moer | `offer` `{ price: 355 EUR }` | `OFFERED` | `PENDING_CONTRACT` |
| 6 | Acme | `accept` | **`AGREED`** | — |
| 7 | *runtime* | link `quotation:AGREED → startExecution` fires on the service instance | `AGREED` | **`CONTRACTED`** |
| 8 | Van Moer | `assign` `{ vehiclePlate, driverName, plannedPickupAt }` | | **`ASSIGNED`** |
| 9 | Acme | reads | | `driverName` absent — granted to `shipper` only from `PICKED_UP` |
| 10 | Van Moer | `pickup` `{ actualPickupAt, containerNumber }` | | **`PICKED_UP`**, `driverName` now visible |
| 11 | Van Moer | `deliver` `{ deliveredAt, proofOfDelivery }` + PDF | | **`DELIVERED`** (terminal) |

Two things to demonstrate explicitly alongside the happy path:

- **The service instance exists from step 2**, sitting in `PENDING_CONTRACT` while the quotation is
  still being negotiated. This is IDEA.md's "the quotation process does not block execution", made
  concrete: the instance is real and addressable, it simply cannot advance yet.
- **Concurrency**: have Acme send `counter` twice with the same `If-Match`. The second returns `409`
  with the current `seq`. Then repeat with the same `Idempotency-Key` and confirm the original result
  comes back rather than a second transition.
- **The deadline path**: leave an offer unanswered past `PT24H` (shortened for the demo) and watch
  `expire` fire with `by: []` — a transition no participant can invoke by hand.

---

## S3 — Three parties

Proves the model is not bilateral. **Not executed in the first milestone.**

[`container-transport-with-terminal`](definitions/container-transport-with-terminal.json) must load,
lint and render under exactly the same schema as the two-role definitions. Compare the two files
side by side: one extra entry in `roles`, three extra transitions, two extra visibility grants. No
schema change, no engine change, no second wire format.

Note the `price` grant excludes `terminal` — a terminal operator sees the movement and the driver, not
the commercial terms. That is the shape every real multi-party logistics process has.

The acceptance test for this milestone is simply:

```bash
python3 tools/lint-definitions.py docs/definitions   # all five PASS
```

---

## S4 — The three demos that actually sell the architecture

Happy paths convince nobody. These three do.

### S4a — Offline catch-up

Stop Acme's node mid-process. Van Moer continues, advancing the instance two or three steps. Restart
Acme after several minutes.

Expected: the node reconnects, sends `Last-Event-ID`, receives everything it missed, verifies the
chain, and converges. **No operator action, no resync tool, no lost process.** Contrast with holding
process state in memory, where a restart loses everything in flight.

### S4b — Tamper detection

With the process running, edit an event row directly in Van Moer's database — change a price, or drop
an event.

Expected: Acme's next verification fails at the `prev` hash or the `from` state, and the UI says so
plainly. This is "the host cannot lie" in about ten seconds, and it is the answer to the first
question anyone asks about a model where one party holds the record.

Do not make this failure recoverable by resyncing. It is a hard error and must look like one.

### S4c — Cold start

```bash
docker compose up
```

Expected: two containers, both nodes healthy, connection established, first transaction completed in
**under 60 seconds**, with container count and resident memory printed at the end.

Measure it. Do not assert it. The number is the argument.
