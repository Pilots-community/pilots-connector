#!/usr/bin/env node
/**
 * Measure the numbers M2 promises, rather than asserting them.
 *
 *     node scripts/bench.mjs [--store file|memory]
 *
 * Prints cold-start time, resident memory as the operating system reports it,
 * and time-to-first-transaction: boot → admin session → API key → instance →
 * transition. NestJS costs roughly 30–50 MB of baseline RSS over plain Fastify,
 * so the < 150 MB target is a real constraint rather than a comfortable one, and
 * M2 is when swapping the framework would still be cheap.
 */
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const connectorRoot = resolve(here, '..')
const repoRoot = resolve(connectorRoot, '../..')

const storeArg = process.argv.includes('--store')
  ? process.argv[process.argv.indexOf('--store') + 1]
  : 'file'
const port = 3199
const base = `http://127.0.0.1:${port}`
const dataDir = mkdtempSync(join(tmpdir(), 'pilots-bench-'))

const child = spawn(process.execPath, [join(connectorRoot, 'dist/main.js')], {
  env: {
    ...process.env,
    PILOTS_PORT: String(port),
    PILOTS_HOST: '127.0.0.1',
    PILOTS_STORE: storeArg,
    PILOTS_STORE_DIR: dataDir,
    PILOTS_DEFINITIONS_DIR: join(repoRoot, 'docs/definitions'),
    PILOTS_PARTICIPANTS: JSON.stringify([
      {
        id: 'acme',
        did: 'did:web:acme-shipping.example',
        displayName: 'Acme Shipping',
        baseUrl: base,
      },
      {
        id: 'vanmoer',
        did: 'did:web:vanmoer.example',
        displayName: 'Van Moer',
        baseUrl: base,
      },
    ]),
    PILOTS_LOG_LEVEL: 'warn',
    NODE_ENV: 'production',
  },
  stdio: ['ignore', 'pipe', 'inherit'],
})

let adminToken
child.stdout.setEncoding('utf8')
child.stdout.on('data', (chunk) => {
  for (const line of chunk.split('\n')) {
    if (line.trim() === '') continue
    try {
      const entry = JSON.parse(line)
      if (entry.adminToken) adminToken = entry.adminToken
    } catch {
      // Not our structured log; ignore.
    }
  }
})

const started = process.hrtime.bigint()
const ms = (from) => Number(process.hrtime.bigint() - from) / 1e6

async function waitForHealth() {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    try {
      const response = await fetch(`${base}/healthz`)
      if (response.ok) return
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('the connector never became healthy')
}

async function json(path, options = {}) {
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
  })
  const body = await response.text()
  if (response.status >= 400) throw new Error(`${path} → ${response.status}: ${body}`)
  return { status: response.status, body: body === '' ? undefined : JSON.parse(body), response }
}

function residentMb(pid) {
  try {
    const out = execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' })
    return Math.round(Number(out.trim()) / 1024)
  } catch {
    return undefined
  }
}

try {
  await waitForHealth()
  const coldStartMs = ms(started)
  // The token is logged as the process starts; give the line a moment to arrive.
  for (let i = 0; i < 50 && adminToken === undefined; i += 1) {
    await new Promise((r) => setTimeout(r, 10))
  }
  if (!adminToken) throw new Error('no admin token was printed on first boot')

  const transactionStarted = process.hrtime.bigint()

  const session = (
    await json('/api/admin/v1/sessions', {
      method: 'POST',
      body: JSON.stringify({ token: adminToken }),
    })
  ).body.session.id

  const key = (
    await json('/api/admin/v1/apikeys', {
      method: 'POST',
      headers: { authorization: `Session ${session}` },
      body: JSON.stringify({
        label: 'bench',
        scopes: ['instances:read', 'instances:write'],
        participantId: 'acme',
      }),
    })
  ).body.secret

  const created = await json('/api/local/v1/instances', {
    method: 'POST',
    headers: { authorization: `ApiKey ${key}`, 'x-actor-ref': 'bench' },
    body: JSON.stringify({
      definition: 'container-weighing@1.0.0',
      participants: {
        shipper: 'did:web:acme-shipping.example',
        weigher: 'did:web:vanmoer.example',
      },
      data: { containerNumber: 'MSCU1234567', terminal: '869' },
    }),
  })
  const instanceId = created.body.instance.id

  await json(`/api/local/v1/instances/${instanceId}/transitions`, {
    method: 'POST',
    headers: { authorization: `ApiKey ${key}`, 'x-actor-ref': 'bench', 'if-match': '"1"' },
    body: JSON.stringify({ transition: 'announceTruck', patch: { truckPlate: '1-ABC-123' } }),
  })

  const firstTransactionMs = ms(transactionStarted)

  // A few hundred transitions, to see whether memory is stable rather than
  // merely small at boot.
  const loopStarted = process.hrtime.bigint()
  let seq = 2
  const rounds = 200
  for (let i = 0; i < rounds; i += 1) {
    const instance = await json('/api/local/v1/instances', {
      method: 'POST',
      headers: { authorization: `ApiKey ${key}`, 'x-actor-ref': 'bench' },
      body: JSON.stringify({
        definition: 'container-weighing@1.0.0',
        participants: {
          shipper: 'did:web:acme-shipping.example',
          weigher: 'did:web:vanmoer.example',
        },
        data: { containerNumber: 'MSCU1234567', terminal: '869' },
      }),
    })
    await json(`/api/local/v1/instances/${instance.body.instance.id}/transitions`, {
      method: 'POST',
      headers: { authorization: `ApiKey ${key}`, 'x-actor-ref': 'bench', 'if-match': '"1"' },
      body: JSON.stringify({ transition: 'announceTruck', patch: { truckPlate: '1-ABC-123' } }),
    })
  }
  void seq
  const perTransitionMs = ms(loopStarted) / (rounds * 2)

  const rss = residentMb(child.pid)

  const rows = [
    ['store adapter', storeArg],
    ['containers', '1 (0 databases)'],
    ['cold start', `${coldStartMs.toFixed(0)} ms`],
    ['time to first transaction', `${firstTransactionMs.toFixed(0)} ms (from a cold connector)`],
    ['resident memory', rss === undefined ? 'unavailable' : `${rss} MB`],
    ['target', '< 150 MB'],
    ['verdict', rss === undefined ? 'unknown' : rss < 150 ? 'within target' : 'OVER TARGET'],
    ['instances written', String(rounds + 1)],
    ['mean write latency', `${perTransitionMs.toFixed(2)} ms`],
  ]

  const width = Math.max(...rows.map(([label]) => label.length))
  process.stdout.write('\nconnector bench\n')
  process.stdout.write(`${'─'.repeat(width + 34)}\n`)
  for (const [label, value] of rows) {
    process.stdout.write(`${label.padEnd(width)}  ${value}\n`)
  }
  process.stdout.write('\n')

  if (rss !== undefined && rss >= 150) process.exitCode = 1
} finally {
  child.kill('SIGTERM')
  await new Promise((r) => setTimeout(r, 200))
  child.kill('SIGKILL')
  rmSync(dataDir, { recursive: true, force: true })
}
