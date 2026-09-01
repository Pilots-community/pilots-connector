# @pilots/protocol

**The specification.** If behaviour is not expressed here as a schema or a tested function, it is not
decided.

Everything downstream — the connector, the client, both UIs — reads a process definition through this
package rather than reimplementing any part of it. It is also the reference for implementations in other
languages: see [`schema/`](schema) for the JSON Schema projection.

Pure functions and schemas only. No I/O, no clock, no store, no network. The one adapter that touches a
network (`did:web` over HTTPS) sits on its own entry point so importing the core cannot pull it in.

## What is in here

| Area | What it does |
|---|---|
| `canonical.ts` | JCS (RFC 8785) and `sha256`. Every hash and every signature goes through these two. |
| `merge-patch.ts` | JSON Merge Patch (RFC 7386). Hand-rolled: it *is* the spec. |
| `duration.ts` | The restricted ISO 8601 subset a `deadline` may use — `P#D`, `PT#H`, `PT#M`. |
| `schemas/` | zod schemas for every artefact: definition, instance, event, connection, offering, API key, audit entry, notification subscription. |
| `engine/evaluator.ts` | The state machine. `evaluateTransition`, `evaluateCreate`, `availableTransitions`, `autoTransitions`. |
| `engine/chain.ts` | Build, sign, fold and verify the event chain, including redacted payloads. |
| `engine/visibility.ts` | The visibility filter, applied to instances and to event payloads. |
| `engine/audit-chain.ts` | The same hash-chaining primitive applied to the local audit log. |
| `crypto/` | Detached compact JWS assembly, and the default local Ed25519 signer. |
| `ports/` | `Clock`, `IdGenerator`, `Signer`, `DidResolver`. |
| `lint/linter.ts` | The definition linter. |
| `validation/ajv.ts` | Ajv, for the JSON Schema a definition supplies for its own `data`, `patch` and `guards`. |

**Two validators, two jobs.** zod validates the protocol's own fixed shapes. Ajv validates the
user-supplied schemas carried inside a definition. Do not unify them.

## Entry points

```ts
import { evaluateTransition, verifyChain } from '@pilots/protocol'
import { FakeClock, testParticipants } from '@pilots/protocol/testing'
import { webDidResolver } from '@pilots/protocol/did-web'
```

`@pilots/protocol/testing` supplies the deterministic doubles that keep the rule "no unit, contract or
scenario test may require a network, a container or a real clock" true by construction. Test keys are
generated at setup; no private key is ever committed, including as a fixture.

## Commands

```bash
pnpm test               # from the repo root, or `pnpm --filter @pilots/protocol test`
pnpm lint:definitions   # lint docs/definitions
pnpm schema:export      # regenerate schema/*.json from the zod schemas
pnpm build              # dual ESM + CJS via tsup
```

`schema/` is committed and a test asserts it matches what the code generates, so a schema change that
was not exported fails the build rather than shipping a stale contract.

## Three decisions worth knowing before reading the code

**Creation is event `seq` 1**, recorded with the reserved transition id `create`, `from: null`, and `to`
equal to the definition's `initialState`. Without it the log could not reconstruct the instance it
describes, and a replica could not rebuild anything. The linter refuses a definition that declares a
transition called `create`.

**Signatures are detached** (RFC 7515 Appendix F): `<protected>..<signature>`, over the canonicalised
header, with the payload left out. The event already carries the header; a second base64url copy inside
the signature would be a copy that could disagree with the first.

**A `deadline` arms on entry into the transition's `to` state**, and `onDeadline` fires if the instance
is still there when it elapses. `offer` leads to `OFFERED` with `PT24H`, so the timer is "how long may an
offer sit unanswered" — which is what `expire`'s `from: ["OFFERED"]` and SCENARIOS.md S2 both describe.
The linter rejects an `onDeadline` target that cannot be applied in the state the timer arms in, because
it would otherwise silently never fire.
