/**
 * Offerings — what makes a participant a supplier.
 *
 * A record in its own store, published and withdrawn in the admin UI at runtime.
 * Not a config file, not a build flag, not a deployment mode. Withdraw it and
 * the participant stops being a supplier, with no restart; publish one while
 * consuming a peer's and it is both at once, which is the normal case.
 *
 * Offerings are deliberately **not** part of the signed protocol core. They are
 * discovery, and a wrong offering costs a rejected quotation rather than a
 * corrupted record.
 */
import { z } from 'zod'

import { DefinitionRef, Instant, JsonObjectSchema } from './common.js'

export const Price = z.strictObject({
  value: z.number().min(0),
  currency: z.string().regex(/^[A-Z]{3}$/),
})
export type Price = z.infer<typeof Price>

export const OfferingStatus = z.enum(['PUBLISHED', 'WITHDRAWN'])
export type OfferingStatus = z.infer<typeof OfferingStatus>

export const Offering = z.strictObject({
  /** A URN chosen by the publisher, e.g. `urn:offering:org-b:container-weighing`. */
  id: z.string().min(1).max(255),
  participantId: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  /**
   * What a would-be consumer instantiates first. If that definition's initial
   * transition is `auto`, this offering is a standing quotation — a fixed price,
   * agreed on creation.
   */
  quotationDefinition: DefinitionRef,
  serviceDefinition: DefinitionRef,
  /** Narrows when the offering applies. Advisory: the quotation definition's schema and guards are authoritative. */
  conditions: JsonObjectSchema.default({}),
  price: z.union([Price, z.null()]).default(null),
  status: OfferingStatus,
  createdAt: Instant,
  updatedAt: Instant,
})
export type Offering = z.infer<typeof Offering>

/** The projection a peer sees. `participantId` is ours, not theirs. */
export const PublishedOffering = Offering.omit({ participantId: true, status: true })
export type PublishedOffering = z.infer<typeof PublishedOffering>
