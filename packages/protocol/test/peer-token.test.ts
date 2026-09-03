import { describe, expect, it } from 'vitest'

import {
  PEER_TOKEN_TTL_SECONDS,
  signPeerToken,
  verifyPeerToken,
  type PeerTokenRejection,
} from '../src/crypto/peer-token.js'
import { staticDidResolver } from '../src/ports/did-resolver.js'
import { ORG_A, ORG_B, twoParties } from './helpers/chain.js'

const NOW = Date.parse('2026-08-24T09:00:00.000Z')

/** Nothing is ever accepted twice, and the set is per-verifier. */
function replayGuard() {
  const seen = new Set<string>()
  return ({ jti, iss }: { jti: string; iss: string }): boolean => {
    const key = `${iss}|${jti}`
    if (seen.has(key)) return true
    seen.add(key)
    return false
  }
}

async function orgACallingOrgB(overrides: { jti?: string; ttlSeconds?: number } = {}) {
  const parties = await twoParties()
  const token = await signPeerToken(parties.signer, 'org-a', {
    iss: ORG_A,
    aud: ORG_B,
    jti: overrides.jti ?? 'jti-1',
    nowMs: NOW,
    ...(overrides.ttlSeconds === undefined ? {} : { ttlSeconds: overrides.ttlSeconds }),
  })
  return { parties, token }
}

async function rejectionOf(
  token: string,
  options: Partial<Parameters<typeof verifyPeerToken>[1]> & {
    resolver: Parameters<typeof verifyPeerToken>[1]['resolver']
  },
): Promise<PeerTokenRejection> {
  const result = await verifyPeerToken(token, {
    audience: ORG_B,
    nowMs: NOW,
    seenJti: replayGuard(),
    ...options,
  })
  if (result.ok) throw new Error('expected the token to be refused')
  return result.error.reason
}

describe('peer bearer tokens', () => {
  it('verifies a token minted for us by a peer we can resolve', async () => {
    const { parties, token } = await orgACallingOrgB()

    const result = await verifyPeerToken(token, {
      resolver: parties.resolver,
      audience: ORG_B,
      nowMs: NOW,
      seenJti: replayGuard(),
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toEqual({
      iss: ORG_A,
      aud: ORG_B,
      iat: Math.floor(NOW / 1000),
      exp: Math.floor(NOW / 1000) + PEER_TOKEN_TTL_SECONDS,
      jti: 'jti-1',
    })
  })

  it('rejects a replayed jti — but only after the signature has proven genuine', async () => {
    const { parties, token } = await orgACallingOrgB()
    const seenJti = replayGuard()
    const options = {
      resolver: parties.resolver,
      audience: ORG_B,
      nowMs: NOW,
      seenJti,
    }

    expect((await verifyPeerToken(token, options)).ok).toBe(true)
    const second = await verifyPeerToken(token, options)
    expect(second.ok).toBe(false)
    if (second.ok) return
    expect(second.error.reason).toBe('replayed')

    // The forgery must not have burned the jti of a token that had not been
    // presented yet, or a peer could invalidate another's tokens at will.
    const forged = await signPeerToken(parties.signer, 'org-b', {
      iss: ORG_A, // lying about who we are, signed with the wrong key
      aud: ORG_B,
      jti: 'not-yet-used',
      nowMs: NOW,
    })
    expect(await rejectionOf(forged, { resolver: parties.resolver })).toBe('issuer-mismatch')

    const honest = await signPeerToken(parties.signer, 'org-a', {
      iss: ORG_A,
      aud: ORG_B,
      jti: 'not-yet-used',
      nowMs: NOW,
    })
    expect((await verifyPeerToken(honest, options)).ok).toBe(true)
  })

  it('refuses a token addressed to somebody else rather than forwarding it', async () => {
    const { parties, token } = await orgACallingOrgB()
    expect(
      await rejectionOf(token, { resolver: parties.resolver, audience: 'did:web:third.example' }),
    ).toBe('audience-mismatch')
  })

  it('refuses an expired token, and one from a peer whose clock is far ahead', async () => {
    const { parties, token } = await orgACallingOrgB()
    const resolver = parties.resolver

    expect(await rejectionOf(token, { resolver, nowMs: NOW + 3_600_000 })).toBe('expired')
    expect(await rejectionOf(token, { resolver, nowMs: NOW - 3_600_000 })).toBe('not-yet-valid')

    // Small skew is tolerated: two connectors share no time source.
    expect(
      (
        await verifyPeerToken(token, {
          resolver,
          audience: ORG_B,
          nowMs: NOW + (PEER_TOKEN_TTL_SECONDS + 30) * 1000,
          seenJti: replayGuard(),
        })
      ).ok,
    ).toBe(true)
  })

  it('refuses a long-lived token, which would be a password rather than a credential', async () => {
    const { parties, token } = await orgACallingOrgB({ ttlSeconds: 60 * 60 * 24 * 365 })
    expect(await rejectionOf(token, { resolver: parties.resolver })).toBe('lifetime-too-long')
  })

  it('refuses a token whose issuer does not resolve, and one signed by an unpublished key', async () => {
    const { parties, token } = await orgACallingOrgB()

    expect(await rejectionOf(token, { resolver: staticDidResolver({}) })).toBe(
      'issuer-unresolvable',
    )

    // Org A resolves, but its published document lists Org B's key only.
    const swapped = staticDidResolver({
      [ORG_A]: { ...parties.documents[ORG_B]!, id: ORG_A },
    })
    expect(await rejectionOf(token, { resolver: swapped })).toBe('key-unknown')
  })

  it('refuses a tampered token and anything that is not a peer token at all', async () => {
    const { parties, token } = await orgACallingOrgB()
    const [header, payload, signature] = token.split('.') as [string, string, string]

    const tampered = Buffer.from(
      JSON.stringify({
        ...(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as object),
        iss: ORG_A,
        jti: 'swapped',
      }),
    ).toString('base64url')
    expect(
      await rejectionOf(`${header}.${tampered}.${signature}`, { resolver: parties.resolver }),
    ).toBe('signature-invalid')

    expect(await rejectionOf('not-a-token', { resolver: parties.resolver })).toBe('malformed')
    expect(await rejectionOf('a.b.c', { resolver: parties.resolver })).toBe('malformed')
  })

  it('refuses an event signature presented as a bearer token', async () => {
    const parties = await twoParties()
    // A detached event signature has an empty middle segment and no `typ`.
    const { signDetachedJws } = await import('../src/crypto/jws.js')
    const detached = await signDetachedJws(parties.signer, 'org-a', new Uint8Array([1, 2, 3]))
    expect(await rejectionOf(detached, { resolver: parties.resolver })).toBe('malformed')
  })
})
