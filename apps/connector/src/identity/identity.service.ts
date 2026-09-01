/**
 * Identity: the signing keys, the DID documents, and the API-key pepper.
 *
 * On first boot this generates an Ed25519 key per configured participant and an
 * API-key pepper, writes them to the secret store, and publishes the public
 * halves at `/.well-known/did.json`. No human, repository or pipeline variable
 * ever handles a private key.
 *
 * Cheap here; awkward to retrofit once a deployment exists — which is why it is
 * an M2 item rather than an M7 one.
 */
import { randomBytes } from 'node:crypto'

import {
  LocalEd25519Signer,
  buildDidDocument,
  type DidDocument,
  type ParticipantKey,
  type Signer,
} from '@pilots/protocol'

import type { ParticipantConfig } from '../config/config.js'
import type { SecretStore } from '../secrets/secret-store.js'

export interface IdentityBootstrapReport {
  /** Participants whose key was generated during this boot. */
  generatedKeysFor: string[]
  generatedPepper: boolean
  /** True when secrets had to be generated but cannot be persisted. */
  ephemeral: boolean
  secretStore: string
}

export class Identity {
  private constructor(
    readonly signer: LocalEd25519Signer,
    readonly pepper: string,
    private readonly participants: readonly ParticipantConfig[],
    readonly report: IdentityBootstrapReport,
  ) {}

  static async bootstrap(
    participants: readonly ParticipantConfig[],
    secrets: SecretStore,
  ): Promise<Identity> {
    const stored = await secrets.load()
    const signingKeys: Record<string, ParticipantKey> = { ...stored.signingKeys }
    const generatedKeysFor: string[] = []

    for (const participant of participants) {
      const existing = signingKeys[participant.id]
      if (existing && existing.did === participant.did) continue
      // A configured DID that no longer matches the stored key is a new
      // participant as far as identity is concerned: generate, do not reuse.
      const fresh = await LocalEd25519Signer.generate({
        [participant.id]: { did: participant.did },
      })
      const exported = await fresh.exportKeys()
      signingKeys[participant.id] = exported[participant.id]!
      generatedKeysFor.push(participant.id)
    }

    const generatedPepper = stored.apiKeyPepper === undefined
    const apiKeyPepper = stored.apiKeyPepper ?? randomBytes(32).toString('base64url')

    const changed = generatedKeysFor.length > 0 || generatedPepper
    if (changed && secrets.persistable) {
      await secrets.save({ signingKeys, apiKeyPepper })
    }

    return new Identity(
      await LocalEd25519Signer.fromKeys(signingKeys),
      apiKeyPepper,
      participants,
      {
        generatedKeysFor,
        generatedPepper,
        ephemeral: changed && !secrets.persistable,
        secretStore: secrets.describe(),
      },
    )
  }

  asSigner(): Signer {
    return this.signer
  }

  participant(participantId: string): ParticipantConfig | undefined {
    return this.participants.find((p) => p.id === participantId)
  }

  /** The local participant holding this DID, if any. This is how "are we the home node?" is answered. */
  participantByDid(did: string): ParticipantConfig | undefined {
    return this.participants.find((p) => p.did === did)
  }

  get all(): readonly ParticipantConfig[] {
    return this.participants
  }

  get dids(): string[] {
    return this.participants.map((p) => p.did)
  }

  /** The static document a participant publishes. Public halves only. */
  async didDocument(participantId: string): Promise<DidDocument> {
    return this.signer.didDocument(participantId)
  }

  /**
   * The document served at `/.well-known/did.json`.
   *
   * With one participant this is its document. With several, the well-known path
   * belongs to the first and the rest are addressed by `did:web` path segments —
   * which is what makes a hosted tenant's DID real and resolvable rather than a
   * naming convention.
   */
  async wellKnownDidDocument(): Promise<DidDocument> {
    const first = this.participants[0]
    if (!first) throw new Error('no participants configured')
    return this.didDocument(first.id)
  }

  /** Rebuild a DID document from a public key, without touching the private half. */
  static documentFor(did: string, jwk: Parameters<typeof buildDidDocument>[1]): DidDocument {
    return buildDidDocument(did, jwk)
  }
}

export const IDENTITY = Symbol('Identity')
