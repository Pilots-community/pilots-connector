/**
 * Node-to-node bearer tokens.
 *
 * Every cross-connector request carries one. It authenticates **the call**, not
 * the process — which is why it can be short-lived without anything expiring in
 * the middle of a business process that runs for days. See docs/PROTOCOL.md §2.1.
 *
 * This is in the spec package because both sides must agree on it exactly: the
 * claim set, the lifetime ceiling, and what "replayed" means. A connector that
 * invented its own would be unable to talk to anyone.
 *
 * Note what a peer token is *not*: it is not a session, not a negotiation, and
 * not something an integrator ever sees. The connector is the only component
 * that holds a key, so the connector is the only component that mints one.
 */
import { z } from 'zod'

import { canonicalBytes } from '../canonical.js'
import { err, ok, type Result } from '../result.js'
import { findVerificationMethod, type DidResolver } from '../ports/did-resolver.js'
import type { Signer } from '../ports/signer.js'
import { protectedHeaderOf, signCompactJws, verifyDetachedJws } from './jws.js'
import { Did } from '../schemas/common.js'

/** The `typ` header, so a peer token can never be mistaken for an event signature. */
export const PEER_TOKEN_TYP = 'JWT'

/**
 * Five minutes. Long enough to absorb clock skew between two connectors nobody
 * administers together, short enough that a stolen token is worthless quickly.
 */
export const PEER_TOKEN_TTL_SECONDS = 300

/**
 * Tolerated clock skew, each way. Two connectors run on machines with no shared
 * time source; refusing a token because a peer's clock is two seconds fast would
 * be an outage caused by pedantry.
 */
export const PEER_TOKEN_SKEW_SECONDS = 60

export const PeerTokenClaims = z.strictObject({
  /** The calling participant's DID. */
  iss: Did,
  /** The DID of the participant being called. A token for one peer is useless at another. */
  aud: Did,
  iat: z.int().min(0),
  exp: z.int().min(0),
  /** Unique per token. The receiver rejects a repeat. */
  jti: z.string().min(1).max(255),
})
export type PeerTokenClaims = z.infer<typeof PeerTokenClaims>

export async function signPeerToken(
  signer: Signer,
  participantId: string,
  options: { iss: string; aud: string; jti: string; nowMs: number; ttlSeconds?: number },
): Promise<string> {
  const iat = Math.floor(options.nowMs / 1000)
  const claims: PeerTokenClaims = {
    iss: options.iss,
    aud: options.aud,
    iat,
    exp: iat + (options.ttlSeconds ?? PEER_TOKEN_TTL_SECONDS),
    jti: options.jti,
  }
  return signCompactJws(signer, participantId, canonicalBytes(claims), PEER_TOKEN_TYP)
}

/**
 * Why a token was refused.
 *
 * Named rather than collapsed into one boolean because the audit log records
 * this: "an unknown peer called" and "a known peer replayed a token" are
 * different operational events, and only the log can tell them apart.
 */
export type PeerTokenRejection =
  | 'malformed'
  | 'wrong-type'
  | 'issuer-unresolvable'
  | 'key-unknown'
  | 'signature-invalid'
  | 'issuer-mismatch'
  | 'audience-mismatch'
  | 'expired'
  | 'not-yet-valid'
  | 'lifetime-too-long'
  | 'replayed'

export interface PeerTokenFailure {
  reason: PeerTokenRejection
  detail: string
  /** The claimed issuer, when it could be read at all. Audited even on failure. */
  iss: string | null
  jti: string | null
}

export interface VerifyPeerTokenOptions {
  resolver: DidResolver
  /** Our own DID. A token whose `aud` is somebody else is refused, not forwarded. */
  audience: string
  nowMs: number
  /**
   * Record the token and report whether it had been seen before. Supplied by the
   * caller because replay state is storage, not specification — but the check
   * is specified, so it is not optional.
   *
   * The **issuer** is passed alongside the `jti`: two peers picking the same
   * random id must not be able to cancel each other's calls, so the identity a
   * `jti` is unique within is the issuer, not the receiver.
   */
  seenJti: (token: {
    jti: string
    iss: string
    expEpochSeconds: number
  }) => boolean | Promise<boolean>
  maxTtlSeconds?: number
  skewSeconds?: number
}

