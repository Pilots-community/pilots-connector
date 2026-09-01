# @pilots/connector

**The core.** Three API surfaces, the store, and a minimal admin UI it serves itself — one container,
zero databases.

Everybody runs this same image. A one-truck haulier and a terminal operator differ in *configuration*,
never in code: which store adapter, whether there is a public endpoint, how many participants. There is
no supplier mode and no consumer mode.

## The three surfaces

| Surface | Prefix | Auth | Callers |
|---|---|---|---|
| Peer | `/api/peer/v1` | JWS bearer, `did:web` (M3) | other connectors |
| Integration | `/api/local/v1` | API key + scopes, `X-Actor-Ref` | backoffice, own UI, the demo UI's BFF |
| Admin | `/api/admin/v1` | admin session | this connector's admin UI |
| — | `/.well-known/did.json` | none | anyone. Static; not a surface. |

**No privileged path.** The admin UI is an ordinary client of `/api/admin/v1`, and it cannot start a
process or apply a transition — that surface does not offer it. Anything our demo UI can do, a third
party's UI can do, over the same surface with the same auth.

## Running it

```bash
pnpm build && pnpm start          # needs the definitions directory; see .env.example
docker compose up                 # from the repo root: one container, no database
pnpm dev:ui                       # the admin UI on :5174, proxying to :3000
node scripts/bench.mjs            # cold start, resident memory, first transaction
```

On **first boot** the connector generates an Ed25519 key per participant, an API-key pepper, and an
admin token; it writes the first two to the secret store and prints the third **once**. Nothing secret
is ever typed, committed, or baked into an image.

## Layout

| | |
|---|---|
| `src/store/` | The repository port, the memory and file adapters, and one conformance suite both run. Connector-internal by design. |
| `src/instances/` | The one mutating path. Home-node resolution happens here, **per instance**. |
| `src/auth/` | Three guards for three surfaces; API keys hashed with HMAC + pepper. |
| `src/logging/` | The application log, with the `audit` flag that reaches the audit log from one call site. |
| `src/identity/` | Key bootstrap, DID documents. |
| `src/admin-ui/` | Vite + React. Built by `pnpm build:ui`, served from `/admin/`. |

## Two things worth knowing

**The file store is single-writer, single-process.** No horizontal scaling, no replicas. That is correct
for the small-party profile and a footgun if left unwritten. Scaling out means the document-store
profile, not making this adapter clever.

**Every participant that takes part in an instance holds its own copy and its own log**, and exactly one
of them carries `home: true`. With one participant configured that is a batch of one; with a hosted
tenant beside its counterparty it is two. That is what makes `home: false` a real state rather than a
field that is always true — and it is why M3's peer replication is a transport swap rather than a
redesign.
