/**
 * The `Signer` port.
 *
 * Deliberately at the level a *remote* signer can implement: "sign exactly these
 * bytes with this participant's key", plus the two identifiers a verifier needs.
 * A KMS or an HSM offers that and nothing more — it does not offer "produce a
 * compact JWS" — so putting JWS assembly behind the port would make the one
 * implementation we care about impossible to write.
 *
 * JWS assembly therefore lives in `crypto/jws.ts`, in this package, where it is
 * specified and tested once. See docs/PROTOCOL.md §2.4.
 *
 * The connector is the only component that ever holds a key. An integrator never
 * signs anything, which is why the local API relays rather than letting clients
 * address peers directly.
 */
export interface Signer {
  /** The DID of the participant this signer signs for. */
  did(participantId: string): Promise<string>
  /** The DID URL of the verification method, e.g. `did:web:org-a.example#key-1`. */
  keyId(participantId: string): Promise<string>
  /** A raw EdDSA (Ed25519) signature over exactly the bytes given. */
  sign(participantId: string, signingInput: Uint8Array): Promise<Uint8Array>
}

/** Thrown when a signer is asked for a participant it does not hold a key for. */
export class UnknownParticipantError extends Error {
  constructor(readonly participantId: string) {
    super(`no signing key for participant ${JSON.stringify(participantId)}`)
    this.name = 'UnknownParticipantError'
  }
}
