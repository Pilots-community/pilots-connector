/**
 * The default `Signer`: a local Ed25519 key per participant.
 *
 * The key is **generated**, never typed, committed or passed through a pipeline
 * variable. In tests it is generated at setup; in the connector it is generated
 * on first boot, with the private half written to the configured secret store
 * and the public half published in `did.json`. That makes "no private key in the
 * repository" structurally true rather than a rule to remember.
 */
import { webcrypto } from 'node:crypto'

import { DidDocument, PublicKeyJwk } from '../ports/did-resolver.js'
import { UnknownParticipantError, type Signer } from '../ports/signer.js'

const DEFAULT_KEY_FRAGMENT = 'key-1'

/** A participant's key material, in the shape a secret store round-trips. */
export interface ParticipantKey {
  did: string
  keyFragment: string
  /** The private JWK. Never logged, never published, never committed. */
  privateJwk: Record<string, unknown>
  publicJwk: PublicKeyJwk
}

export interface GenerateSpec {
  did: string
  keyFragment?: string
}

function toPublicJwk(jwk: webcrypto.JsonWebKey): PublicKeyJwk {
  // Node stamps `alg: "Ed25519"` and `key_ops` onto exported JWKs. A DID
  // document should carry the key and nothing else.
  return PublicKeyJwk.parse({ kty: jwk.kty, crv: jwk.crv, x: jwk.x })
}

export class LocalEd25519Signer implements Signer {
  private constructor(private readonly keys: Map<string, ParticipantKey>) {}

  /** Generate a fresh key for each named participant. */
  static async generate(
    participants: Record<string, GenerateSpec | string>,
  ): Promise<LocalEd25519Signer> {
    const keys = new Map<string, ParticipantKey>()
    for (const [participantId, spec] of Object.entries(participants)) {
      const { did, keyFragment = DEFAULT_KEY_FRAGMENT } =
        typeof spec === 'string' ? { did: spec, keyFragment: DEFAULT_KEY_FRAGMENT } : spec
      const pair = (await webcrypto.subtle.generateKey('Ed25519', true, [
        'sign',
        'verify',
      ])) as webcrypto.CryptoKeyPair
      keys.set(participantId, {
        did,
        keyFragment,
        privateJwk: (await webcrypto.subtle.exportKey('jwk', pair.privateKey)) as Record<
          string,
          unknown
        >,
        publicJwk: toPublicJwk(await webcrypto.subtle.exportKey('jwk', pair.publicKey)),
      })
    }
    return new LocalEd25519Signer(keys)
  }

  /** Restore from previously exported key material — what a connector does on its second boot. */
  static async fromKeys(keys: Record<string, ParticipantKey>): Promise<LocalEd25519Signer> {
    return new LocalEd25519Signer(new Map(Object.entries(keys)))
  }

  /** The key material, for handing to a secret store. Contains private halves. */
  async exportKeys(): Promise<Record<string, ParticipantKey>> {
    return Object.fromEntries(this.keys)
  }

  private keyFor(participantId: string): ParticipantKey {
    const key = this.keys.get(participantId)
    if (!key) throw new UnknownParticipantError(participantId)
    return key
  }

  async did(participantId: string): Promise<string> {
    return this.keyFor(participantId).did
  }

  async keyId(participantId: string): Promise<string> {
    const key = this.keyFor(participantId)
    return `${key.did}#${key.keyFragment}`
  }

  async sign(participantId: string, signingInput: Uint8Array): Promise<Uint8Array> {
    const key = this.keyFor(participantId)
    const privateKey = await webcrypto.subtle.importKey(
      'jwk',
      key.privateJwk as webcrypto.JsonWebKey,
      'Ed25519',
      false,
      ['sign'],
    )
    const signature = await webcrypto.subtle.sign(
      'Ed25519',
      privateKey,
      new Uint8Array(signingInput),
    )
    return new Uint8Array(signature)
  }

  /** The document to publish at `/.well-known/did.json`. Public halves only. */
  async didDocument(participantId: string): Promise<DidDocument> {
    const key = this.keyFor(participantId)
    return buildDidDocument(key.did, key.publicJwk, key.keyFragment)
  }

  async publicJwk(participantId: string): Promise<PublicKeyJwk> {
    return this.keyFor(participantId).publicJwk
  }
}

/**
 * Build the static document a participant publishes over ordinary HTTPS. That
 * one file, plus accepting one connection request, is the whole of onboarding.
 */
export function buildDidDocument(
  did: string,
  publicKeyJwk: PublicKeyJwk,
  keyFragment = DEFAULT_KEY_FRAGMENT,
): DidDocument {
  const id = `${did}#${keyFragment}`
  return DidDocument.parse({
    '@context': ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/suites/jws-2020/v1'],
    id: did,
    verificationMethod: [{ id, type: 'JsonWebKey2020', controller: did, publicKeyJwk }],
    authentication: [id],
    assertionMethod: [id],
  })
}
