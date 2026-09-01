/**
 * `/.well-known/did.json` — static, unauthenticated, and not an API surface.
 *
 * This one file is the whole of a participant's published identity. Onboarding
 * is publishing it and accepting one connection request; there is nothing to
 * run at the other end, which is what keeps a small party from needing DNS
 * tricks, a certificate authority, or an inbound firewall rule beyond ordinary
 * HTTPS hosting.
 */
import { Controller, Get, Inject, Param, Res } from '@nestjs/common'
import type { FastifyReply } from 'fastify'

import { ProblemException } from '../http/problem.js'
import { IDENTITY, type Identity } from '../identity/identity.service.js'

@Controller()
export class WellKnownController {
  constructor(@Inject(IDENTITY) private readonly identity: Identity) {}

  @Get('.well-known/did.json')
  async didDocument(@Res({ passthrough: true }) reply: FastifyReply) {
    void reply.type('application/did+json')
    return this.identity.wellKnownDidDocument()
  }

  /**
   * `did:web` path segments, so a hosted tenant has a real, resolvable DID of
   * its own — `did:web:connectors.example:t:acme` resolves here.
   */
  @Get('t/:participantId/did.json')
  async tenantDidDocument(
    @Param('participantId') participantId: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    if (!this.identity.participant(participantId)) {
      throw ProblemException.notFound(`no participant ${participantId}`)
    }
    void reply.type('application/did+json')
    return this.identity.didDocument(participantId)
  }

  @Get('healthz')
  health() {
    return { status: 'ok' }
  }
}
