/**
 * What a refusal looks like to an integrator.
 *
 * Every surface answers RFC 7807, and the whole point of that is that a client
 * can branch on `type` rather than on a status code it has to guess the meaning
 * of. The three distinctions this file exists to preserve:
 *
 * - A **`409`** is a real sequence conflict: somebody else moved the instance.
 *   Re-read, decide, retry. `seq` says where it actually is.
 * - A **`502 peer-unreachable`** is a network fault. Retry the same call
 *   unchanged; nothing happened.
 * - A **`502 peer-response-invalid`** is a peer that answered something that did
 *   not verify. Do not retry — retrying a liar produces another lie.
 *
 * Collapsing any two of those is what makes retry logic unwriteable, which is
 * why they are separate types on the wire and separate predicates here.
 */
import { Problem } from '@pilots/protocol'

export interface ProblemDocument {
  type: string
  title: string
  status: number
  detail?: string
  /** The individual failures, when a request had more than one thing wrong. */
  errors?: Array<{ type: string; detail: string; pointer?: string }>
  /** Present on a `409`: what the instance's `seq` actually is. */
  seq?: number
  [key: string]: unknown
}

export class ProblemError extends Error {
  readonly type: string
  readonly status: number
  readonly detail: string | undefined
  readonly problem: ProblemDocument

  constructor(problem: ProblemDocument) {
    super(problem.detail ?? problem.title ?? `request failed with ${problem.status}`)
    this.name = 'ProblemError'
    this.type = problem.type
    this.status = problem.status
    this.detail = problem.detail
    this.problem = problem
  }

  /** The `seq` the instance is actually at, on a conflict. */
  get seq(): number | undefined {
    return typeof this.problem.seq === 'number' ? this.problem.seq : undefined
  }

  /** Somebody else moved the instance. Re-read and decide. */
  get isConflict(): boolean {
    return this.type === Problem.seqConflict
  }

  /**
   * Worth trying again **unchanged**.
   *
   * Only a peer that did not answer. Not a `409` — that needs a fresh decision,
   * not a retry — and emphatically not `peer-response-invalid`.
   */
  get isRetryable(): boolean {
    return this.type === Problem.peerUnreachable
  }

  /** The caller may not do this: wrong role, missing scope, or no live connection. */
  get isForbidden(): boolean {
    return (
      this.type === Problem.roleNotPermitted ||
      this.type === Problem.notAParticipant ||
      this.type === Problem.scopeMissing ||
      this.type === Problem.connectionNotActive
    )
  }

  /** Every failure, when the request had more than one thing wrong with it. */
  get failures(): Array<{ type: string; detail: string; pointer?: string }> {
    return this.problem.errors ?? [{ type: this.type, detail: this.detail ?? this.message }]
  }
}

/** Thrown when the connector could not be reached at all. Not a `ProblemError`. */
export class TransportError extends Error {
  constructor(
    readonly url: string,
    cause: unknown,
  ) {
    super(`could not reach the connector at ${url}: ${describe(cause)}`)
    this.name = 'TransportError'
    this.cause = cause
  }
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

export function isProblemDocument(value: unknown): value is ProblemDocument {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<ProblemDocument>
  return typeof candidate.type === 'string' && typeof candidate.status === 'number'
}
