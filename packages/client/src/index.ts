/**
 * `@pilots/client` — the integration surface.
 *
 * Two things ship here, and they are the same contract in two forms: a typed
 * client for TypeScript callers, and an OpenAPI document so a non-TypeScript
 * integrator generates their own rather than reimplementing this one by eye.
 *
 * It talks to `/api/local/v1` and nothing else. Our own process UI uses it on
 * exactly the terms anybody else does — if a feature ever needs a route only our
 * UI can call, that is a design failure rather than a shortcut.
 */
export { PilotsClient } from './client.js'
export { ProblemError, TransportError, isProblemDocument, type ProblemDocument } from './errors.js'
export { OPENAPI_VERSION, localApiDocument } from './openapi.js'
export type {
  AttachmentRef,
  AvailableAction,
  ClientOptions,
  Connection,
  CreateInstanceRequest,
  DefinitionSummary,
  Instance,
  InstanceView,
  JsonObject,
  NotificationEnvelope,
  Offering,
  ParticipantMap,
  ProcessDefinition,
  RequestOptions,
  SignedEvent,
  TransitionRequest,
  WriteResult,
} from './types.js'
