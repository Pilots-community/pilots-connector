/**
 * `/api/peer/v1` over HTTP — and deliberately nothing more than that.
 *
 * Every decision lives in `PeerSurface`: authentication, connection state,
 * verification, visibility, routing. This file moves bytes on and off a Fastify
 * request and hands over. That is what makes the scenario tier honest — the
 * in-process transport calls the same `handle()` — and it is why there is no
 * `PeerGuard` here any more. A guard would put one check on the HTTP path and
 * not on the in-process one, which is precisely the divergence the split exists
 * to prevent.
 */
import { All, Controller, Inject, Req, Res } from '@nestjs/common'
import type { FastifyReply, FastifyRequest } from 'fastify'

import { toSseFrame } from '../peer/http-transport.js'
import { PEER_SERVER, type PeerSurface } from '../peer/peer.server.js'
import type { PeerMethod, PeerRequest } from '../peer/transport.js'

/** How long a stream may sit silent before a keep-alive comment goes down it. */
const KEEPALIVE_MS = 15_000

@Controller('api/peer/v1')
export class PeerController {
  constructor(@Inject(PEER_SERVER) private readonly peers: PeerSurface) {}

  @All('*')
  async handle(@Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const peerRequest: PeerRequest = {
      method: request.method as PeerMethod,
      path: request.url,
      headers: flatten(request.headers),
      ...(request.body === undefined ? {} : { body: request.body }),
    }

    if (request.method === 'GET' && request.url.split('?')[0]?.endsWith('/stream')) {
      await this.stream(peerRequest, reply)
      return
    }

    const response = await this.peers.handle(peerRequest)
    void reply.status(response.status).headers(response.headers).send(response.body)
  }

  /**
   * Server-sent events, for a peer that holds the line open.
   *
   * The peer end of this needs no inbound endpoint, no DNS entry and no
   * certificate. `id:` carries the cursor, so a reconnect with `Last-Event-ID`
   * resumes exactly where it left off.
   */
  private async stream(request: PeerRequest, reply: FastifyReply): Promise<void> {
    const raw = reply.raw
    let open = true

    const subscription = await this.peers.open(request, {
      onMessage: (message) => {
        if (open) raw.write(toSseFrame(message))
      },
      onClose: () => {
        if (open) {
          open = false
          raw.end()
        }
      },
    })

    if (!('close' in subscription)) {
      // Refused, not unreachable. A caller has to be able to tell those apart.
      void reply.status(subscription.status).headers(subscription.headers).send(subscription.body)
      return
    }

    reply.hijack()
    raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Proxies that buffer would defeat the whole point of a held-open line.
      'x-accel-buffering': 'no',
    })
    // An immediate comment flushes headers, so the client knows it is attached
    // rather than waiting on the first event that happens to occur.
    raw.write(': attached\n\n')

    const keepalive = setInterval(() => {
      if (open) raw.write(': keepalive\n\n')
    }, KEEPALIVE_MS)
    keepalive.unref?.()

    const shutdown = (): void => {
      if (!open) return
      open = false
      clearInterval(keepalive)
      subscription.close()
    }
    raw.on('close', shutdown)
    raw.on('error', shutdown)
  }
}

function flatten(headers: FastifyRequest['headers']): Record<string, string> {
  const flat: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue
    flat[name] = Array.isArray(value) ? (value[0] ?? '') : String(value)
  }
  return flat
}
