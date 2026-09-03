import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import type { ParticipantConfig } from '../src/config/config.js'
import { loadConfig } from '../src/config/config.js'
import { Identity } from '../src/identity/identity.service.js'
import { chooseSecretStore } from '../src/runtime.js'
import { EnvSecretStore, FileSecretStore, MemorySecretStore } from '../src/secrets/secret-store.js'

const ORG_A: ParticipantConfig = {
  id: 'org-a',
  did: 'did:web:org-a.example',
  displayName: 'Org A',
  baseUrl: 'https://org-a.example',
}
const ORG_B: ParticipantConfig = {
  id: 'org-b',
  did: 'did:web:org-b.example',
  displayName: 'Org B',
  baseUrl: 'https://org-b.example',
}

const directories: string[] = []
afterAll(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true })
})

function tempFile(name = 'secrets.json'): string {
  const directory = mkdtempSync(join(tmpdir(), 'pilots-secrets-'))
  directories.push(directory)
  return join(directory, name)
}

describe('first boot generates what it needs', () => {
  it('generates a key per participant and an API-key pepper', async () => {
    const secrets = new MemorySecretStore()
    const identity = await Identity.bootstrap([ORG_A, ORG_B], secrets)

    expect(identity.report.generatedKeysFor).toEqual(['org-a', 'org-b'])
    expect(identity.report.generatedPepper).toBe(true)
    expect(identity.pepper).toHaveLength(43)
    expect(await identity.signer.did('org-a')).toBe(ORG_A.did)
    expect(await identity.signer.did('org-b')).toBe(ORG_B.did)
  })

  it('publishes only the public half', async () => {
    const identity = await Identity.bootstrap([ORG_A], new MemorySecretStore())
    const document = await identity.didDocument('org-a')
    expect(JSON.stringify(document)).not.toContain('"d"')
    expect(document.id).toBe(ORG_A.did)
    expect(document.verificationMethod[0]?.publicKeyJwk.kty).toBe('OKP')
  })

  it('serves the first participant at the well-known path', async () => {
    const identity = await Identity.bootstrap([ORG_A, ORG_B], new MemorySecretStore())
    expect((await identity.wellKnownDidDocument()).id).toBe(ORG_A.did)
  })
})

describe('the key survives a restart, so the DID document does not move', () => {
  it('reuses stored keys and reports that it generated nothing', async () => {
    const secrets = new MemorySecretStore()
    const first = await Identity.bootstrap([ORG_A], secrets)
    const firstJwk = await first.signer.publicJwk('org-a')

    const second = await Identity.bootstrap([ORG_A], secrets)
    expect(second.report.generatedKeysFor).toEqual([])
    expect(second.report.generatedPepper).toBe(false)
    expect(await second.signer.publicJwk('org-a')).toEqual(firstJwk)
    expect(second.pepper).toBe(first.pepper)
  })

  it('generates a key for a participant added later, leaving the others alone', async () => {
    const secrets = new MemorySecretStore()
    const first = await Identity.bootstrap([ORG_A], secrets)
    const orgAJwk = await first.signer.publicJwk('org-a')

    const second = await Identity.bootstrap([ORG_A, ORG_B], secrets)
    expect(second.report.generatedKeysFor).toEqual(['org-b'])
    expect(await second.signer.publicJwk('org-a')).toEqual(orgAJwk)
  })

  it('generates a fresh key when a participant’s DID changes, rather than signing under the old one', async () => {
    const secrets = new MemorySecretStore()
    await Identity.bootstrap([ORG_A], secrets)
    const renamed = await Identity.bootstrap(
      [{ ...ORG_A, did: 'did:web:org-a-new.example' }],
      secrets,
    )
    expect(renamed.report.generatedKeysFor).toEqual(['org-a'])
    expect(await renamed.signer.did('org-a')).toBe('did:web:org-a-new.example')
  })
})

describe('FileSecretStore', () => {
  it('persists across a restart and keeps the file private', async () => {
    const path = tempFile()
    const first = await Identity.bootstrap([ORG_A], new FileSecretStore(path))
    const firstJwk = await first.signer.publicJwk('org-a')

    expect(statSync(path).mode & 0o777).toBe(0o600)

    const second = await Identity.bootstrap([ORG_A], new FileSecretStore(path))
    expect(second.report.generatedKeysFor).toEqual([])
    expect(await second.signer.publicJwk('org-a')).toEqual(firstJwk)
  })

  it('writes the private half only to that file — the caller never sees it in a report', async () => {
    const path = tempFile()
    const identity = await Identity.bootstrap([ORG_A], new FileSecretStore(path))
    expect(JSON.stringify(identity.report)).not.toContain('"d"')
    // …and the file itself is the one place it exists.
    expect(readFileSync(path, 'utf8')).toContain('"privateJwk"')
  })
})

