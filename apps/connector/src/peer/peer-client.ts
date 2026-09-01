/**
 * The outbound half of node-to-node auth: one place that mints bearer tokens.
 *
 * Every cross-connector call in the connector goes through here — the connection
 * handshake, the relay, and peer delivery alike. That is deliberate: a second
 * place that signed its own tokens would be a second place to get the audience
 * check, the lifetime or the `jti` wrong, and the failure would look like a
 * peer's fault rather than ours.
 */
import { signPeerToken, type Clock, type Signer } from '@pilots/protocol'

import type { ParticipantConfig } from '../config/config.js'
import {
  PeerUnreachableError,
  type PeerRequest,
  type PeerResponse,
  type PeerTransport,
  type StreamMessage,
  type StreamSubscription,
} from './transport.js'

export interface PeerAddress {
  did: string
  baseUrl: string
}

export interface PeerCall {
  method: PeerRequest['method']
  path: string
  body?: unknown
  headers?: Record<string, string>
}

export class PeerClient {
  constructor(
    private readonly transport: PeerTransport,
    private readonly signer: Signer,
    private readonly clock: Clock,
    private readonly nextId: () => string,
  ) {}

  private async authorize(from: ParticipantConfig, to: PeerAddress): Promise<string> {
    const token = await signPeerToken(this.signer, from.id, {
      iss: from.did,
      aud: to.did,
      // A fresh `jti` per call. The peer rejects a repeat, so reusing one would
      // make our own second call fail rather than theirs.
      jti: this.nextId(),
      nowMs: this.clock.now(),
    })
    return `Bearer ${token}`
  }

  /** One request. Throws `PeerUnreachableError`; every other outcome is a response. */
  async call(from: ParticipantConfig, to: PeerAddress, request: PeerCall): Promise<PeerResponse> {
    const authorization = await this.authorize(from, to)
    return this.transport.send(to.baseUrl, {
      method: request.method,
      path: request.path,
      headers: { ...request.headers, authorization, 'content-type': 'application/json' },
      ...(request.body === undefined ? {} : { body: request.body }),
    })
  }

  /**
   * Hold a stream open against a peer.
   *
   * This is what lets a one-truck haulier take part with no inbound endpoint, no
   * DNS entry and no certificate: the small party dials out and keeps the line
   * open, and events come back down it.
   */
  async open(
    from: ParticipantConfig,
    to: PeerAddress,
    path: string,
    handlers: { onMessage: (message: StreamMessage) => void; onClose?: (reason: string) => void },
    headers: Record<string, string> = {},
  ): Promise<StreamSubscription> {
    const authorization = await this.authorize(from, to)
    return this.transport.open(
      to.baseUrl,
      { method: 'GET', path, headers: { ...headers, authorization } },
      handlers,
    )
  }
}

export { PeerUnreachableError }
