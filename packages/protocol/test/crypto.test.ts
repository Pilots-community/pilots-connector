import { describe, expect, it } from 'vitest'

import { canonicalBytes } from '../src/canonical.js'
import { buildDidDocument, LocalEd25519Signer } from '../src/crypto/local-signer.js'
import { protectedHeaderOf, signDetachedJws, verifyDetachedJws } from '../src/crypto/jws.js'
import {
  didWebOrigin,
  didWebUrl,
  findVerificationMethod,
  staticDidResolver,
} from '../src/ports/did-resolver.js'

const ACME = 'did:web:acme-shipping.example'

async function acmeSigner() {
  return LocalEd25519Signer.generate({ acme: { did: ACME } })
}

describe('LocalEd25519Signer', () => {
  it('generates a key per participant and reports its did and kid', async () => {
    const signer = await acmeSigner()
    expect(await signer.did('acme')).toBe(ACME)
    expect(await signer.keyId('acme')).toBe(`${ACME}#key-1`)
  })

  it('refuses to sign for a participant it holds no key for', async () => {
    const signer = await acmeSigner()
    await expect(signer.sign('vanmoer', new Uint8Array([1]))).rejects.toThrow(/no signing key/)
  })

  it('never exposes the private half in the DID document it publishes', async () => {
    const signer = await acmeSigner()
    const document = await signer.didDocument('acme')
    expect(JSON.stringify(document)).not.toContain('"d"')
    expect(document.verificationMethod[0]?.publicKeyJwk).toEqual({
      kty: 'OKP',
      crv: 'Ed25519',
      x: expect.any(String),
    })
    expect(document.id).toBe(ACME)
    expect(document.assertionMethod).toEqual([`${ACME}#key-1`])
  })

  it('round-trips through an exported and re-imported key set', async () => {
    const signer = await acmeSigner()
    const exported = await signer.exportKeys()
    const restored = await LocalEd25519Signer.fromKeys(exported)
    const payload = canonicalBytes({ hello: 'world' })
    const sig = await signDetachedJws(signer, 'acme', payload)
    const document = await restored.didDocument('acme')
    const method = findVerificationMethod(document, `${ACME}#key-1`)!
    await expect(verifyDetachedJws(sig, payload, method.publicKeyJwk)).resolves.toBe(true)
  })
})

describe('detached compact JWS', () => {
  it('has the shape <protected>..<signature> — the payload is not repeated', async () => {
    const signer = await acmeSigner()
    const sig = await signDetachedJws(signer, 'acme', canonicalBytes({ a: 1 }))
    const parts = sig.split('.')
    expect(parts).toHaveLength(3)
    expect(parts[1]).toBe('')
  })

  it('names the key it was signed with, so a verifier knows what to resolve', async () => {
    const signer = await acmeSigner()
    const sig = await signDetachedJws(signer, 'acme', canonicalBytes({ a: 1 }))
    expect(protectedHeaderOf(sig)).toEqual({ alg: 'EdDSA', kid: `${ACME}#key-1` })
  })

  it('verifies against the published public key', async () => {
    const signer = await acmeSigner()
    const payload = canonicalBytes({ a: 1, b: 'two' })
    const sig = await signDetachedJws(signer, 'acme', payload)
    const jwk = (await signer.didDocument('acme')).verificationMethod[0]!.publicKeyJwk
    await expect(verifyDetachedJws(sig, payload, jwk)).resolves.toBe(true)
  })

  it('fails when the payload changed by a single byte', async () => {
    const signer = await acmeSigner()
    const sig = await signDetachedJws(signer, 'acme', canonicalBytes({ a: 1 }))
    const jwk = (await signer.didDocument('acme')).verificationMethod[0]!.publicKeyJwk
    await expect(verifyDetachedJws(sig, canonicalBytes({ a: 2 }), jwk)).resolves.toBe(false)
  })

  it('fails against a different participant’s key', async () => {
    const signer = await acmeSigner()
    const other = await LocalEd25519Signer.generate({ vanmoer: { did: 'did:web:vanmoer.example' } })
    const payload = canonicalBytes({ a: 1 })
    const sig = await signDetachedJws(signer, 'acme', payload)
    const otherJwk = (await other.didDocument('vanmoer')).verificationMethod[0]!.publicKeyJwk
    await expect(verifyDetachedJws(sig, payload, otherJwk)).resolves.toBe(false)
  })

  it('rejects a signature that is not detached', async () => {
    await expect(
      verifyDetachedJws('eyJhbGciOiJFZERTQSJ9.cGF5bG9hZA.c2ln', new Uint8Array(), {
        kty: 'OKP',
        crv: 'Ed25519',
        x: 'x',
      }),
    ).rejects.toThrow(/detached/i)
  })
})

describe('buildDidDocument', () => {
  it('produces a document a resolver can serve verbatim', async () => {
    const signer = await acmeSigner()
    const jwk = (await signer.didDocument('acme')).verificationMethod[0]!.publicKeyJwk
    const document = buildDidDocument(ACME, jwk)
    const resolver = staticDidResolver({ [ACME]: document })
    await expect(resolver.resolve(ACME)).resolves.toEqual(document)
    await expect(resolver.resolve('did:web:nobody.example')).resolves.toBeNull()
  })
})

describe('did:web resolution addresses', () => {
  it.each([
    ['did:web:acme-shipping.example', 'https://acme-shipping.example/.well-known/did.json'],
    ['did:web:connectors.example:t:acme', 'https://connectors.example/t/acme/did.json'],
    ['did:web:example.com%3A8443', 'https://example.com:8443/.well-known/did.json'],
  ])('%s resolves at %s', (did, url) => {
    expect(didWebUrl(did).toString()).toBe(url)
  })

  it('exposes the origin the DID is bound to, for the handshake check', () => {
    expect(didWebOrigin('did:web:connectors.example:t:acme')).toBe('https://connectors.example')
  })

  it('refuses a DID method it cannot resolve', () => {
    expect(() => didWebUrl('did:key:z6Mk')).toThrow(/did:web/)
  })
})
