/**
 * Two connectors in one process, wired directly together.
 *
 * This is the adapter [TESTING.md §3.3](../../../../docs/TESTING.md) is built
 * around. It carries the same `PeerRequest` to the same `PeerServer.handle` the
 * HTTP adapter reaches, so what a scenario test exercises is the real peer
 * surface — real bearer tokens, real signature checks, real connection state —
 * with the network removed and nothing else.
 *
 * It also makes failure a first-class thing a test can *cause*: `partition()`
 * takes a node off the network, which is what S4a needs and what no amount of
 * mocking a client would prove.
 */
import {
  PeerUnreachableError,
  type PeerRequest,
  type PeerResponse,
  type PeerServer,
  type PeerTransport,
  type StreamMessage,
  type StreamSubscription,
} from './transport.js'

/** `https://org-b.example/` and `https://org-b.example` are one node. */
function nodeKey(baseUrl: string): string {
  try {
    return new URL(baseUrl).origin
  } catch {
    return baseUrl
  }
}

interface OpenStream {
  node: string
  close(): void
}

export class InProcessNetwork implements PeerTransport {
  private readonly nodes = new Map<string, PeerServer>()
  private readonly unreachable = new Set<string>()
  private readonly streams = new Set<OpenStream>()

  register(baseUrl: string, server: PeerServer): this {
    this.nodes.set(nodeKey(baseUrl), server)
    return this
  }

  /**
   * Take a node off the network: requests to it fail as unreachable and every
   * stream it is serving drops, exactly as a stopped process would look from
   * outside. The node keeps running — S4a stops *Org A* while Org B carries
   * on, so the test needs one side gone rather than both frozen.
   */
  partition(baseUrl: string): this {
    const key = nodeKey(baseUrl)
    this.unreachable.add(key)
    for (const stream of [...this.streams]) {
      if (stream.node === key) stream.close()
    }
    return this
  }

  heal(baseUrl: string): this {
    this.unreachable.delete(nodeKey(baseUrl))
    return this
  }

  /** Drop the streams a node holds *outbound*, without making it unreachable. */
  dropStreamsServedBy(baseUrl: string): this {
    const key = nodeKey(baseUrl)
    for (const stream of [...this.streams]) {
      if (stream.node === key) stream.close()
    }
    return this
  }

  private nodeAt(baseUrl: string): PeerServer {
    const key = nodeKey(baseUrl)
    if (this.unreachable.has(key)) {
      throw new PeerUnreachableError(baseUrl, 'the node is partitioned from the network')
    }
    const server = this.nodes.get(key)
    if (!server) throw new PeerUnreachableError(baseUrl, 'no node is listening at that address')
    return server
  }

  async send(baseUrl: string, request: PeerRequest): Promise<PeerResponse> {
    const server = this.nodeAt(baseUrl)
    try {
      // Structured-cloned across the boundary, so a test cannot accidentally
      // prove something by sharing an object graph two processes would not.
      return await server.handle(clone(request))
    } catch (cause) {
      throw new PeerUnreachableError(baseUrl, cause)
    }
  }

  async open(
    baseUrl: string,
    request: PeerRequest,
    handlers: {
      onMessage: (message: StreamMessage) => void
      onClose?: (reason: string) => void
    },
  ): Promise<StreamSubscription> {
    const key = nodeKey(baseUrl)
    const server = this.nodeAt(baseUrl)

    let closed = false
    const inner: { subscription?: StreamSubscription } = {}
    const entry: OpenStream = {
      node: key,
      close: () => {
        if (closed) return
        closed = true
        this.streams.delete(entry)
        inner.subscription?.close()
        handlers.onClose?.('the peer went away')
      },
    }

    const opened = await server.open(clone(request), {
      onMessage: (message) => {
        if (!closed) handlers.onMessage(clone(message))
      },
      onClose: (reason) => {
        if (closed) return
        closed = true
        this.streams.delete(entry)
        handlers.onClose?.(reason)
      },
    })

    if (!isSubscription(opened)) {
      // The peer refused the stream — an auth failure, say. That is a response,
      // not an outage, and the caller has to be able to tell the two apart.
      throw new PeerUnreachableError(
        baseUrl,
        `the peer refused the stream with ${opened.status}: ${JSON.stringify(opened.body)}`,
      )
    }

    inner.subscription = opened
    this.streams.add(entry)
    return { close: () => entry.close() }
  }
}

function isSubscription(value: StreamSubscription | PeerResponse): value is StreamSubscription {
  return typeof (value as StreamSubscription).close === 'function'
}

function clone<T>(value: T): T {
  return value === undefined ? value : structuredClone(value)
}
