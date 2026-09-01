/**
 * Primitives shared by every schema in the protocol.
 *
 * These are zod schemas: they validate the protocol's own fixed shapes. The
 * *other* validator in this package is Ajv, which validates the JSON Schema a
 * definition supplies for its own `data` and `patch` documents. Two validators,
 * two jobs — see docs/STACK.md §3. Do not unify them.
 */
import { z } from 'zod'

import { isDuration, DURATION_SUBSET } from '../duration.js'

/**
 * A `did:web` DID, optionally with path segments — `did:web:example` or
 * `did:web:connectors.example:t:acme`. Path segments are what give a hosted
 * tenant a real, resolvable identity of its own.
 */
export const Did = z
  .string()
  .regex(
    /^did:web:[a-z0-9]([a-z0-9._%-]*[a-z0-9])?(:[A-Za-z0-9._%-]+)*$/,
    'expected a did:web DID, e.g. did:web:acme-shipping.example',
  )

/** Role ids, transition ids, subscription ids: a lowercase-first identifier. */
export const Identifier = z
  .string()
  .regex(
    /^[A-Za-z][A-Za-z0-9_-]*$/,
    'expected an identifier: a letter followed by letters, digits, - or _',
  )
  .max(64)

/** A state id. Every shipped definition uses UPPER_SNAKE; the linter says so. */
export const StateId = Identifier

/** A state reference inside `transition.from`, where `*` means any non-terminal state. */
export const ANY_STATE = '*'
export const StateRef = z.union([z.literal(ANY_STATE), StateId])

/** A definition id: the stable, human-readable half of `id@version`. */
export const DefinitionId = z
  .string()
  .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, 'expected a lowercase, hyphen-separated definition id')
  .max(96)

export const SemVer = z
  .string()
  .regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, 'expected a semantic version, e.g. 1.0.0')

/** `container-transport@1.0.0` — how an instance pins the definition it runs. */
export const DefinitionRef = z
  .string()
  .regex(
    /^[a-z0-9]([a-z0-9-]*[a-z0-9])?@(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/,
    'expected <definitionId>@<version>, e.g. container-transport@1.0.0',
  )

/** Crockford base32, 26 characters, as produced by ULID. */
export const Ulid = z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/, 'expected a ULID')

export const Sha256 = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/, 'expected sha256:<64 lowercase hex characters>')

/**
 * A UTC instant. The protocol's own timestamps are always `Z` — a canonical
 * record with local offsets in it is a canonical record two implementations can
 * disagree about.
 */
export const Instant = z.iso.datetime()

/** A dotted path into an instance's data document, as used by visibility grants. */
export const DataPath = z
  .string()
  .regex(
    /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/,
    'expected a dotted path into the data document, e.g. grossMass.value',
  )

/** An ISO 8601 duration restricted to the subset a `deadline` may use. */
export const Duration = z
  .string()
  .refine(isDuration, { message: `expected a duration: ${DURATION_SUBSET}` })

/**
 * A JSON Schema document supplied by a definition. Deliberately opaque to zod:
 * validating it is Ajv's job, and Ajv is the thing that will actually run it.
 */
export const JsonSchemaDocument = z.record(z.string(), z.json())

/** An arbitrary JSON object — an instance's data document, an event payload. */
export const JsonObjectSchema = z.record(z.string(), z.json())

/** A content-addressed document referenced from an event header. */
export const AttachmentRef = z.strictObject({
  sha256: Sha256,
  mime: z.string().max(255),
  size: z.int().min(0),
  filename: z.string().max(255).optional(),
})
export type AttachmentRef = z.infer<typeof AttachmentRef>

export type Did = z.infer<typeof Did>
export type DefinitionRef = z.infer<typeof DefinitionRef>
