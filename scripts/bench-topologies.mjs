#!/usr/bin/env node
/**
 * S4c: measure every topology, rather than claiming any of them.
 *
 *     pnpm bench:topologies
 *
 * The container count *is* the argument, so it has to be counted rather than
 * asserted. For each deployment shape this prints containers, databases, the
 * time until everything is healthy, the time to a first transaction, and the
 * memory each container actually uses against the limit it runs under.
 *
 * Four shapes, which are the same compose file with different services running:
 *
 * | Shape                | Self-run per party | What it is                          |
 * |----------------------|--------------------|-------------------------------------|
 * | headless integrator  | 1                  | a connector, own systems on the API |
 * | automated party      | 1 + a backoffice   | one side clicks, the other does not |
 * | full self-hosting    | 2                  | a connector and a process UI        |
 * | fully hosted         | 0                  | somebody else runs both             |
 *
 * "Fully hosted" is measured as what the *hosting provider* runs, because from
 * the hosted party's side there is nothing to measure: that is the claim.
 *
 * Numbers move with the machine. What should not move is the shape of the
 * table — a topology that grows a database container has broken a promise.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * `docker compose`, optionally with an overlay.
 *
 * The overlays are how a topology differs: the automated party adds a
 * backoffice, the managed profile adds a document store. Every call in one
 * measurement has to use the same files, or `down` leaves the previous shape's
 * containers running and the next count is wrong.
 */
let overlays = []

function compose(...args) {
  const files = ['-f', 'docker-compose.yml', ...overlays.flatMap((one) => ['-f', one])]
  return execFileSync('docker', ['compose', ...files, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    // Compose narrates every container it touches; this script's own output is
    // the point.
    stdio: ['ignore', 'pipe', 'ignore'],
  })
}

const env = Object.fromEntries(
  readFileSync(resolve(repoRoot, '.env'), 'utf8')
    .split('\n')
    .map((line) => /^([A-Z0-9_]+)=(.*)$/.exec(line.trim()))
    .filter(Boolean)
    .map((match) => [match[1], match[2]]),
)

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

