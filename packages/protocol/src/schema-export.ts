/**
 * JSON Schema export.
 *
 * `packages/protocol` is the spec, and a spec only one language can read is a
 * library. These files are what a non-TypeScript implementation validates
 * against, so they are generated from the zod schemas rather than written by
 * hand — the two cannot drift, because there is only one source.
 *
 * Exported in **input** form: fields with defaults are optional, which is how a
 * human authors a definition file.
 */
import { z } from 'zod'

import { AuditEntry } from './schemas/audit.js'
import { ApiKeyRecord } from './schemas/api-key.js'
import { Connection, ConnectionRequest } from './schemas/connection.js'
import { ProcessDefinition } from './schemas/definition.js'
import { EventHeader, SignedEvent } from './schemas/event.js'
import { Instance } from './schemas/instance.js'
import { Offering } from './schemas/offering.js'
import { NotificationEnvelope, NotificationSubscription } from './schemas/subscription.js'
import { DidDocument } from './ports/did-resolver.js'

export const SCHEMA_BASE_URI = 'https://pilots.example/schema/v1'

const EXPORTS = {
  'process-definition': {
    schema: ProcessDefinition,
    title: 'Process definition',
    description: 'The shared artefact: roles, states, transitions, data schema, visibility, links.',
  },
  instance: {
    schema: Instance,
    title: 'Instance',
    description: 'A running process. A quotation and a service execution are the same primitive.',
  },
  'event-header': {
    schema: EventHeader,
    title: 'Event header',
    description: 'The signed, chained record of one transition. Every field is always present.',
  },
  'signed-event': {
    schema: SignedEvent,
    title: 'Signed event',
    description: 'An event header, its payload (possibly redacted), and the detached signature.',
  },
  connection: {
    schema: Connection,
    title: 'Connection',
    description: 'A verified, persistent, bidirectional relationship between two participants.',
  },
  'connection-request': {
    schema: ConnectionRequest,
    title: 'Connection request',
    description: 'The opening move of the handshake.',
  },
  offering: {
    schema: Offering,
    title: 'Offering',
    description: 'What makes a participant a supplier. A runtime record, not configuration.',
  },
  'api-key': {
    schema: ApiKeyRecord,
    title: 'API key record',
    description: 'An integration credential. The secret itself is shown once and never stored.',
  },
  'audit-entry': {
    schema: AuditEntry,
    title: 'Audit entry',
    description: 'Locally hash-chained, never replicated. Records what was refused.',
  },
  'notification-subscription': {
    schema: NotificationSubscription,
    title: 'Notification subscription',
    description: 'Local delivery configuration: how a party with no UI is told it is their turn.',
  },
  'notification-envelope': {
    schema: NotificationEnvelope,
    title: 'Notification envelope',
    description: 'What a subscriber receives, including the whole signed event.',
  },
  'did-document': {
    schema: DidDocument,
    title: 'DID document',
    description: 'The static document a participant publishes to be identifiable.',
  },
} as const

export type ExportedSchemaName = keyof typeof EXPORTS

/** Every protocol shape, as JSON Schema 2020-12. */
export function protocolJsonSchemas(): Record<ExportedSchemaName, Record<string, unknown>> {
  const result = {} as Record<ExportedSchemaName, Record<string, unknown>>
  for (const [name, entry] of Object.entries(EXPORTS) as Array<
    [ExportedSchemaName, (typeof EXPORTS)[ExportedSchemaName]]
  >) {
    const generated = z.toJSONSchema(entry.schema, {
      io: 'input',
      unrepresentable: 'any',
    }) as Record<string, unknown>
    result[name] = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: `${SCHEMA_BASE_URI}/${name}.schema.json`,
      title: entry.title,
      description: entry.description,
      ...omit(generated, '$schema'),
    }
  }
  return result
}

function omit(source: Record<string, unknown>, key: string): Record<string, unknown> {
  const { [key]: _removed, ...rest } = source
  return rest
}
