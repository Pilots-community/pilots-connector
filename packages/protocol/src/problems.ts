/**
 * Problem types, RFC 7807.
 *
 * These live in the spec package rather than in the connector so that the
 * evaluator, the connector's HTTP layer, the audit log and any third-party
 * client all name the same failure the same way. A problem type is part of the
 * wire contract; inventing one at a route is how two surfaces start disagreeing.
 */

export const PROBLEM_PREFIX = 'urn:pilots:problem:'

export const Problem = {
  // — the state machine, evaluated in packages/protocol —
  /** The transition id is not in this definition. */
  unknownTransition: `${PROBLEM_PREFIX}unknown-transition`,
  /** The caller holds no role listed in the transition's `by`. */
  roleNotPermitted: `${PROBLEM_PREFIX}role-not-permitted`,
  /** The instance's current state is not in the transition's `from`. */
  illegalState: `${PROBLEM_PREFIX}illegal-state`,
  /** The instance is in a terminal state and cannot advance. */
  instanceTerminal: `${PROBLEM_PREFIX}instance-terminal`,
  /** The patch, or the resulting data document, failed a definition-supplied JSON Schema. */
  schemaInvalid: `${PROBLEM_PREFIX}schema-invalid`,
  /** A guard did not hold on the data document after the patch. */
  guardFailed: `${PROBLEM_PREFIX}guard-failed`,
  /** The transition requires attachments and none were supplied, or their mime type is wrong. */
  attachmentsInvalid: `${PROBLEM_PREFIX}attachments-invalid`,
  /** The caller's DID is not in the instance's `participants` map. */
  notAParticipant: `${PROBLEM_PREFIX}not-a-participant`,
  /** The definition itself does not load: bad schema, or the linter refused it. */
  definitionInvalid: `${PROBLEM_PREFIX}definition-invalid`,
  /**
   * The instance, as asked for, has no path to any fulfilled state.
   *
   * Almost always because the definition reaches fulfilment only through a
   * transition a link fires, and the relation that link names was not set at
   * creation. That relation is part of the immutable genesis, so it can never
   * be supplied later: the instance could only ever be abandoned.
   */
  instanceUnfulfillable: `${PROBLEM_PREFIX}instance-unfulfillable`,

  // — concurrency and idempotency —
  /** `If-Match` did not equal the current `seq`. */
  seqConflict: `${PROBLEM_PREFIX}seq-conflict`,
  /** `If-Match` absent on a mutating call. */
  preconditionRequired: `${PROBLEM_PREFIX}precondition-required`,

  // — identity, authentication, authorisation —
  /** Missing, malformed, expired or unverifiable credential. */
  credentialInvalid: `${PROBLEM_PREFIX}credential-invalid`,
  /** The API key lacks the scope this operation requires. */
  scopeMissing: `${PROBLEM_PREFIX}scope-missing`,
  /** There is no `ACTIVE` connection between the caller and the home node. */
  connectionNotActive: `${PROBLEM_PREFIX}connection-not-active`,

  // — the chain —
  /** `prev` did not match, or `from` did not match the state computed after `seq - 1`. */
  chainBroken: `${PROBLEM_PREFIX}chain-broken`,
  /** The event's signature did not verify against the resolved DID document. */
  signatureInvalid: `${PROBLEM_PREFIX}signature-invalid`,
  /** The payload did not hash to the header's `payloadHash`. */
  payloadHashMismatch: `${PROBLEM_PREFIX}payload-hash-mismatch`,

  // — relaying, which is not the same thing as a business conflict —
  /** The home node did not answer. Retryable. */
  peerUnreachable: `${PROBLEM_PREFIX}peer-unreachable`,
  /** The peer answered, but the response failed verification. Not retryable. */
  peerResponseInvalid: `${PROBLEM_PREFIX}peer-response-invalid`,
} as const

export type ProblemType = (typeof Problem)[keyof typeof Problem]

/**
 * The HTTP status each problem maps to. One table, so the same failure cannot
 * come back as a 403 on one surface and a 422 on another.
 */
export const PROBLEM_STATUS: Record<ProblemType, number> = {
  [Problem.unknownTransition]: 422,
  [Problem.roleNotPermitted]: 403,
  [Problem.illegalState]: 422,
  [Problem.instanceTerminal]: 422,
  [Problem.schemaInvalid]: 422,
  [Problem.guardFailed]: 422,
  [Problem.attachmentsInvalid]: 422,
  [Problem.notAParticipant]: 403,
  [Problem.definitionInvalid]: 422,
  [Problem.instanceUnfulfillable]: 422,
  [Problem.seqConflict]: 409,
  [Problem.preconditionRequired]: 428,
  [Problem.credentialInvalid]: 401,
  [Problem.scopeMissing]: 403,
  [Problem.connectionNotActive]: 403,
  [Problem.chainBroken]: 422,
  [Problem.signatureInvalid]: 401,
  [Problem.payloadHashMismatch]: 422,
  [Problem.peerUnreachable]: 502,
  [Problem.peerResponseInvalid]: 502,
}

/** One machine-readable reason a request was refused. */
export interface ProtocolError {
  type: ProblemType
  /** Human-readable, one sentence, safe to show a caller. */
  detail: string
  /** A JSON pointer or dotted path into the offending document, where there is one. */
  pointer?: string
}

export function protocolError(type: ProblemType, detail: string, pointer?: string): ProtocolError {
  return pointer === undefined ? { type, detail } : { type, detail, pointer }
}

/** The status a set of errors should be reported under: the most specific wins. */
export function statusFor(errors: readonly ProtocolError[]): number {
  let status = 422
  for (const error of errors) {
    const candidate = PROBLEM_STATUS[error.type] ?? 422
    if (candidate === 401 || candidate === 403) return candidate
    status = candidate
  }
  return status
}
