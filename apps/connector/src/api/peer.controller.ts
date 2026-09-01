/**
 * `/api/peer/v1` — the node-to-node surface.
 *
 * It exists from the first milestone even though it can do nothing yet, because
 * retrofitting the surface split later would touch every route. The guard
 * refuses every request and audits the refusal; the handshake, JWS bearer
 * verification and replication arrive together in M3.
 */
import { All, Controller, UseGuards } from '@nestjs/common'

import { PeerGuard } from '../auth/guards.js'

@Controller('api/peer/v1')
@UseGuards(PeerGuard)
export class PeerController {
  @All('*')
  refuse(): never {
    // Unreachable: the guard rejects first. Present so the surface answers with
    // a problem document rather than a 404 that says nothing.
    throw new Error('unreachable')
  }
}