describe('EnvSecretStore', () => {
  it('uses secrets the environment supplies', async () => {
    const seeded = await Identity.bootstrap([ORG_A], new MemorySecretStore())
    const keys = await seeded.signer.exportKeys()

    const identity = await Identity.bootstrap(
      [ORG_A],
      new EnvSecretStore({
        PILOTS_SIGNING_KEYS: JSON.stringify(keys),
        PILOTS_API_KEY_PEPPER: 'a-pepper-from-the-secret-manager',
      }),
    )

    expect(identity.report.generatedKeysFor).toEqual([])
    expect(identity.report.ephemeral).toBe(false)
    expect(identity.pepper).toBe('a-pepper-from-the-secret-manager')
    expect(await identity.signer.publicJwk('org-a')).toEqual(await seeded.signer.publicJwk('org-a'))
  })

  it('flags secrets as ephemeral when it had to generate what it cannot write back', async () => {
    const identity = await Identity.bootstrap([ORG_A], new EnvSecretStore({}))
    expect(identity.report.ephemeral).toBe(true)
    expect(identity.report.generatedKeysFor).toEqual(['org-a'])
    // It still works — the connector boots — but the caller is told plainly.
    expect(await identity.signer.did('org-a')).toBe(ORG_A.did)
  })
})

describe('participant lookup', () => {
  it('answers “is this DID one of ours?”, which is how home-node resolution starts', async () => {
    const identity = await Identity.bootstrap([ORG_A, ORG_B], new MemorySecretStore())
    expect(identity.participantByDid(ORG_B.did)?.id).toBe('org-b')
    expect(identity.participantByDid('did:web:stranger.example')).toBeUndefined()
    expect(identity.dids).toEqual([ORG_A.did, ORG_B.did])
  })
})

/**
 * Which secret store a connector picks, and why it is not the document store's
 * business.
 *
 * This is a regression test with a scar. The choice used to read
 * `adapter === 'file' ? file : memory`, so the **managed document-store
 * profile** — the large party, the one most likely to restart — silently kept
 * its signing key in memory. Every restart minted a new key, republished a new
 * DID document, and left every event it had ever signed unverifiable. Nothing
 * failed loudly; the connector came up looking healthy and its own log stopped
 * verifying.
 *
 * The rule is durability, not adapter: memory only where the whole process is
 * ephemeral by construction.
 */
describe('the signing key survives a restart on every durable store', () => {
  const base = {
    PILOTS_PARTICIPANT_ID: 'org-a',
    PILOTS_PARTICIPANT_DID: ORG_A.did,
    PILOTS_BASE_URL: ORG_A.baseUrl,
    PILOTS_DEFINITIONS_DIR: '../../docs/definitions',
    NODE_ENV: 'test',
    PILOTS_STORE_DIR: '/data',
  }

  it('persists the key on every durable store, memory only on the ephemeral one', () => {
    expect(chooseSecretStore(loadConfig({ ...base, PILOTS_STORE: 'file' }))).toBeInstanceOf(
      FileSecretStore,
    )
    // The regression this test exists for: the choice used to read
    // `adapter === 'file'`, so the *managed* profile — the large party, the one
    // most likely to restart — kept its signing key in memory.
    expect(
      chooseSecretStore(
        loadConfig({ ...base, PILOTS_STORE: 'mongo', PILOTS_MONGO_URI: 'mongodb://db:27017' }),
      ),
    ).toBeInstanceOf(FileSecretStore)
    expect(chooseSecretStore(loadConfig({ ...base, PILOTS_STORE: 'memory' }))).toBeInstanceOf(
      MemorySecretStore,
    )
  })

  it('comes back as the same participant, not a new one', async () => {
    const path = tempFile()
    const before = await Identity.bootstrap([ORG_A], new FileSecretStore(path))
    const beforeDoc = await before.didDocument('org-a')

    // A restart: a new process, the same configured secrets file.
    const after = await Identity.bootstrap([ORG_A], new FileSecretStore(path))

    expect(after.report.generatedKeysFor).toEqual([])
    expect(await after.didDocument('org-a')).toEqual(beforeDoc)
    expect(after.pepper).toEqual(before.pepper)
  })
})
