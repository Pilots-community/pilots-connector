/**
 * Three logs, three jobs — and this is where two of them meet.
 *
 * The **application log** is structured JSON on stdout, shaped for an ordinary
 * log sink. It must record every rejected authentication, every authorisation
 * failure, and every attempt to change something the caller was not entitled to
 * change: the class of event that by definition produces no business event.
 *
 * The **audit log** lives in the store, hash-chained and never replicated.
 *
 * `record()` reaches both from **one call site**, which is the point. Requiring
 * every refusal to be written twice, in two places, is how the two drift apart —
 * and a drifted audit trail is worse than none, because it is trusted.
 */
import { pino, type Logger as PinoLogger } from 'pino'

import type { AuditCategory, AuditEntry, AuditOutcome } from '@pilots/protocol'

import type { AuditLog } from '../store/types.js'

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace'

/** What an audited call site states. `seq`, `prev` and `at` are not its business. */
export interface AuditDraft {
  participantId: string
  category: AuditCategory
  action: string
  actor: AuditEntry['actor']
  outcome: AuditOutcome
  subject?: Partial<AuditEntry['subject']>
  problem?: string | null
  detail?: string | null
  request?: AuditEntry['request']
}

export interface RecordInput {
  level: LogLevel
  message: string
  audit: AuditDraft
  /** Extra fields for the application log only. Never written to the audit log. */
  context?: Record<string, unknown>
}

const EMPTY_SUBJECT: AuditEntry['subject'] = {
  instance: null,
  connection: null,
  apiKey: null,
  subscription: null,
  offering: null,
  definition: null,
}

export class LogService {
  constructor(
    private readonly logger: PinoLogger,
    private readonly auditLog: AuditLog,
    private readonly now: () => string,
  ) {}

  static create(options: {
    level: LogLevel | 'silent'
    pretty: boolean
    auditLog: AuditLog
    now: () => string
    destination?: NodeJS.WritableStream
  }): LogService {
    const logger = pino(
      {
        level: options.level,
        base: undefined,
        // The application log is a stream someone greps at 3am; keep the shape
        // boring and the timestamps ISO.
        timestamp: () => `,"time":"${options.now()}"`,
        formatters: { level: (label) => ({ level: label }) },
        redact: {
          paths: ['secret', '*.secret', 'privateJwk', '*.privateJwk', 'pepper', '*.pepper'],
          censor: '[redacted]',
        },
      },
      options.destination ?? process.stdout,
    )
    return new LogService(logger, options.auditLog, options.now)
  }

  child(bindings: Record<string, unknown>): LogService {
    return new LogService(this.logger.child(bindings), this.auditLog, this.now)
  }

  debug(context: Record<string, unknown>, message: string): void {
    this.logger.debug(context, message)
  }

  info(context: Record<string, unknown>, message: string): void {
    this.logger.info(context, message)
  }

  warn(context: Record<string, unknown>, message: string): void {
    this.logger.warn(context, message)
  }

  error(context: Record<string, unknown>, message: string): void {
    this.logger.error(context, message)
  }

  /**
   * Write to the application log **and** the audit log, from one call site.
   *
   * Awaited on purpose: a mutating call must be durably audited before the
   * caller is told it succeeded, or a crash loses the only record that it
   * happened. Read-auditing is the configurable, cheap case — see `auditReads`.
   */
  async record(input: RecordInput): Promise<AuditEntry> {
    const { audit } = input
    const entry = await this.auditLog.append({
      at: this.now(),
      participantId: audit.participantId,
      category: audit.category,
      action: audit.action,
      actor: audit.actor,
      subject: { ...EMPTY_SUBJECT, ...audit.subject },
      outcome: audit.outcome,
      problem: audit.problem ?? null,
      detail: audit.detail ?? null,
      request: audit.request ?? null,
    })

    this.logger[input.level](
      {
        ...input.context,
        audit: {
          seq: entry.seq,
          action: entry.action,
          outcome: entry.outcome,
          actor: entry.actor.kind,
          participantId: entry.participantId,
        },
        ...(entry.problem === null ? {} : { problem: entry.problem }),
      },
      input.message,
    )

    return entry
  }
}

export const LOG_SERVICE = Symbol('LogService')
