/**
 * The one runtime primitive.
 *
 * A quotation and a service execution are the same thing with different `kind`
 * values and different definitions. There is no second engine and no special
 * case in code for a standing quotation — that is a definition whose first
 * transition auto-fires.
 *
 * The instance is derived by folding its event log and *also* stored
 * materialised so reads are cheap. The log is the truth; this document is a
 * cache, and the two are written in one atomic store operation.
 */
import { z } from 'zod'

import {
  Did,
  DefinitionRef,
  Identifier,
  Instant,
  JsonObjectSchema,
  StateId,
  Ulid,
} from './common.js'
import { ProcessKind } from './definition.js'

/**
 * Which participant fills each role. Only an instance names participants —
 * a definition names a *role*, which is the whole of role symmetry.
 *
 * A role with `cardinality: 1` is written as a single DID, exactly as every
 * example in the docs writes it; a role that several participants fill is
 * written as an array. The union is confined to this one place: everything else
 * goes through `didsFor()`.
 */
export const ParticipantMap = z.record(Identifier, z.union([Did, z.array(Did).min(1)]))
export type ParticipantMap = z.infer<typeof ParticipantMap>

/** The DIDs filling one role, however the map wrote them. */
export function didsFor(participants: ParticipantMap, role: string): string[] {
  const entry = participants[role]
  if (entry === undefined) return []
  return Array.isArray(entry) ? entry : [entry]
}

/** Every participant DID in the instance, deduplicated. */
export function participantDids(participants: ParticipantMap): string[] {
  return [...new Set(Object.keys(participants).flatMap((role) => didsFor(participants, role)))]
}

export const Instance = z.strictObject({
  id: Ulid,
  kind: ProcessKind,
  definition: DefinitionRef,
  participants: ParticipantMap,
  /** The quotation that authorised this service execution, if any. */
  quotationId: z.union([Ulid, z.null()]).default(null),
  /** The offering this was started from, if any. Discovery metadata. */
  offering: z.union([z.string().max(255), z.null()]).default(null),
  state: StateId,
  /** The seq of the last event applied. Equals the instance's `ETag`. */
  seq: z.int().min(1),
  data: JsonObjectSchema,
  createdAt: Instant,
  updatedAt: Instant,
})
export type Instance = z.infer<typeof Instance>

/**
 * An instance as held in a connector's own store.
 *
 * `home` is resolved **per instance**, at write time, from two steps: the
 * definition names a role in `hostedBy`, and only this instance's `participants`
 * map names the participant filling it. Caching that answer per *definition*
 * breaks role symmetry silently — a one-directional demo would still pass.
 */
export const StoredInstance = Instance.extend({
  participantId: z.string().min(1),
  /** True when this connector's participant is the home node for this instance. */
  home: z.boolean(),
})
export type StoredInstance = z.infer<typeof StoredInstance>

/**
 * Resolve the home node for one instance: read `hostedBy` from the definition,
 * then look up which participant fills that role *here*.
 */
export function homeParticipant(
  definition: { hostedBy: string },
  participants: ParticipantMap,
): string | undefined {
  return didsFor(participants, definition.hostedBy)[0]
}

/** Whether this connector is the home node for this instance. Answered per instance, never per definition. */
export function isHomeNode(
  definition: { hostedBy: string },
  participants: ParticipantMap,
  ourDids: readonly string[],
): boolean {
  const host = homeParticipant(definition, participants)
  return host !== undefined && ourDids.includes(host)
}

/**
 * The roles a given participant holds in an instance. May be more than one, and
 * that is not exotic: a freight forwarder can be shipper in one instance and
 * transporter in another under the same definition, at the same time.
 */
export function rolesOf(participants: ParticipantMap, did: string): string[] {
  return Object.keys(participants).filter((role) => didsFor(participants, role).includes(did))
}
