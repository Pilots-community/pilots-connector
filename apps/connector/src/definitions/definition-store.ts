/**
 * Definitions as stored records, rather than only as files on disk.
 *
 * The boot directory becomes a **seed**: a definition loaded from it and one
 * published at runtime are the same kind of record afterwards, and both survive
 * a restart the same way. Without that, "author your own process" would mean
 * "author it and then get an operator to redeploy the container".
 *
 * A published definition is immutable and content-addressed. `id` is the ref,
 * so `(participantId, ref)` is the key and publishing the same ref twice with
 * different bytes collides rather than silently overwriting the document every
 * running instance is pinned to.
 */
import type { JsonValue } from '@pilots/protocol'

import type { RegisteredDefinition } from './definition-registry.js'
import type { StoredDocument } from '../store/types.js'

/** Where a definition came from, which decides whether anyone had to agree to it. */
export type DefinitionOrigin = 'boot' | 'local' | 'peer'

export type AdoptionStatus = 'pending' | 'accepted' | 'rejected'

/**
 * An operator's decision about a definition a **peer** sent.
 *
 * Recorded against the ref, not against the instance that prompted it: the
 * question is "do we agree to run this process", and answering it once is the
 * point. Every later instance under the same ref consults this and asks nobody.
 */
export interface DefinitionAdoption {
  status: AdoptionStatus
  /** The peer whose delivery introduced it. */
  peerDid: string
  decidedAt: string | null
  /** The admin session that decided. `null` while pending. */
  decidedBy: string | null
  /** Why it was rejected, so an instance's refusal can say. */
  reason: string | null
}

export interface DefinitionDocument extends StoredDocument {
  /** `id` and `ref` are the same value; both exist so queries read naturally. */
  ref: string
  /** The definition's own id, so versions of one process can be found together. */
  definitionId: string
  version: string
  contentHash: string
  /** The document exactly as published. Hashing anything else would drift. */
  raw: JsonValue
  origin: DefinitionOrigin
  /** `null` for anything we hold by our own choice — boot or local. */
  adoption: DefinitionAdoption | null
  createdAt: string
}

/** A stored record for a definition the registry has already accepted. */
export function definitionDocumentOf(
  participantId: string,
  registered: RegisteredDefinition,
  origin: DefinitionOrigin,
  adoption: DefinitionAdoption | null,
  createdAt: string,
): DefinitionDocument {
  return {
    id: registered.ref,
    participantId,
    ref: registered.ref,
    definitionId: registered.definition.id,
    version: registered.definition.version,
    contentHash: registered.contentHash,
    raw: registered.raw,
    origin,
    adoption,
    createdAt,
  }
}

/**
 * Whether a definition may govern an instance right now.
 *
 * Anything we chose to hold is usable. A peer's is usable only once an operator
 * has accepted it — which is the whole of the adoption gate, expressed in one
 * place so no call site has to remember the rule.
 */
export function isUsable(document: DefinitionDocument): boolean {
  return document.adoption === null || document.adoption.status === 'accepted'
}

/** Versions of one definition, newest first by semantic version. */
export function byVersionDescending(
  documents: readonly DefinitionDocument[],
): DefinitionDocument[] {
  const parse = (version: string): number[] => version.split('.').map((part) => Number(part) || 0)
  return [...documents].sort((a, b) => {
    const left = parse(a.version)
    const right = parse(b.version)
    for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
      const difference = (right[index] ?? 0) - (left[index] ?? 0)
      if (difference !== 0) return difference
    }
    return 0
  })
}
