/**
 * `@pilots/protocol` — the specification.
 *
 * If behaviour is not expressed here as a schema or a tested function, it is not
 * decided. Everything downstream — the connector, the client, the UIs — reads
 * the process definition through this package rather than reimplementing any
 * part of it.
 *
 * The two network-touching pieces live elsewhere on purpose:
 *   `@pilots/protocol/did-web`  the HTTPS `did:web` resolver
 *   `@pilots/protocol/testing`  deterministic doubles for the ports
 */

// — primitives —
export {
  EMPTY_PAYLOAD_HASH,
  canonicalBytes,
  canonicalise,
  hashJson,
  isSha256,
  sha256,
  type Sha256,
} from './canonical.js'
export {
  cloneJson,
  isJsonArray,
  isJsonObject,
  type JsonArray,
  type JsonObject,
  type JsonPrimitive,
  type JsonValue,
} from './json.js'
export { applyMergePatch } from './merge-patch.js'
export { DURATION_SUBSET, isDuration, parseDuration } from './duration.js'
export { err, ok, type Result } from './result.js'
export {
  PROBLEM_PREFIX,
  PROBLEM_STATUS,
  Problem,
  protocolError,
  statusFor,
  type ProblemType,
  type ProtocolError,
} from './problems.js'

// — ports —
export { fromInstant, nowInstant, systemClock, toInstant, type Clock } from './ports/clock.js'
export { ulidGenerator, type IdGenerator } from './ports/id-generator.js'
export { UnknownParticipantError, type Signer } from './ports/signer.js'
export {
  DidDocument,
  PublicKeyJwk,
  VerificationMethod,
  cachingDidResolver,
  didWebOrigin,
  didWebUrl,
  findVerificationMethod,
  staticDidResolver,
  type DidResolver,
} from './ports/did-resolver.js'

// — crypto —
export {
  protectedHeaderOf,
  signDetachedJws,
  verifyDetachedJws,
  type JwsProtectedHeader,
} from './crypto/jws.js'
export {
  LocalEd25519Signer,
  buildDidDocument,
  type GenerateSpec,
  type ParticipantKey,
} from './crypto/local-signer.js'

// — schemas —
export * from './schemas/common.js'
export * from './schemas/definition.js'
export * from './schemas/instance.js'
export * from './schemas/event.js'
export * from './schemas/connection.js'
export * from './schemas/offering.js'
export * from './schemas/api-key.js'
export * from './schemas/audit.js'
export * from './schemas/subscription.js'

// — the engine —
export {
  actionRequired,
  autoTransitions,
  availableTransitions,
  evaluateCreate,
  evaluateTransition,
  type CreateRequest,
  type EvaluatorOptions,
  type TransitionActor,
  type TransitionOutcome,
  type TransitionRequest,
} from './engine/evaluator.js'
export {
  buildEventHeader,
  filterEvent,
  foldEvents,
  headerHash,
  signEvent,
  verifyChain,
  type ChainFailure,
  type ChainVerification,
  type EventDraft,
  type FoldResult,
  type VerifyChainOptions,
} from './engine/chain.js'
export {
  auditEntryHash,
  chainAuditEntry,
  verifyAuditChain,
  type AuditChainVerification,
  type AuditEntryDraft,
} from './engine/audit-chain.js'
export {
  canReadPath,
  filterData,
  filterInstance,
  filterPayload,
  type Filtered,
} from './engine/visibility.js'

// — validation and linting —
export {
  createSchemaValidator,
  defaultSchemaValidator,
  type SchemaValidator,
} from './validation/ajv.js'
export {
  formatDiagnostic,
  lintDefinition,
  type LintDiagnostic,
  type LintResult,
  type LintSeverity,
} from './lint/linter.js'
export { SCHEMA_BASE_URI, protocolJsonSchemas, type ExportedSchemaName } from './schema-export.js'
