/**
 * Definitions as runtime records.
 *
 * The boot directory is a seed, not the authority: a definition published at
 * runtime and one read from disk are the same kind of record afterwards, and
 * both come back after a restart. Without that, "author your own process" would
 * mean "author it, then get someone to redeploy the container".
 */
import { Problem, hashJson, type JsonValue } from '@pilots/protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DefinitionRegistry } from '../src/definitions/definition-registry.js'
import { definitionDocumentOf } from '../src/definitions/definition-store.js'
import { DEFINITIONS_DIR, ORG_A, ORG_B } from './helpers/core.js'
import { buildTestApp, provision, type TestApp } from './helpers/app.js'

const AT = '2026-09-04T10:00:00.000Z'

/** A minimal valid definition, so a test is not hostage to a shipped one. */
function minimal(overrides: Record<string, JsonValue> = {}): JsonValue {
  return {
    '@context': 'https://pilots.example/process/v1',
    id: 'authored',
    version: '1.0.0',
    kind: 'service',
    title: 'Authored here',
    roles: [
      { id: 'buyer', title: 'Buyer', cardinality: 1, protocolRole: 'requester' },
      { id: 'seller', title: 'Seller', cardinality: 1, protocolRole: 'provider' },
    ],
    hostedBy: 'seller',
    initialState: 'OPEN',
    states: [
      { id: 'OPEN', title: 'Open' },
      { id: 'CLOSED', title: 'Closed', outcome: 'fulfilled' },
      { id: 'DROPPED', title: 'Dropped', outcome: 'abandoned' },
    ],
    data: { type: 'object' },
    transitions: [
      { id: 'close', title: 'Close', from: ['OPEN'], to: 'CLOSED', by: ['seller'] },
      { id: 'drop', title: 'Drop', from: ['*'], to: 'DROPPED', by: ['buyer', 'seller'] },
    ],
    visibility: [],
    links: [],
    ...overrides,
  }
}

describe('a definition held in the store', () => {
  it('is registered when the registry hydrates, so it survives a restart', async () => {
    const registry = await DefinitionRegistry.fromDirectory(DEFINITIONS_DIR)
    expect(registry.has('authored@1.0.0')).toBe(false)

    const registered = DefinitionRegistry.register(minimal(), 'local')
    const document = definitionDocumentOf('org-a', registered, 'local', null, AT)
    expect(registry.hydrate([document])).toEqual([])

    expect(registry.has('authored@1.0.0')).toBe(true)
    expect(registry.get('authored@1.0.0')?.contentHash).toBe(hashJson(minimal()))
  })

  it('keeps the definitions read from disk alongside it', async () => {
    const registry = await DefinitionRegistry.fromDirectory(DEFINITIONS_DIR)
    registry.hydrate([
      definitionDocumentOf(
        'org-a',
        DefinitionRegistry.register(minimal(), 'local'),
        'local',
        null,
        AT,
      ),
    ])

    expect(registry.has('container-weighing@1.0.0')).toBe(true)
    expect(registry.has('authored@1.0.0')).toBe(true)
  })

  it('reports a stored definition a newer lint rule refuses, rather than failing to boot', async () => {
    const registry = await DefinitionRegistry.fromDirectory(DEFINITIONS_DIR)

    // Stored before the rule existed; the connector must still start.
    const refused = registry.hydrate([
      { ref: 'broken@1.0.0', raw: { id: 'broken', version: '1.0.0' } },
    ])

    expect(refused).toHaveLength(1)
    expect(registry.has('broken@1.0.0')).toBe(false)
  })

  it('hashes the document as read, so parsing defaults cannot change the hash', () => {
    // `auto` and `defaultVisibility` are defaulted by the parser. Hashing the
    // parsed value would give two connectors holding one file two hashes.
    const withoutDefaults = DefinitionRegistry.register(minimal(), 'a')
    expect(withoutDefaults.contentHash).toBe(hashJson(minimal()))
  })
})

