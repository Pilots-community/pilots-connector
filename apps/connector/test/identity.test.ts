import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import type { ParticipantConfig } from '../src/config/config.js'
import { Identity } from '../src/identity/identity.service.js'
import { EnvSecretStore, FileSecretStore, MemorySecretStore } from '../src/secrets/secret-store.js'

const ACME: ParticipantConfig = {
  id: 'acme',
  did: 'did:web:acme-shipping.example',
  displayName: 'Acme Shipping',
  baseUrl: 'https://acme-shipping.example',
}
const VANMOER: ParticipantConfig = {
  id: 'vanmoer',
  did: 'did:web:vanmoer.example',
  displayName: 'Van Moer',
  baseUrl: 'https://vanmoer.example',
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
    const identity = await Identity.bootstrap([ACME, VANMOER], secrets)

    expect(identity.report.generatedKeysFor).toEqual(['acme', 'vanmoer'])
    expect(identity.report.generatedPepper).toBe(true)
    expect(identity.pepper).toHaveLength(43)
    expect(await identity.signer.did('acme')).toBe(ACME.did)
    expect(await identity.signer.did('vanmoer')).toBe(VANMOER.did)
  })

  it('publishes only the public half', async () => {
    const identity = await Identity.bootstrap([ACME], new MemorySecretStore())
    const document = await identity.didDocument('acme')
    expect(JSON.stringify(document)).not.toContain('"d"')
    expect(document.id).toBe(ACME.did)
    expect(document.verificationMethod[0]?.publicKeyJwk.kty).toBe('OKP')
  })

  it('serves the first participant at the well-known path', async () => {
    const identity = await Identity.bootstrap([ACME, VANMOER], new MemorySecretStore())
    expect((await identity.wellKnownDidDocument()).id).toBe(ACME.did)
  })
})

describe('the key survives a restart, so the DID document does not move', () => {
  it('reuses stored keys and reports that it generated nothing', async () => {
    const secrets = new MemorySecretStore()
    const first = await Identity.bootstrap([ACME], secrets)
    const firstJwk = await first.signer.publicJwk('acme')

    const second = await Identity.bootstrap([ACME], secrets)
    expect(second.report.generatedKeysFor).toEqual([])
    expect(second.report.generatedPepper).toBe(false)
    expect(await second.signer.publicJwk('acme')).toEqual(firstJwk)
    expect(second.pepper).toBe(first.pepper)
  })

  it('generates a key for a participant added later, leaving the others alone', async () => {
    const secrets = new MemorySecretStore()
    const first = await Identity.bootstrap([ACME], secrets)
    const acmeJwk = await first.signer.publicJwk('acme')

    const second = await Identity.bootstrap([ACME, VANMOER], secrets)
    expect(second.report.generatedKeysFor).toEqual(['vanmoer'])
    expect(await second.signer.publicJwk('acme')).toEqual(acmeJwk)
  })

  it('generates a fresh key when a participant’s DID changes, rather than signing under the old one', async () => {
    const secrets = new MemorySecretStore()
    await Identity.bootstrap([ACME], secrets)
    const renamed = await Identity.bootstrap(
      [{ ...ACME, did: 'did:web:acme-new.example' }],
      secrets,
    )
    expect(renamed.report.generatedKeysFor).toEqual(['acme'])
    expect(await renamed.signer.did('acme')).toBe('did:web:acme-new.example')
  })
})

describe('FileSecretStore', () => {
  it('persists across a restart and keeps the file private', async () => {
    const path = tempFile()
    const first = await Identity.bootstrap([ACME], new FileSecretStore(path))
    const firstJwk = await first.signer.publicJwk('acme')

    expect(statSync(path).mode & 0o777).toBe(0o600)

    const second = await Identity.bootstrap([ACME], new FileSecretStore(path))
    expect(second.report.generatedKeysFor).toEqual([])
    expect(await second.signer.publicJwk('acme')).toEqual(firstJwk)
  })

  it('writes the private half only to that file — the caller never sees it in a report', async () => {
    const path = tempFile()
    const identity = await Identity.bootstrap([ACME], new FileSecretStore(path))
    expect(JSON.stringify(identity.report)).not.toContain('"d"')
    // …and the file itself is the one place it exists.
    expect(readFileSync(path, 'utf8')).toContain('"privateJwk"')
  })
})

describe('EnvSecretStore', () => {
  it('uses secrets the environment supplies', async () => {
    const seeded = await Identity.bootstrap([ACME], new MemorySecretStore())
    const keys = await seeded.signer.exportKeys()

    const identity = await Identity.bootstrap(
      [ACME],
      new EnvSecretStore({
        PILOTS_SIGNING_KEYS: JSON.stringify(keys),
        PILOTS_API_KEY_PEPPER: 'a-pepper-from-the-secret-manager',
      }),
    )

    expect(identity.report.generatedKeysFor).toEqual([])
    expect(identity.report.ephemeral).toBe(false)
    expect(identity.pepper).toBe('a-pepper-from-the-secret-manager')
    expect(await identity.signer.publicJwk('acme')).toEqual(await seeded.signer.publicJwk('acme'))
  })

  it('flags secrets as ephemeral when it had to generate what it cannot write back', async () => {
    const identity = await Identity.bootstrap([ACME], new EnvSecretStore({}))
    expect(identity.report.ephemeral).toBe(true)
    expect(identity.report.generatedKeysFor).toEqual(['acme'])
    // It still works — the connector boots — but the caller is told plainly.
    expect(await identity.signer.did('acme')).toBe(ACME.did)
  })
})

describe('participant lookup', () => {
  it('answers “is this DID one of ours?”, which is how home-node resolution starts', async () => {
    const identity = await Identity.bootstrap([ACME, VANMOER], new MemorySecretStore())
    expect(identity.participantByDid(VANMOER.did)?.id).toBe('vanmoer')
    expect(identity.participantByDid('did:web:stranger.example')).toBeUndefined()
    expect(identity.dids).toEqual([ACME.did, VANMOER.did])
  })
})
