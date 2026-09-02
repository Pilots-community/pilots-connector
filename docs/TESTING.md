# Testing

*Standing rules in [../AGENT.md](../AGENT.md). This document exists because the test setup is a design
constraint here, not an implementation detail.*

## 1. The rule

**No unit, contract or scenario test may require a network, a container, a real clock, or a filesystem
outside a temporary directory.**

This is enforced structurally rather than by discipline: everything external is a port, so a test
supplies a deterministic implementation instead of arranging the real thing. A test that needs a
container is either an `e2e` test or a mistake.

The reason is blunt. If proving that a scenario works requires standing up two containers, nobody runs
the proof while they are working, the feedback loop stretches to minutes, and confidence quietly
migrates into a slow flaky browser suite that everybody learns to re-run until it goes green.

## 2. The four ports

| Port | Test implementation | What it removes |
|---|---|---|
| `Clock` | fake, manually advanced | every `sleep`, every timing flake, hour-long deadline waits |
| `IdGenerator` | deterministic ULIDs from a seed | unstable snapshots and unreproducible failures |
| `Signer` | keys generated at test setup | key files, and any temptation to commit one |
| `Transport` (peer delivery) | in-process — two connectors wired directly together | HTTP, ports, containers, network flake |
| `NotificationChannel` (local delivery) | in-memory collector | a webhook receiver, and any real queue |
| Repository | memory adapter | a database of any kind |

`Transport` is the one that changes what is possible. With it, a complete two-party run is a function
call, so the whole of S1 or S2 executes inside a single test process.

**Test keys are generated at setup. No private key is ever committed, including as a fixture.**

## 3. The four tiers

| Tier | Scope | Dependencies | Runs |
|---|---|---|---|
| `unit` | Pure functions in `packages/protocol` — evaluator, merge patch, visibility filter, chain verification, linter, JCS | none | always |
| `contract` | The repository conformance suite, run against each adapter | memory + file always; mongo tagged | always (mongo in CI) |
| `scenario` | S0–S4 end to end, two connector instances in one process | none | always |
| `e2e` | Playwright: process UI → connector → connector → mock backoffice, plus admin flows | local processes; containers only for S4c | pre-merge |

`pnpm test` runs the first three. It must stay fast enough to run on save.

### 3.1 `unit`

`packages/protocol` is the spec, so its tests are the specification's proof. No ports involved at all —
these are pure functions over documents. If behaviour is not covered here as a schema or a tested
function, it is not decided.

### 3.2 `contract`

One conformance suite, three adapters, identical assertions. Its job is the two operations that actually
shape the port
([ARCHITECTURE.md §7.1](ARCHITECTURE.md#71-the-port-is-shaped-by-two-operations)):

- `appendEvent` under a concurrent, stale `expectedSeq` → conflict, and **no partial write**: never an
  appended event with an unadvanced instance, or the reverse.
- `claimIdempotencyKey` under a genuine race → exactly one winner, the loser gets the stored result.

Memory and file are both single-writer and in-process, so on their own they cannot fail these tests in
the ways a real store can. That is precisely why the Mongo adapter runs the same suite in CI from M3
rather than appearing at the end.

### 3.3 `scenario` — the load-bearing tier

Two connector instances, in one process, wired by the in-process transport, with a fake clock and the
memory store. This is where the scenarios in [SCENARIOS.md](SCENARIOS.md) are proven.

**Built at M3, and it earned its keep on the first day.** Each node in the harness is a *whole*
connector: its own store, its own generated keys, its own audit log, its own peer surface. Only the
four ports are doubled. Nothing about authentication, connection state, signing, verification or
visibility is stubbed — the in-process transport calls the same `PeerSurface.handle` the HTTP
controller calls, so a scenario test and a container run differ only in the bytes between them. If any
check lived in the HTTP layer instead, this tier would be proving something weaker than what ships,
and S4d — which is entirely about refusals — would be theatre.

The three that matter most stop being manual demo steps:

| Scenario | As a scenario test |
|---|---|
| **S4a** offline catch-up | drop the transport, advance the instance on the host, reattach, assert convergence and a verified chain |
| **S4b** tamper detection | mutate a stored event, assert a hard failure at the `prev` hash or the `from` state, assert the audit entry, assert **no silent resync** |
| **S5** role symmetry | three participants, one definition, two instances with *different* home nodes; assert one connector is authoritative for one and a replica of the other, and that `action.required` fires for both of its roles |
| **S0** the handshake | request, domain-binding check, admin accept, peer callback; plus a peer that claims a base URL its DID is not bound to, and one whose body names a different sender than its token |
| **deadlines** | advance the fake clock past `PT24H`, assert `expire` fired with `by: []` |

**S5 is the clearest case for this tier existing at all.** The demo runs one direction, so a
per-definition hosting shortcut would pass every container demo and every happy path. Only a test that
stands up two instances of one definition with opposite participants catches it — and that test is
impossible to write cheaply *unless* two connectors can run in one process.

These are the two most important behaviours in the whole design — "the host cannot lie" and "a restart
loses nothing". They should not be things a person checks by hand before a demo.

Also proven here, because they are cheap once the harness exists: the `409` on a stale `If-Match`, the
same `Idempotency-Key` returning the original result, visibility withholding `grossMass` before `PAID`
and releasing it after, a redacted payload verifying, and every refusal producing an audit entry.

**Notifications too**, and this is the tier that must cover them, because a webhook receiver is exactly
the kind of external dependency that tempts people into containers. Against an in-memory channel: that
`action.required` fires for the party whose turn it is and *not* for the other one; that
`action.cleared` follows; that a subscription's filters exclude what they should; that the envelope is
visibility-filtered; that a failed delivery retries, then dead-letters, then replays from its cursor.
An **automated participant is a test fixture**: subscribe to `action.required`, post back the transition
it names, and S1 runs with no UI and no human in it at all.

### 3.4 `e2e`

Playwright, and deliberately small. It proves **wiring and UI**: that the process UI's API key reaches
the connector, that the relay works over real HTTP, that the admin UI can mint a key and accept a
connection, and that a broken chain is loud and red on screen.

It never carries the burden of proving protocol behaviour. If an e2e test is the only thing covering a
rule, that rule is missing a scenario test.

**Built at M5**, and smaller than the plan expected: seven specs over the process UI and the admin UI.
It runs against `docker compose up` rather than starting local processes, because the thing being
tested *is* four containers wired together — starting them another way would exercise a topology
nobody ships.

What it proved that nothing else did: two genuine bugs in the SPA, both races. A stale definition
fetch could land after a newer one and overwrite it, and resetting the form inside that async effect
could wipe a role the user had already chosen. Neither is reachable from a scenario test, because
neither is about the protocol — which is exactly the division of labour this tier is for.

## 4. What this buys

A cost target, listed alongside the others in `AGENT.md`: **the full S0–S4 suite runs in seconds, with
no containers.** If that stops being true, the harness has regressed and it will take the team's
willingness to run it with it.
