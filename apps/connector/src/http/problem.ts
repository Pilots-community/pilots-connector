/**
 * RFC 7807 problem details, on all three surfaces.
 *
 * The status a problem maps to lives in `@pilots/protocol`, not here, so the
 * same failure cannot come back as a 403 on one surface and a 422 on another.
 *
 * One rule this file exists to enforce: a `409` from the home node is a business
 * conflict and a `502` is a network fault, and collapsing the two would make
 * retry logic on the integrator's side unwriteable.
 */
import { HttpException } from '@nestjs/common'

import { PROBLEM_STATUS, Problem, statusFor, type ProtocolError } from '@pilots/protocol'

export const PROBLEM_CONTENT_TYPE = 'application/problem+json'

export interface ProblemDocument {
  type: string
  title: string
  status: number
  detail?: string
  /** The individual failures, so a caller can fix them all at once. */
  errors?: Array<{ type: string; detail: string; pointer?: string }>
  /** Present on a `409`, so a client can retry against the right `seq`. */
  seq?: number
  [key: string]: unknown
}

export { titleFor } from './problem-titles.js'
import { titleFor } from './problem-titles.js'

/**
 * An HTTP failure carrying a problem document.
 *
 * Nest's own exceptions produce `{ statusCode, message }`; this produces RFC
 * 7807, which is what every surface promises.
 */
export class ProblemException extends HttpException {
  constructor(readonly problem: ProblemDocument) {
    super(problem, problem.status)
  }

  static from(
    errors: readonly ProtocolError[],
    extra: Partial<ProblemDocument> = {},
  ): ProblemException {
    const primary = errors[0]
    const status = errors.length > 0 ? statusFor(errors) : 422
    const type = primary?.type ?? Problem.schemaInvalid
    return new ProblemException({
      type,
      title: titleFor(type),
      status,
      ...(primary?.detail === undefined ? {} : { detail: primary.detail }),
      ...(errors.length > 1
        ? {
            errors: errors.map((error) => ({
              type: error.type,
              detail: error.detail,
              ...(error.pointer === undefined ? {} : { pointer: error.pointer }),
            })),
          }
        : {}),
      ...extra,
    })
  }

  static of(type: string, detail: string, extra: Partial<ProblemDocument> = {}): ProblemException {
    return new ProblemException({
      type,
      title: titleFor(type),
      status: PROBLEM_STATUS[type as keyof typeof PROBLEM_STATUS] ?? 400,
      detail,
      ...extra,
    })
  }

  /** `404`, used for both "no such instance" and "one you may not see". */
  static notFound(detail = 'not found'): ProblemException {
    return new ProblemException({
      type: 'about:blank',
      title: 'Not found',
      status: 404,
      detail,
    })
  }

  static badRequest(detail: string): ProblemException {
    return new ProblemException({
      type: 'about:blank',
      title: 'Bad request',
      status: 400,
      detail,
    })
  }
}
