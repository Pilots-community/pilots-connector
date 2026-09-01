/**
 * Every error leaves as `application/problem+json`.
 *
 * Including the ones Nest raises itself, and including the ones nobody planned
 * for: a 500 that arrives as an HTML stack trace is a 500 an integrator cannot
 * handle, and an unhandled error that reaches a client without reaching the
 * application log is one nobody ever finds.
 */
import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common'
import type { FastifyReply } from 'fastify'

import type { LogService } from '../logging/log.service.js'
import { PROBLEM_CONTENT_TYPE, ProblemException, type ProblemDocument } from './problem.js'

@Catch()
export class ProblemFilter implements ExceptionFilter {
  constructor(private readonly log: LogService) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>()
    const problem = this.toProblem(exception)

    if (problem.status >= 500) {
      this.log.error(
        {
          err:
            exception instanceof Error
              ? { message: exception.message, stack: exception.stack }
              : exception,
          status: problem.status,
        },
        'unhandled error',
      )
    }

    void reply.status(problem.status).type(PROBLEM_CONTENT_TYPE).send(problem)
  }

  private toProblem(exception: unknown): ProblemDocument {
    if (exception instanceof ProblemException) return exception.problem

    if (exception instanceof HttpException) {
      const status = exception.getStatus()
      const response = exception.getResponse()
      const detail =
        typeof response === 'string'
          ? response
          : ((response as { message?: string | string[] }).message ?? exception.message)
      return {
        type: 'about:blank',
        title: exception.name.replace(/Exception$/, ''),
        status,
        detail: Array.isArray(detail) ? detail.join('; ') : detail,
      }
    }

    return {
      type: 'about:blank',
      title: 'Internal Server Error',
      status: 500,
      // Never the message: an unhandled error's text is for the operator's log,
      // not for whoever happened to send the request.
      detail: 'the connector failed to handle this request',
    }
  }
}
