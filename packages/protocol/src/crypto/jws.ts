/**
 * JWS assembly and verification.
 *
 * This lives in the spec package, not behind the `Signer` port, because the port
 * has to be implementable by a KMS or an HSM — and those offer "sign these
 * bytes", never "produce a JWS". Assembling the compact serialisation here means
 * one implementation, specified and tested once, whatever holds the key.
 *
 * Event signatures are **detached** (RFC 7515 Appendix F): the compact form is
 * `<protected>..<signature>`, with the payload left out. The event already
 * carries its header; a second, base64url copy inside the signature would be a
 * copy that could disagree with the first.
 *
 * The crypto itself is jose's. Only the assembly is ours.
 */
import { compactVerify, importJWK } from 'jose'

import { canonicalise } from '../canonical.js'
import type { PublicKeyJwk } from '../ports/did-resolver.js'
import type { Signer } from '../ports/signer.js'

export type JwsProtectedHeader = {
  alg: 'EdDSA'
  kid: string
}

const utf8 = new TextEncoder()

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url')
}

function fromBase64url(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64url'))
}

/**
 * The bytes a JWS signature is actually taken over:
 * `base64url(protected) . base64url(payload)`, as ASCII.
 */
function signingInput(protectedB64: string, payloadB64: string): Uint8Array {
  return utf8.encode(`${protectedB64}.${payloadB64}`)
}

/** Sign `payload`, returning `<protected>..<signature>`. */
export async function signDetachedJws(
  signer: Signer,
  participantId: string,
  payload: Uint8Array,
): Promise<string> {
  const kid = await signer.keyId(participantId)
  const header: JwsProtectedHeader = { alg: 'EdDSA', kid }
  // Canonicalised so that two implementations signing the same header produce
  // byte-identical signing input.
  const protectedB64 = base64url(utf8.encode(canonicalise(header)))
  const payloadB64 = base64url(payload)
  const signature = await signer.sign(participantId, signingInput(protectedB64, payloadB64))
  return `${protectedB64}..${base64url(signature)}`
}

/** Read the protected header of a compact JWS without verifying it. */
export function protectedHeaderOf(jws: string): JwsProtectedHeader {
  const protectedB64 = jws.split('.')[0]
  if (!protectedB64) throw new TypeError('not a compact JWS: no protected header')
  const parsed: unknown = JSON.parse(Buffer.from(protectedB64, 'base64url').toString('utf8'))
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    (parsed as { alg?: unknown }).alg !== 'EdDSA' ||
    typeof (parsed as { kid?: unknown }).kid !== 'string'
  ) {
    throw new TypeError('unsupported JWS header: expected { alg: "EdDSA", kid: string }')
  }
  return parsed as JwsProtectedHeader
}

/**
 * Verify a detached signature over `payload`.
 *
 * Returns `false` for a signature that simply does not verify — a tampered
 * event is an expected outcome here, not an exception. It throws only when the
 * input is not a detached JWS at all, which is a programming error.
 */
export async function verifyDetachedJws(
  jws: string,
  payload: Uint8Array,
  publicKeyJwk: PublicKeyJwk,
): Promise<boolean> {
  const parts = jws.split('.')
  if (parts.length !== 3) throw new TypeError('not a compact JWS')
  const [protectedB64, middle, signatureB64] = parts
  if (middle !== '') throw new TypeError('expected a detached JWS: <protected>..<signature>')
  if (!protectedB64 || !signatureB64) throw new TypeError('not a compact JWS')

  const reattached = `${protectedB64}.${base64url(payload)}.${signatureB64}`
  try {
    const key = await importJWK({ ...publicKeyJwk, alg: 'EdDSA' }, 'EdDSA')
    await compactVerify(reattached, key, { algorithms: ['EdDSA'] })
    return true
  } catch {
    return false
  }
}

export const jwsInternals = { base64url, fromBase64url, signingInput }
