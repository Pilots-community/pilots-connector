/**
 * Verifying the log **in the UI**, not asking the connector whether it is fine.
 *
 * This is the point of every event being signed. A UI that rendered a green tick
 * because its own connector said so would prove nothing: the connector is the
 * thing the signature exists to hold to account. So the BFF fetches each
 * participant's published DID document itself and runs the same `verifyChain`
 * from `@pilots/protocol` that a replica runs.
 *
 * **A broken chain is loud and red**, and it is never recoverable by reloading.
 * A failure at `prev` or `from` means somebody rewrote history.
 *
 * One honesty, stated rather than glossed. In the demo every DID is on the
 * reserved `.example` TLD and resolves nowhere, so the documents are fetched
 * from the base URLs the connector's own connection records give. That is the
 * same weakening the connector's `PILOTS_DEV_DID_DIRECTORY` makes, and it is why
 * an unresolved signature is reported as **`unresolved`** rather than quietly
 * counted as verified. Amber is not green.
 */
import { DidDocument, verifyChain, type DidResolver, type SignedEvent } from '@pilots/protocol'

export type ChainStatus = 'verified' | 'unresolved' | 'broken'

export interface VerificationReport {
  status: ChainStatus
  /** Which events verified, in order. `null` where the key could not be resolved. */
  events: Array<{ seq: number; ok: boolean | null }>
  failures: Array<{ seq: number; type: string; detail: string }>
  /** DIDs whose document could not be fetched, so their signatures are unchecked. */
  unresolved: string[]
}

/**
 * Resolve participants' DID documents by fetching them ourselves.
 *
 * `did:web` proper derives the URL from the DID. Where that is not reachable —
 * the demo — the caller supplies the base URLs it knows from its own
 * connections, and the document must still identify itself as the DID we asked
 * for. Weak, but weak *and visible*: what it cannot check, it reports.
 */
export function uiDidResolver(
  directory: Map<string, string>,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): DidResolver & { unresolved: Set<string> } {
  const cache = new Map<string, DidDocument>()
  const unresolved = new Set<string>()

  return {
    unresolved,
    async resolve(did) {
      const cached = cache.get(did)
      if (cached) return cached

      const base = directory.get(did) ?? didWebBase(did)
      if (base === undefined) {
        unresolved.add(did)
        return null
      }

      try {
        const response = await fetchImpl(new URL('/.well-known/did.json', base).toString(), {
          headers: { accept: 'application/json' },
        })
        if (!response.ok) {
          unresolved.add(did)
          return null
        }
        const parsed = DidDocument.safeParse(await response.json())
        // It must at least claim to be the DID we asked about, or a
        // misconfigured address silently lends somebody else's identity.
        if (!parsed.success || parsed.data.id !== did) {
          unresolved.add(did)
          return null
        }
        cache.set(did, parsed.data)
        return parsed.data
      } catch {
        unresolved.add(did)
        return null
      }
    },
  }
}

function didWebBase(did: string): string | undefined {
  const prefix = 'did:web:'
  if (!did.startsWith(prefix)) return undefined
  const host = did.slice(prefix.length).split(':')[0]
  return host === undefined ? undefined : `https://${decodeURIComponent(host)}`
}

export async function verifyLog(
  events: readonly SignedEvent[],
  options: {
    resolver: DidResolver & { unresolved: Set<string> }
    definition?: Parameters<typeof verifyChain>[1]['definition']
    participants?: Parameters<typeof verifyChain>[1]['participants']
    instanceId?: string
  },
): Promise<VerificationReport> {
  if (events.length === 0) {
    return { status: 'verified', events: [], failures: [], unresolved: [] }
  }

  const verified = await verifyChain(events, {
    resolver: options.resolver,
    ...(options.definition === undefined ? {} : { definition: options.definition }),
    ...(options.participants === undefined ? {} : { participants: options.participants }),
    ...(options.instanceId === undefined ? {} : { instanceId: options.instanceId }),
  })

  const unresolved = [...options.resolver.unresolved]
  const failures = verified.failures.map((failure) => ({
    seq: failure.seq,
    type: failure.error.type,
    detail: failure.error.detail,
  }))

  /*
   * A failure caused purely by an unfetchable key is **not** a broken chain.
   * `verifyChain` stops at the first problem, so it cannot distinguish them —
   * but conflating "I could not check" with "this is forged" would either cry
   * wolf or, far worse, let a real forgery hide behind a resolution error.
   */
  const onlyUnresolved =
    failures.length > 0 &&
    unresolved.length > 0 &&
    failures.every((failure) => failure.detail.includes('did not resolve'))

  const status: ChainStatus =
    failures.length === 0
      ? unresolved.length === 0
        ? 'verified'
        : 'unresolved'
      : onlyUnresolved
        ? 'unresolved'
        : 'broken'

  const firstFailure = failures[0]?.seq ?? Number.POSITIVE_INFINITY
  return {
    status,
    events: events.map((event) => ({
      seq: event.header.seq,
      ok:
        event.header.seq < firstFailure
          ? status === 'unresolved'
            ? null
            : true
          : event.header.seq === firstFailure && !onlyUnresolved
            ? false
            : null,
    })),
    failures: onlyUnresolved ? [] : failures,
    unresolved,
  }
}
