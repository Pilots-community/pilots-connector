/**
 * The OpenAPI document for `/api/local/v1`.
 *
 * This exists so a **non-TypeScript** integrator is a first-class one: they
 * generate a client rather than reading `client.ts` and reimplementing it by
 * eye. The same discipline as the protocol's JSON Schema export — the component
 * schemas are generated from the zod definitions, so the document and the
 * runtime cannot drift, because there is only one source.
 *
 * Paths and responses are written out by hand, because they are the API's
 * design rather than a projection of a type: which calls exist, what `If-Match`
 * is for, and which failures a client must tell apart. Generating those from
 * decorators would make the document a description of the implementation, and
 * the point of a spec is that the implementation answers to it.
 */
import {
  AttachmentRef,
  Connection,
  Instance,
  NotificationEnvelope,
  Offering,
  PROBLEM_PREFIX,
  Problem,
  SignedEvent,
} from '@pilots/protocol'
import { z } from 'zod'

export const OPENAPI_VERSION = '3.1.0'

/** One place that turns a zod schema into an OpenAPI component. */
function component(schema: z.ZodType): Record<string, unknown> {
  const generated = z.toJSONSchema(schema, {
    io: 'output',
    unrepresentable: 'any',
  }) as Record<string, unknown>
  const { $schema: _schema, ...rest } = generated
  return rest
}

const problemResponse = (description: string): Record<string, unknown> => ({
  description,
  content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } },
})

const idempotencyKey = {
  name: 'Idempotency-Key',
  in: 'header',
  required: false,
  schema: { type: 'string' },
  description:
    'A retry after a timeout must not apply the transition twice. Repeat the key and the original result comes back instead of a second write.',
}

const actorRef = {
  name: 'X-Actor-Ref',
  in: 'header',
  required: false,
  schema: { type: 'string', maxLength: 255 },
  description:
    'Who on your side is doing this. Asserted and unproven: recorded in the audit log and stored beside the event as local metadata, never in the signed header and never replicated.',
}

