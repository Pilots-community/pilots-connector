/**
 * Resolving the DIDs of the people we talk to.
 *
 * Ordinarily this is `did:web` over HTTPS and there is nothing to explain: the
 * DID names a domain, the domain serves a document, and controlling one means
 * controlling the other. That property is the entire reason `did:web` was
 * chosen, and it is what the connection handshake's domain-binding check turns
 * into a decision.
 *
 * The demo cannot use it. Every DID in this project is on the reserved
 * `.example` TLD precisely so nothing in the repository points at a real host,
 * and `.example` resolves nowhere. So there is a second, **explicitly weaker**
 * resolver here, and it is gated behind a flag that refuses to start under
 * production config.
 */
import { DidDocument, cachingDidResolver, didWebUrl, type DidResolver } from '@pilots/protocol'

/** Try each resolver in turn; the first document wins. Failures are never cached. */
export function firstOf(...resolvers: readonly DidResolver[]): DidResolver {
  return {
    async resolve(did) {
      for (const resolver of resolvers) {
        const document = await resolver.resolve(did)
        if (document) return document
      }
      return null
    },
  }
}

/**
 * Serve our **own** participants' documents without a round trip.
 *
 * Not a trust decision: these are documents we publish ourselves at
 * `/.well-known/did.json`, and resolving them over the network would mean a
 * connector could fail to verify its own signature because its DNS was down.
 */
export function localDidResolver(
  documents: () => Promise<Record<string, DidDocument>>,
): DidResolver {
  let loaded: Record<string, DidDocument> | undefined
  return {
    async resolve(did) {
      loaded ??= await documents()
      return loaded[did] ?? null
    },
  }
}

/**
 * **Development only.** Resolve a peer's DID through the base URL an operator
 * configured for it, rather than through the URL the DID itself implies.
 *
 * What this gives up, stated plainly: `did:web` is domain-bound by construction,
 * and the handshake's check that a peer's DID and its base URL share an origin
 * is what proves the caller controls the domain it claims. Resolving through the
 * configured base URL instead reduces that proof to "our operator wrote this
 * address down". Signatures are still verified, chains are still verified, and
 * nothing else is relaxed — but the peer's *identity* rests on configuration.
 *
 * `loadConfig` refuses a production config with this on, so the weakening cannot
 * survive a deployment by being forgotten.
 */
export function devDirectoryResolver(
  directory: () => Promise<Map<string, string>>,
  fetchJson: (url: string) => Promise<unknown> = defaultFetchJson,
): DidResolver {
  return cachingDidResolver({
    async resolve(did) {
      const baseUrl = (await directory()).get(did)
      if (baseUrl === undefined) return null

      let payload: unknown
      try {
        payload = await fetchJson(new URL('/.well-known/did.json', baseUrl).toString())
      } catch {
        return null
      }

      const parsed = DidDocument.safeParse(payload)
      // The document must at least claim to be the DID we asked for. Weak, but
      // it stops a misconfigured address from silently giving a peer somebody
      // else's identity.
      if (!parsed.success || parsed.data.id !== did) return null
      return parsed.data
    },
  })
}

async function defaultFetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { headers: { accept: 'application/json' } })
  if (!response.ok) throw new Error(`${url} answered ${response.status}`)
  return response.json()
}

export { didWebUrl }