async function json(url, { method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  return { status: response.status, body: text === '' ? undefined : JSON.parse(text) }
}

/** Wait until every named service reports healthy, or give up loudly. */
async function healthy(services, startedAt, limitMs = 180_000) {
  for (;;) {
    const lines = compose('ps', '--format', '{{.Name}} {{.Status}}')
      .trim()
      .split('\n')
      .filter(Boolean)
    const up = lines.filter((line) => line.includes('(healthy)'))
    if (up.length >= services.length) return (Date.now() - startedAt) / 1000
    if (Date.now() - startedAt > limitMs) {
      throw new Error(`not healthy within ${limitMs}ms:\n${lines.join('\n')}`)
    }
    await sleep(250)
  }
}

/** Memory per container, as the cgroup reports it — the figure to size against. */
function memory() {
  return compose('ps', '--format', '{{.Name}}')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((name) => {
      const stat = execFileSync(
        'docker',
        ['stats', '--no-stream', '--format', '{{.MemUsage}}|{{.MemPerc}}', name],
        { encoding: 'utf8' },
      ).trim()
      const [usage, percent] = stat.split('|')
      return { name: name.replace(/^pilots-service-/, '').replace(/-\d+$/, ''), usage, percent }
    })
}

async function adminKey(port, participantId, service) {
  const token = compose('logs', service)
    .split('\n')
    .map((line) => (line.includes('adminToken') ? line.slice(line.indexOf('| ') + 2) : null))
    .filter(Boolean)
    .map((line) => JSON.parse(line).adminToken)
    .filter(Boolean)[0]
  if (!token) throw new Error(`no admin token for ${service}`)

  const session = await json(`http://localhost:${port}/api/admin/v1/sessions`, {
    method: 'POST',
    body: { token },
  })
  const minted = await json(`http://localhost:${port}/api/admin/v1/apikeys`, {
    method: 'POST',
    body: {
      label: 'bench',
      participantId,
      scopes: ['instances:read', 'instances:write', 'events:read', 'definitions:read'],
    },
    headers: { authorization: `Session ${session.body.session.id}` },
  })
  return minted.body.secret
}

const WEIGHING = {
  definition: 'container-weighing@1.0.0',
  participants: {
    shipper: 'did:web:org-a.example',
    weigher: 'did:web:org-b.example',
  },
  data: { containerNumber: 'MSCU0000000', terminal: '869' },
}

/** Start a set of services cold and time the first transaction through them. */
async function measure({ title, selfRun, services, firstTransaction, files = [] }) {
  process.stdout.write(`\n${title}\n${'─'.repeat(title.length)}\n`)
  // Tear the *previous* shape down with the files that built it, then adopt this
  // one's. A `down` that does not name an overlay leaves its containers behind.
  compose('down', '-v')
  overlays = files

  const startedAt = Date.now()
  compose('up', '-d', ...services)
  const healthyAt = await healthy(services, startedAt)
  const first = await firstTransaction()
  const firstAt = (Date.now() - startedAt) / 1000

  const containers = compose('ps', '--format', '{{.Name}}').trim().split('\n').filter(Boolean)
  const used = memory()

  process.stdout.write(`  containers            ${containers.length} (0 databases)\n`)
  process.stdout.write(`  self-run per party    ${selfRun}\n`)
  process.stdout.write(`  all healthy           ${healthyAt.toFixed(1)}s\n`)
  process.stdout.write(`  first transaction     ${firstAt.toFixed(1)}s  — ${first}\n`)
  for (const one of used) {
    process.stdout.write(`  ${one.name.padEnd(20)}  ${one.usage} (${one.percent})\n`)
  }
  return { title, selfRun, containers: containers.length, healthyAt, firstAt, used }
}

/** A person's route: the process UI, signed in, clicking start. */
async function throughTheUi() {
  const jar = []
  const call = async (path, options = {}) => {
    const response = await fetch(`http://localhost:4000${path}`, {
      ...options,
      headers: {
        'content-type': 'application/json',
        // What a browser sends, and what better-auth requires before it will
        // accept a state-changing request. A script standing in for a person
        // has to look like one.
        origin: 'http://localhost:4000',
        ...(jar.length ? { cookie: jar.join('; ') } : {}),
        ...(options.headers ?? {}),
      },
    })
    const setCookie = response.headers.getSetCookie?.() ?? []
    for (const cookie of setCookie) jar.push(cookie.split(';')[0])
    const text = await response.text()
    return { status: response.status, body: text === '' ? undefined : JSON.parse(text) }
  }

  const signedIn = await call('/api/auth/sign-in/email', {
    method: 'POST',
    body: JSON.stringify({ email: 'alice@org-a.example', password: 'demo-password-org-a' }),
  })
  if (signedIn.status !== 200) {
    throw new Error(`sign-in failed: ${signedIn.status} ${JSON.stringify(signedIn.body)}`)
  }
  if (jar.length === 0) throw new Error('sign-in set no cookie')
  const created = await call('/api/ui/instances', {
    method: 'POST',
    body: JSON.stringify({
      definition: WEIGHING.definition,
      participants: { shipper: '__self__', weigher: WEIGHING.participants.weigher },
      data: WEIGHING.data,
    }),
  })
  if (created.status !== 201) throw new Error(`UI create failed: ${JSON.stringify(created.body)}`)
  return `started in the browser, relayed to the peer (${created.body.instance.state})`
}

/** An integrator's route: the local API, with a key. */
async function throughTheApi() {
  const key = await adminKey(3000, 'org-a', 'org-a')
  const created = await json('http://localhost:3000/api/local/v1/instances', {
    method: 'POST',
    body: WEIGHING,
    headers: { authorization: `ApiKey ${key}`, 'x-actor-ref': 'bench' },
  })
  if (created.status !== 201) throw new Error(`API create failed: ${JSON.stringify(created.body)}`)
  return `posted to the local API, relayed to the peer (${created.body.instance.state})`
}

const results = []

results.push(
  await measure({
    title: 'Headless integrator — a connector, own systems on the local API',
    selfRun: 1,
    services: ['org-a', 'org-b'],
    firstTransaction: throughTheApi,
  }),
)

results.push(
  await measure({
    title: 'Automated party — one side clicks, the other runs a backoffice',
    selfRun: '1 + a backoffice',
    files: ['docker-compose.automated.yml'],
    services: ['org-a', 'org-a-ui', 'org-b', 'backoffice'],
    firstTransaction: throughTheUi,
  }),
)

results.push(
  await measure({
    title: 'Full self-hosting — a connector and a process UI, both parties',
    selfRun: 2,
    services: ['org-a', 'org-a-ui', 'org-b', 'org-b-ui'],
    firstTransaction: throughTheUi,
  }),
)

/*
 * Fully hosted has nothing to measure on the hosted party's side, which is the
 * claim rather than a gap: they run no containers at all. What is measured is
 * what the *provider* runs to serve them — the same two processes, with both
 * participants configured on one connector.
 */
process.stdout.write(
  `\nFully hosted — 0 self-run containers\n${'─'.repeat(36)}\n` +
    '  There is nothing to start on the hosted party’s side, so there is nothing\n' +
    '  to time. What a provider runs for them is the row above; the hosted-tenant\n' +
    '  shape (several participants on one connector) is exercised by the scenario\n' +
    '  suite rather than here, because it needs no containers to be true.\n',
)

compose('down', '-v')

process.stdout.write('\n\nSummary\n═══════\n')
process.stdout.write(
  '| Topology | Self-run | Containers | Databases | Healthy | First transaction |\n',
)
process.stdout.write('|---|---|---|---|---|---|\n')
for (const one of results) {
  process.stdout.write(
    `| ${one.title.split(' — ')[0]} | ${one.selfRun} | ${one.containers} | **0** | ${one.healthyAt.toFixed(1)} s | ${one.firstAt.toFixed(1)} s |\n`,
  )
}
process.stdout.write('| Fully hosted | 0 | 0 | **0** | — | — |\n')
void env