export function localApiDocument(): Record<string, unknown> {
  return {
    openapi: OPENAPI_VERSION,
    info: {
      title: 'Pilots connector — local API',
      version: '1.0.0',
      description: [
        'The surface an integrator writes against.',
        '',
        'You always call **your own** connector. You never address a peer, and you never learn which',
        'node hosts what: the connector resolves the instance’s home node from the definition and the',
        'participants map, and relays if it is somebody else. The request and response shapes are the',
        'same either way.',
        '',
        'Three separate mechanisms for three separate problems, and they are not alternatives:',
        '`If-Match` for concurrency, `Idempotency-Key` for safe retries, and the signed hash chain for',
        'tamper evidence.',
        '',
        'Note what is absent: no DID to publish, no key to manage, no peer address to resolve, no',
        'token lifecycle. Publishing a `did.json` and accepting connections are one-time operator tasks',
        'on the admin surface, not integration work.',
      ].join('\n'),
    },
    servers: [{ url: '/api/local/v1' }],
    security: [{ apiKey: [] }],
    tags: [
      { name: 'definitions', description: 'The process definitions this connector holds.' },
      { name: 'discovery', description: 'Offerings and connections.' },
      { name: 'instances', description: 'Running processes, and the one call that advances them.' },
      { name: 'delivery', description: 'Notifications into your own systems.' },
      { name: 'attachments', description: 'Content-addressed documents.' },
    ],
    paths: {
      '/me': {
        get: {
          tags: ['definitions'],
          operationId: 'me',
          summary: 'Which participant this API key acts for.',
          description:
            'You need your own DID to fill a `participants` map: a definition names a role, and only an instance names who fills it. Requires a valid key and no particular scope — asking who a credential belongs to is not a privilege.',
          responses: {
            '200': {
              description: 'The participant.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['participant'],
                    properties: {
                      participant: {
                        type: 'object',
                        required: ['id', 'did', 'displayName'],
                        properties: {
                          id: { type: 'string' },
                          did: { type: 'string' },
                          displayName: { type: 'string' },
                        },
                      },
                    },
                  },
                },
              },
            },
            '401': problemResponse('Missing or invalid API key.'),
          },
        },
      },
      '/definitions': {
        get: {
          tags: ['definitions'],
          operationId: 'listDefinitions',
          summary: 'Every definition this connector holds, with its content hash.',
          responses: {
            '200': {
              description: 'The registry.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['definitions'],
                    properties: {
                      definitions: {
                        type: 'array',
                        items: { $ref: '#/components/schemas/DefinitionSummary' },
                      },
                    },
                  },
                },
              },
            },
            '401': problemResponse('Missing or invalid API key.'),
          },
        },
      },
      '/definitions/{ref}': {
        get: {
          tags: ['definitions'],
          operationId: 'getDefinition',
          summary: 'One definition and its content hash.',
          parameters: [
            {
              name: 'ref',
              in: 'path',
              required: true,
              schema: { type: 'string' },
              description: '`container-transport@1.0.0` — id and version.',
            },
          ],
          responses: {
            '200': {
              description: 'The definition as authored, plus the hash of its canonical form.',
              content: { 'application/json': { schema: { type: 'object' } } },
            },
            '404': problemResponse('No such definition.'),
          },
        },
      },
      '/offerings': {
        get: {
          tags: ['discovery'],
          operationId: 'listOfferings',
          summary: 'Our published offerings, or a peer’s.',
          description:
            'With `peer`, this is a relayed read. A peer that did not answer is `peer-unreachable`, not an empty list: "nobody is offering anything" and "I could not ask" are different answers.',
          parameters: [
            {
              name: 'peer',
              in: 'query',
              required: false,
              schema: { type: 'string' },
              description: 'A peer’s DID. Omit for our own.',
            },
          ],
          responses: {
            '200': {
              description: 'Published offerings.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['offerings'],
                    properties: {
                      offerings: {
                        type: 'array',
                        items: { $ref: '#/components/schemas/Offering' },
                      },
                    },
                  },
                },
              },
            },
            '403': problemResponse('No live connection with that peer.'),
            '502': problemResponse('The peer did not answer, or answered something invalid.'),
          },
        },
      },
      '/connections': {
        get: {
          tags: ['discovery'],
          operationId: 'listConnections',
          summary: 'Our connections and their status. Read-only.',
          description:
            'Connections are operator state, established on the admin surface. An integrator sees them so it can explain a `connection-not-active` refusal, not so it can change them.',
          responses: {
            '200': {
              description: 'Connections.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['connections'],
                    properties: {
                      connections: {
                        type: 'array',
                        items: { $ref: '#/components/schemas/Connection' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      '/instances': {
        get: {
          tags: ['instances'],
          operationId: 'listInstances',
          summary: 'Every instance this participant takes part in.',
          responses: {
            '200': {
              description: 'Instances, visibility-filtered.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['instances'],
                    properties: {
                      instances: {
                        type: 'array',
                        items: { $ref: '#/components/schemas/InstanceView' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        post: {
          tags: ['instances'],
          operationId: 'createInstance',
          summary: 'Start a quotation or a service instance.',
          description:
            'Relayed by `hostedBy` when the participant filling that role is not one of ours. Identical request and response either way.',
          parameters: [actorRef, idempotencyKey],
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/CreateInstance' } },
            },
          },
          responses: {
            '201': {
              description: 'Created. `ETag` carries the instance’s `seq`.',
              headers: {
                ETag: { schema: { type: 'string' }, description: 'The instance’s `seq`.' },
                Location: { schema: { type: 'string' } },
              },
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/WriteResult' } },
              },
            },
            '403': problemResponse('Not a participant, or no live connection with the home node.'),
            '422': problemResponse('Schema validation, unknown definition, or a failed guard.'),
            '502': problemResponse('The home node did not answer, or answered something invalid.'),
          },
        },
      },
      '/instances/{id}': {
        get: {
          tags: ['instances'],
          operationId: 'getInstance',
          summary: 'One instance, as this participant may see it.',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': {
              description:
                'The instance. `data` has been visibility-filtered, and `redacted` says whether anything was withheld.',
              headers: { ETag: { schema: { type: 'string' } } },
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/InstanceView' } },
              },
            },
            '404': problemResponse(
              'No such instance, or one you may not see. The two are deliberately the same answer.',
            ),
          },
        },
      },
      '/instances/{id}/events': {
        get: {
          tags: ['instances'],
          operationId: 'getEvents',
          summary: 'The signed log, visibility-filtered.',
          description:
            'Verify it yourself with `verifyChain` from `@pilots/protocol` rather than trusting your own connector. A redacted payload is not a verification failure: the header commits to the payload by hash, so a chain verifies even where the values were withheld.',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
            {
              name: 'since',
              in: 'query',
              required: false,
              schema: { type: 'integer', minimum: 0 },
              description: 'A `seq`, not a cursor. Returns everything after it.',
            },
          ],
          responses: {
            '200': {
              description: 'Signed events, oldest first.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['events'],
                    properties: {
                      events: {
                        type: 'array',
                        items: { $ref: '#/components/schemas/SignedEvent' },
                      },
                    },
                  },
                },
              },
            },
            '404': problemResponse('No such instance, or one you may not see.'),
          },
        },
      },
      '/instances/{id}/transitions': {
        post: {
          tags: ['instances'],
          operationId: 'applyTransition',
          summary: 'The one mutating call.',
          description: [
            '"Update a field" and "advance the state" are the same thing: a transition applies an',
            'optional state change and an optional JSON Merge Patch.',
            '',
            '`If-Match` is **required**. Without it you get a `428`, and that is the point: it is how',
            'two parties acting at once produce a conflict instead of a silent overwrite. A `409`',
            'carries the instance’s real `seq` so you can re-read and decide.',
          ].join('\n'),
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
            {
              name: 'If-Match',
              in: 'header',
              required: true,
              schema: { type: 'string' },
              description: 'The instance’s current `seq`, e.g. `"3"`.',
            },
            actorRef,
            idempotencyKey,
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Transition' } },
            },
          },
          responses: {
            '200': {
              description:
                'Applied. Not `201`: a transition advances an instance, it does not create one.',
              headers: { ETag: { schema: { type: 'string' } } },
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/WriteResult' } },
              },
            },
            '403': problemResponse('Your role may not fire this transition.'),
            '409': problemResponse('Stale `If-Match`. The body carries the current `seq`.'),
            '422': problemResponse(
              'Illegal state, unknown transition, schema failure, or a guard.',
            ),
            '428': problemResponse('`If-Match` is required on a mutating call.'),
            '502': problemResponse('The home node did not answer, or answered something invalid.'),
          },
        },
      },
      '/notifications': {
        get: {
          tags: ['delivery'],
          operationId: 'replayNotifications',
          summary: 'Replay notifications from a cursor. Authoritative.',
          description:
            'A backoffice that was down catches up here without operator involvement. Returns everything, delivered or not — deduplicate on `cursor`, which you must do anyway because delivery is at-least-once.',
          parameters: [
            { name: 'since', in: 'query', required: false, schema: { type: 'string' } },
            {
              name: 'limit',
              in: 'query',
              required: false,
              schema: { type: 'integer', minimum: 1, maximum: 500 },
            },
          ],
          responses: {
            '200': {
              description: 'Notification envelopes, oldest first.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['notifications', 'cursor'],
                    properties: {
                      notifications: {
                        type: 'array',
                        items: { $ref: '#/components/schemas/NotificationEnvelope' },
                      },
                      cursor: { type: ['string', 'null'] },
                    },
                  },
                },
              },
            },
          },
        },
      },
      '/events': {
        get: {
          tags: ['delivery'],
          operationId: 'streamEvents',
          summary: 'Server-sent events, for a system that cannot accept inbound connections.',
          description:
            'The same subscription model as a webhook target; only the direction of the connection differs. `id:` carries the cursor, so a reconnect with `Last-Event-ID` resumes exactly where it left off.',
          parameters: [{ name: 'since', in: 'query', required: false, schema: { type: 'string' } }],
          responses: {
            '200': {
              description: 'An event stream of notification envelopes.',
              content: { 'text/event-stream': { schema: { type: 'string' } } },
            },
          },
        },
      },
      '/attachments': {
        post: {
          tags: ['attachments'],
          operationId: 'uploadAttachment',
          summary: 'Upload document bytes.',
          description:
            'Send the raw bytes with their own content type. The connector computes the hash — you do not supply one, and could not usefully: an address you chose for content you supplied proves nothing.',
          requestBody: {
            required: true,
            content: { '*/*': { schema: { type: 'string', format: 'binary' } } },
          },
          responses: {
            '201': {
              description: 'The reference a transition will carry.',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/AttachmentRef' } },
              },
            },
            '422': problemResponse('Empty, or over the connector’s size limit.'),
          },
        },
      },
      '/attachments/{sha256}': {
        get: {
          tags: ['attachments'],
          operationId: 'getAttachment',
          summary: 'Document bytes, if you may read them.',
          description:
            'Who may read a document is derived from `visibility`, not declared separately: if the hash appears in your filtered view of the data, you may read the bytes. If this connector does not hold them, it pulls from the home node first.',
          parameters: [{ name: 'sha256', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': {
              description: 'The bytes, with their original content type.',
              content: { '*/*': { schema: { type: 'string', format: 'binary' } } },
            },
            '404': problemResponse(
              'No such document, or one you may not read. Deliberately the same answer.',
            ),
          },
        },
      },
    },
    components: {
      securitySchemes: {
        apiKey: {
          type: 'http',
          scheme: 'ApiKey',
          description:
            'An API key minted in the admin UI, scoped to one participant and to a set of operations. `Authorization: ApiKey ak_….…`',
        },
      },
      schemas: {
        Instance: component(Instance),
        InstanceView: {
          allOf: [
            { $ref: '#/components/schemas/Instance' },
            {
              type: 'object',
              required: ['home', 'available', 'redacted', 'outcome'],
              properties: {
                home: {
                  type: 'boolean',
                  description: 'Whether this connector holds the authoritative copy.',
                },
                available: {
                  type: 'array',
                  description:
                    'What this participant may fire right now, computed from the definition. Render buttons from it and a new definition needs no client work.',
                  items: {
                    type: 'object',
                    required: ['transition', 'role'],
                    properties: {
                      transition: { type: 'string' },
                      role: { type: 'string' },
                    },
                  },
                },
                redacted: {
                  type: 'boolean',
                  description: 'True when the visibility filter withheld something from this view.',
                },
                outcome: {
                  type: 'string',
                  enum: ['running', 'fulfilled', 'abandoned'],
                  description:
                    'Whether the process is over, and how — computed from the definition. The generic companion to `state`: `state` is the definition’s own vocabulary, this is the half you can act on without holding that definition. Close a ticket on `fulfilled` rather than hardcoding that `VGM_ISSUED` is one process’s good ending.',
                },
              },
            },
          ],
        },
        SignedEvent: component(SignedEvent),
        Connection: component(Connection),
        Offering: component(Offering),
        NotificationEnvelope: component(NotificationEnvelope),
        AttachmentRef: component(AttachmentRef),
        DefinitionSummary: {
          type: 'object',
          required: ['ref', 'title', 'kind', 'contentHash'],
          properties: {
            ref: { type: 'string' },
            title: { type: 'string' },
            kind: { type: 'string', enum: ['quotation', 'service'] },
            contentHash: { type: 'string' },
          },
        },
        CreateInstance: {
          type: 'object',
          required: ['definition', 'participants'],
          properties: {
            definition: { type: 'string', description: '`container-transport@1.0.0`.' },
            participants: {
              type: 'object',
              description:
                'Which participant fills each role. Only an instance names participants; a definition names a role.',
              additionalProperties: {
                oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
              },
            },
            data: { type: 'object' },
            quotationId: { type: ['string', 'null'] },
            offering: { type: ['string', 'null'] },
          },
        },
        Transition: {
          type: 'object',
          required: ['transition'],
          properties: {
            transition: { type: 'string' },
            patch: {
              type: ['object', 'null'],
              description: 'JSON Merge Patch (RFC 7386) against `data`. `null` deletes a key.',
            },
            attachments: {
              type: 'array',
              items: { $ref: '#/components/schemas/AttachmentRef' },
            },
          },
        },
        WriteResult: {
          type: 'object',
          required: ['instance', 'events'],
          properties: {
            instance: { $ref: '#/components/schemas/InstanceView' },
            events: {
              type: 'array',
              description:
                'Everything the call produced — the transition, plus any `auto` that followed it.',
              items: { $ref: '#/components/schemas/SignedEvent' },
            },
          },
        },
        Problem: {
          type: 'object',
          description: `RFC 7807. Branch on \`type\`, not on the status: a ${Problem.seqConflict} needs a fresh decision, a ${Problem.peerUnreachable} is worth retrying unchanged, and a ${Problem.peerResponseInvalid} is not.`,
          required: ['type', 'title', 'status'],
          properties: {
            type: { type: 'string', description: `Prefixed \`${PROBLEM_PREFIX}\`.` },
            title: { type: 'string' },
            status: { type: 'integer' },
            detail: { type: 'string' },
            seq: {
              type: 'integer',
              description: 'On a `409`: what the instance’s `seq` actually is.',
            },
            errors: {
              type: 'array',
              items: {
                type: 'object',
                required: ['type', 'detail'],
                properties: {
                  type: { type: 'string' },
                  detail: { type: 'string' },
                  pointer: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
  }
}