describe('publishing over the local API', () => {
  let app: TestApp
  let key: string

  beforeEach(async () => {
    app = await buildTestApp()
    const orgA = await provision(app, 'org-a')
    key = orgA.apiKey
  })

  afterEach(async () => {
    await app.close()
  })

  const headers = (apiKey = key) => ({
    authorization: `ApiKey ${apiKey}`,
    'x-actor-ref': 'author@org-a.example',
    'content-type': 'application/json',
  })

  const post = (url: string, payload: Record<string, unknown>, apiKey?: string) =>
    app.app.inject({ method: 'POST', url, headers: headers(apiKey), payload })

  it('lints a broken definition without storing anything, and answers 200', async () => {
    const before = await app.runtime.store.definitions.count('org-a')

    /*
     * Valid as a document, unrunnable as a process: nothing reaches a fulfilled
     * state. This is the class of mistake the graph rules exist for, and it is
     * invisible to schema validation.
     */
    const response = await post('/api/local/v1/definitions/lint', {
      definition: minimal({
        states: [
          { id: 'OPEN', title: 'Open' },
          { id: 'DROPPED', title: 'Dropped', outcome: 'abandoned' },
        ],
        transitions: [{ id: 'drop', title: 'Drop', from: ['OPEN'], to: 'DROPPED', by: ['buyer'] }],
      }),
    })

    // 200 whatever the verdict: the diagnostics are the answer, not an error.
    expect(response.statusCode).toBe(200)
    const body = response.json<{
      ok: boolean
      diagnostics: Array<{ code: string; path: string }>
    }>()
    expect(body.ok).toBe(false)
    expect(body.diagnostics.map((one) => one.code)).toContain('no-fulfilled-path')
    // Every diagnostic points at a node, so an editor can highlight it.
    for (const diagnostic of body.diagnostics) expect(diagnostic.path).toMatch(/^\//)

    expect(await app.runtime.store.definitions.count('org-a')).toBe(before)
  })

  it('refuses to publish a definition with errors', async () => {
    const response = await post('/api/local/v1/definitions', {
      definition: minimal({
        states: [
          { id: 'OPEN', title: 'Open' },
          { id: 'DROPPED', title: 'Dropped', outcome: 'abandoned' },
        ],
        transitions: [{ id: 'drop', title: 'Drop', from: ['OPEN'], to: 'DROPPED', by: ['buyer'] }],
      }),
    })
    expect(response.statusCode).toBe(422)
    expect(response.json<{ type: string }>().type).toBe(Problem.definitionInvalid)
  })

  it('publishes a valid definition and makes it usable immediately', async () => {
    const published = await post('/api/local/v1/definitions', { definition: minimal() })
    expect(published.statusCode).toBe(201)
    expect(published.json<{ ref: string }>().ref).toBe('authored@1.0.0')

    // The point of the whole milestone: authored, then run, with no redeploy.
    const created = await post('/api/local/v1/instances', {
      definition: 'authored@1.0.0',
      participants: { buyer: ORG_A.did, seller: ORG_B.did },
      data: {},
    })
    expect(created.statusCode).toBe(201)
  })

  it('is idempotent for identical bytes', async () => {
    await post('/api/local/v1/definitions', { definition: minimal() })
    const again = await post('/api/local/v1/definitions', { definition: minimal() })

    expect(again.statusCode).toBe(200)
    expect(again.json<{ created: boolean }>().created).toBe(false)
  })

  it('refuses different bytes under the same id@version', async () => {
    await post('/api/local/v1/definitions', { definition: minimal() })
    const conflicting = await post('/api/local/v1/definitions', {
      definition: minimal({ title: 'Renamed, same version' }),
    })

    // A version is an identity, not a label.
    expect(conflicting.statusCode).toBe(409)
    expect(conflicting.json<{ type: string }>().type).toBe(Problem.definitionConflict)
  })

  it('refuses a key that may read definitions but not write them', async () => {
    const readOnly = await app.runtime.apiKeys.mint({
      participantId: 'org-a',
      label: 'read only',
      scopes: ['definitions:read', 'instances:read'],
      createdBy: 'test',
    })

    const response = await post(
      '/api/local/v1/definitions',
      { definition: minimal() },
      readOnly.secret,
    )
    expect(response.statusCode).toBe(403)
  })

  it('records the publication in the audit log', async () => {
    await post('/api/local/v1/definitions', { definition: minimal() })
    const entries = await app.runtime.store.audit.read('org-a', 0, 100)
    const published = entries.find((one) => one.action === 'definition.publish')

    expect(published?.outcome).toBe('ok')
    expect(published?.actor.actorRef).toBe('author@org-a.example')
  })
})