/**
 * Verify a peer bearer token.
 *
 * The order matters and is deliberate: everything cheap and local first, the
 * network resolution second, the signature third, and the replay check **last**
 * — a `jti` is only worth burning once the token it belongs to has proven
 * genuine, or an attacker could invalidate a peer's real tokens by presenting
 * forged copies of them.
 */
export async function verifyPeerToken(
  token: string,
  options: VerifyPeerTokenOptions,
): Promise<Result<PeerTokenClaims, PeerTokenFailure>> {
  const fail = (
    reason: PeerTokenRejection,
    detail: string,
    iss: string | null = null,
    jti: string | null = null,
  ): Result<PeerTokenClaims, PeerTokenFailure> => err({ reason, detail, iss, jti })

  const parts = token.split('.')
  if (parts.length !== 3 || parts.some((part) => part === '')) {
    return fail('malformed', 'expected an attached compact JWS with three parts')
  }
  const [protectedB64, payloadB64, signatureB64] = parts as [string, string, string]

  let header
  try {
    header = protectedHeaderOf(token)
  } catch (cause) {
    return fail('malformed', (cause as Error).message)
  }
  if (header.typ !== PEER_TOKEN_TYP) {
    return fail('wrong-type', `expected typ ${PEER_TOKEN_TYP}, got ${String(header.typ)}`)
  }

  let claims: PeerTokenClaims
  try {
    const parsed: unknown = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'))
    const result = PeerTokenClaims.safeParse(parsed)
    if (!result.success) {
      return fail('malformed', result.error.issues[0]?.message ?? 'invalid claim set')
    }
    claims = result.data
  } catch (cause) {
    return fail('malformed', `claims are not JSON: ${(cause as Error).message}`)
  }

  // `kid` names the key; `iss` names the issuer. A token whose key belongs to a
  // different DID than it claims to come from is the interesting forgery, so it
  // is checked before anything is resolved.
  if (!header.kid.startsWith(`${claims.iss}#`)) {
    return fail(
      'issuer-mismatch',
      `kid ${header.kid} does not belong to issuer ${claims.iss}`,
      claims.iss,
      claims.jti,
    )
  }
  if (claims.aud !== options.audience) {
    return fail(
      'audience-mismatch',
      `this token is addressed to ${claims.aud}`,
      claims.iss,
      claims.jti,
    )
  }

  const skew = options.skewSeconds ?? PEER_TOKEN_SKEW_SECONDS
  const nowSeconds = Math.floor(options.nowMs / 1000)
  if (claims.exp + skew < nowSeconds) {
    return fail('expired', `expired at ${claims.exp}`, claims.iss, claims.jti)
  }
  if (claims.iat - skew > nowSeconds) {
    return fail('not-yet-valid', `issued at ${claims.iat}`, claims.iss, claims.jti)
  }
  const maxTtl = options.maxTtlSeconds ?? PEER_TOKEN_TTL_SECONDS
  if (claims.exp - claims.iat > maxTtl) {
    // A peer that mints year-long tokens has turned a per-call credential into a
    // password. Refuse it rather than accept a weaker guarantee than specified.
    return fail(
      'lifetime-too-long',
      `token lifetime ${claims.exp - claims.iat}s exceeds ${maxTtl}s`,
      claims.iss,
      claims.jti,
    )
  }

  const document = await options.resolver.resolve(claims.iss)
  if (!document) {
    return fail('issuer-unresolvable', `${claims.iss} does not resolve`, claims.iss, claims.jti)
  }
  const method = findVerificationMethod(document, header.kid)
  if (!method) {
    return fail(
      'key-unknown',
      `${header.kid} is not in ${claims.iss}'s DID document`,
      claims.iss,
      claims.jti,
    )
  }

  const verified = await verifyDetachedJws(
    `${protectedB64}..${signatureB64}`,
    // The detached verifier reattaches base64url(payload); the payload here is
    // already the encoded claims, so hand it the bytes they encode.
    new Uint8Array(Buffer.from(payloadB64, 'base64url')),
    method.publicKeyJwk,
  )
  if (!verified) {
    return fail('signature-invalid', 'the signature did not verify', claims.iss, claims.jti)
  }

  if (await options.seenJti({ jti: claims.jti, iss: claims.iss, expEpochSeconds: claims.exp })) {
    return fail('replayed', `jti ${claims.jti} has already been used`, claims.iss, claims.jti)
  }

  return ok(claims)
}
