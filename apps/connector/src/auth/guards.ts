/**
 * Three surfaces, three auth layers, no privileged path.
 *
 * The auth boundary is visible in the URL, and nothing is accepted across it: a
 * session is never a bearer token, an API key never authenticates a peer. Each
 * guard below refuses everything the others accept.
 *
 * **Every rejection is recorded**, in the application log and the audit log,
 * because a refused request produces no business event and would otherwise leave
 * no trace at all.
 */
import { CanActivate, Inject, Injectable, SetMetadata, type ExecutionContext } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import type { FastifyRequest } from 'fastify'

import { Problem, hasScope, type ScopedOperation } from '@pilots/protocol'

import type { CallerContext } from '../instances/instance.service.js'
import { LOG_SERVICE, type AuditDraft, type LogService } from '../logging/log.service.js'
import { ProblemException } from '../http/problem.js'
import {
  ADMIN_SESSIONS,
  type AdminSession,
  type AdminSessionService,
} from './admin-session.service.js'
import { API_KEYS, type ApiKeyService } from './api-key.tokens.js'
import { IDENTITY, type Identity } from '../identity/identity.service.js'

/** The operation a route needs, from the one table in `@pilots/protocol`. */
export const REQUIRES_SCOPE = 'pilots:requiresScope'
export const RequireScope = (operation: ScopedOperation): MethodDecorator =>
  SetMetadata(REQUIRES_SCOPE, operation)

export interface LocalRequest extends FastifyRequest {
  caller?: CallerContext
  apiKeyId?: string
}

export interface AdminRequest extends FastifyRequest {
  session?: AdminSession
}

function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name]
  return Array.isArray(value) ? value[0] : value
}

function auditRequest(request: FastifyRequest): AuditDraft['request'] {
  return {
    method: request.method,
    path: request.url,
    ip: request.ip ?? null,
    jti: null,
  }
}

/**
 * `/api/local/v1` — API key + scopes, plus an asserted `X-Actor-Ref`.
 *
 * The connector authenticates the *key*, not the person behind it. `X-Actor-Ref`
 * is an opaque audit hint: recorded on every call, attached to the resulting
 * event as unsigned local metadata, and **never** part of the signed header.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    @Inject(API_KEYS) private readonly keys: ApiKeyService,
    @Inject(IDENTITY) private readonly identity: Identity,
    @Inject(LOG_SERVICE) private readonly log: LogService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<LocalRequest>()
    const authorization = header(request, 'authorization')
    const presented = authorization?.startsWith('ApiKey ')
      ? authorization.slice('ApiKey '.length).trim()
      : undefined

    const verified = await this.keys.verify(presented)
    if (!verified.ok) {
      // The caller gets a flat 401; the reason goes to the logs. Telling an
      // unauthenticated caller *why* is free enumeration.
      // Audited against the connector's own participant, not a placeholder: an
      // entry filed under a participant that does not exist is an entry the
      // operator cannot read, and a rejected credential is exactly the event
      // the audit log exists to record.
      await this.log.record({
        level: 'warn',
        message: 'api key rejected',
        audit: {
          participantId: this.identity.all[0]?.id ?? 'unknown',
          category: 'local',
          action: 'auth.apiKey',
          actor: { kind: 'apiKey', id: verified.keyId ?? 'none', actorRef: null },
          outcome: 'denied',
          problem: Problem.credentialInvalid,
          detail: `api key ${verified.reason}`,
          request: auditRequest(request),
        },
      })
      throw ProblemException.of(Problem.credentialInvalid, 'invalid API key')
    }

    const participant = this.identity.participant(verified.key.participantId)
    if (!participant) {
      throw ProblemException.of(Problem.credentialInvalid, 'invalid API key')
    }

    const operation = this.reflector.get<ScopedOperation | undefined>(
      REQUIRES_SCOPE,
      context.getHandler(),
    )
    if (operation !== undefined && !hasScope(verified.key, operation)) {
      await this.log.record({
        level: 'warn',
        message: 'api key lacks the required scope',
        audit: {
          participantId: participant.id,
          category: 'local',
          action: `scope.${operation}`,
          actor: {
            kind: 'apiKey',
            id: verified.key.id,
            actorRef: header(request, 'x-actor-ref') ?? null,
          },
          outcome: 'denied',
          problem: Problem.scopeMissing,
          detail: `${operation} requires a scope this key does not hold`,
          request: auditRequest(request),
        },
      })
      throw ProblemException.of(Problem.scopeMissing, `this key may not perform ${operation}`)
    }

    const actorRef = header(request, 'x-actor-ref')
    request.caller = {
      participant,
      actorRef: actorRef !== undefined && actorRef.length <= 255 ? actorRef : null,
    }
    request.apiKeyId = verified.key.id
    await this.keys.touch(verified.key)
    return true
  }
}

/** `/api/admin/v1` — an admin session, and nothing else. */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(
    @Inject(ADMIN_SESSIONS) private readonly sessions: AdminSessionService,
    @Inject(LOG_SERVICE) private readonly log: LogService,
    @Inject(IDENTITY) private readonly identity: Identity,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AdminRequest>()
    const authorization = header(request, 'authorization')
    const presented = authorization?.startsWith('Session ')
      ? authorization.slice('Session '.length).trim()
      : undefined

    const session = this.sessions.verify(presented)
    if (!session) {
      await this.log.record({
        level: 'warn',
        message: 'admin session rejected',
        audit: {
          participantId: this.identity.all[0]?.id ?? 'unknown',
          category: 'admin',
          action: 'auth.adminSession',
          actor: { kind: 'adminSession', id: 'none', actorRef: null },
          outcome: 'denied',
          problem: Problem.credentialInvalid,
          detail: 'missing or expired admin session',
          request: auditRequest(request),
        },
      })
      throw ProblemException.of(Problem.credentialInvalid, 'admin session required')
    }

    request.session = session
    return true
  }
}

/**
 * `/api/peer/v1` — a JWS bearer token, `did:web`-resolved.
 *
 * The verification itself arrives in M3 together with the connection handshake.
 * Until then the surface exists and refuses everything, which is the right
 * behaviour for a node with no peers: retrofitting the surface split later would
 * touch every route.
 */
@Injectable()
export class PeerGuard implements CanActivate {
  constructor(
    @Inject(LOG_SERVICE) private readonly log: LogService,
    @Inject(IDENTITY) private readonly identity: Identity,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>()
    await this.log.record({
      level: 'warn',
      message: 'peer request refused: node-to-node auth is not enabled',
      audit: {
        participantId: this.identity.all[0]?.id ?? 'unknown',
        category: 'peer',
        action: 'auth.peer',
        actor: {
          kind: 'peer',
          id: header(request, 'authorization') === undefined ? 'anonymous' : 'presented',
          actorRef: null,
        },
        outcome: 'denied',
        problem: Problem.credentialInvalid,
        detail: 'peer authentication is not enabled on this connector',
        request: auditRequest(request),
      },
    })
    throw ProblemException.of(
      Problem.credentialInvalid,
      'this connector has no peer connections enabled',
    )
  }
}

export { auditRequest, header }
