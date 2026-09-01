/**
 * The `DidResolver` port.
 *
 * A participant is identified by a `did:web` DID resolved over ordinary HTTPS —
 * there is nothing to run, only a static document to publish. Resolution is a
 * port anyway, because every test in this package must work without a network,
 * and because a demo deployment seeds its peers from configuration.
 *
 * The HTTPS adapter lives in `@pilots/protocol/did-web`, on its own entry point,
 * so importing the core never pulls a network stack in behind it.
 */
import { z } from 'zod'

/** The minimal public JWK an Ed25519 verification method carries. */
export const PublicKeyJwk = z.strictObject({
  kty: z.literal('OKP'),
  crv: z.literal('Ed25519'),
  /** base64url-encoded public key. */
  x: z.string().min(1),
})
export type PublicKeyJwk = z.infer<typeof PublicKeyJwk>

export const VerificationMethod = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  controller: z.string().min(1),
  publicKeyJwk: PublicKeyJwk,
})
export type VerificationMethod = z.infer<typeof VerificationMethod>

export const DidDocument = z.object({
  '@context': z.union([z.string(), z.array(z.string())]).optional(),
  id: z.string().min(1),
  verificationMethod: z.array(VerificationMethod).min(1),
  authentication: z.array(z.string()).optional(),
  assertionMethod: z.array(z.string()).optional(),
})
export type DidDocument = z.infer<typeof DidDocument>

export interface DidResolver {
  /** The DID document, or `null` when the DID does not resolve. */
  resolve(did: string): Promise<DidDocument | null>
}

/** A resolver backed by a fixed map: the test default, and the demo's config-seeded peers. */
export function staticDidResolver(documents: Record<string, DidDocument>): DidResolver {
  return {
    resolve: async (did) => documents[did] ?? null,
  }
}

/** Caches successful resolutions; failures are never cached. */
export function cachingDidResolver(inner: DidResolver): DidResolver {
  const cache = new Map<string, DidDocument>()
  return {
    resolve: async (did) => {
      const cached = cache.get(did)
      if (cached) return cached
      const resolved = await inner.resolve(did)
      if (resolved) cache.set(did, resolved)
      return resolved
    },
  }
}

/**
 * Find the verification method a `kid` names.
 *
 * A bare fragment (`#key-1`) is resolved against the document's own id, which is
 * how DID documents usually write their own methods.
 */
export function findVerificationMethod(
  document: DidDocument,
  kid: string,
): VerificationMethod | undefined {
  const absolute = kid.startsWith('#') ? `${document.id}${kid}` : kid
  return document.verificationMethod.find((method) => method.id === absolute)
}

/**
 * `did:web:example.com:t:acme` → `https://example.com/t/acme/did.json`;
 * `did:web:example.com` → `https://example.com/.well-known/did.json`.
 *
 * Exported from the core because the **domain-binding check** needs it: a
 * connection request is only trustworthy if the DID document's host matches the
 * origin of the base URL the caller claims. `did:web` is domain-bound by
 * construction, and that check is what turns the construction into a guarantee.
 */
export function didWebUrl(did: string): URL {
  const prefix = 'did:web:'
  if (!did.startsWith(prefix)) throw new TypeError(`not a did:web DID: ${JSON.stringify(did)}`)
  const [host, ...path] = did.slice(prefix.length).split(':')
  if (!host) throw new TypeError(`did:web DID has no host: ${JSON.stringify(did)}`)
  const decodedHost = decodeURIComponent(host)
  const tail =
    path.length === 0
      ? '/.well-known/did.json'
      : `/${path.map(decodeURIComponent).join('/')}/did.json`
  return new URL(`https://${decodedHost}${tail}`)
}

/** The origin a `did:web` DID is bound to, for comparison against a claimed base URL. */
export function didWebOrigin(did: string): string {
  return didWebUrl(did).origin
}
