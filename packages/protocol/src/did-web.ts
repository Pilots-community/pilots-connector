/**
 * The `did:web` resolver — the one adapter in this package that touches a
 * network.
 *
 * It lives on its own entry point (`@pilots/protocol/did-web`) so that importing
 * the core never pulls an HTTP stack in behind it, and so that the rule "no
 * unit, contract or scenario test may require a network" is enforced by what a
 * test can import rather than by discipline.
 *
 * There is nothing to run at the other end: a participant publishes one static
 * document over ordinary HTTPS. That, plus accepting one connection request, is
 * the whole of onboarding.
 */
import { Resolver } from 'did-resolver'
import { getResolver } from 'web-did-resolver'

import {
  DidDocument,
  cachingDidResolver,
  didWebOrigin,
  type DidResolver,
} from './ports/did-resolver.js'

export interface WebDidResolverOptions {
  /** Cache successful resolutions for the life of the resolver. Failures are never cached. */
  cache?: boolean
}

/**
 * Resolve `did:web` over HTTPS.
 *
 * Returns `null` rather than throwing when a DID does not resolve: an
 * unreachable or absent DID document is an ordinary outcome that the caller
 * audits, not an exception.
 */
export function webDidResolver(options: WebDidResolverOptions = {}): DidResolver {
  const resolver = new Resolver(getResolver())

  const base: DidResolver = {
    async resolve(did) {
      let resolution
      try {
        resolution = await resolver.resolve(did)
      } catch {
        return null
      }
      if (resolution.didResolutionMetadata.error || !resolution.didDocument) return null

      // The resolver is permissive about document shape; we are not. A document
      // we cannot verify a signature against is the same as no document.
      const parsed = DidDocument.safeParse(resolution.didDocument)
      return parsed.success ? parsed.data : null
    },
  }

  return options.cache === false ? base : cachingDidResolver(base)
}

export { didWebOrigin }
