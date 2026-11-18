/**
 * The definition as its author wrote it — before the schema fills in defaults.
 *
 * Every command edits this shape and never the parsed one. `ProcessDefinition`
 * adds `auto: false`, `cardinality: 1`, `visibility: []` and more when it
 * parses, and the `definitionHash` covers the document's bytes: an editor that
 * wrote back the parsed form would change the identity of every process it
 * merely opened.
 *
 * Types only. The protocol imports `node:crypto` at runtime, and this package is
 * drawn in a browser.
 */
import type { ProcessDefinition } from '@pilots/protocol'
import type { z } from 'zod'

export type DefinitionDocument = z.input<typeof ProcessDefinition>
export type RoleDocument = DefinitionDocument['roles'][number]
export type StateDocument = DefinitionDocument['states'][number]
export type TransitionDocument = DefinitionDocument['transitions'][number]
export type VisibilityDocument = NonNullable<DefinitionDocument['visibility']>[number]
export type LinkDocument = NonNullable<DefinitionDocument['links']>[number]
export type SchemaDocument = DefinitionDocument['data']

/** `from: ["*"]` — any non-terminal state. Mirrors `ANY_STATE` in the protocol. */
export const ANY_STATE = '*'
