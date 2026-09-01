/**
 * The `Transport` over real HTTP.
 *
 * Small on purpose. Everything that decides an outcome — authentication,
 * connection state, verification, visibility — lives in the `PeerServer` on the
 * other side and in the `PeerClient` on this one, so this file only moves bytes.
 * That is what makes the in-process adapter an honest stand-in rather than a
 * mock: swapping them changes the wire, not the rules.
 *
 * The SSE reader is hand-written rather than pulled in as a dependency because
 * we need exactly three fields (`id`, `event`, `data`), we already require the
 * `Last-Event-ID` semantics to be ours, and `EventSource` cannot send an
 * `Authorization` header — which is the one thing a peer stream must do.
 */
import {
  PeerUnreachableError,
  type PeerRequest,
  type PeerResponse,
  type PeerTransport,
  type StreamMessage,
  type StreamSubscription,
} from './transport.js'

export interface HttpTransportOptions {
  /** How long a single request/response exchange may take. Streams are exempt. */
  timeoutMs?: number
}

export class HttpTransport implements PeerTransport {
  constructor(private readonly options: HttpTransportOptions = {}) {}

  async send(baseUrl: string, request: PeerRequest): Promise<PeerResponse> {
    const url = new URL(request.path, baseUrl)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 15_000)

    let response: Response
    try {
      response = await fetch(url, {
        method: request.method,
        headers: { accept: 'application/json', ...request.headers },
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        signal: controller.signal,
      })
    } catch (cause) {
      // Only a genuine transport failure reaches here. Any *answer*, including a
      // 500, is a response — the caller must be able to tell the two apart.
      throw new PeerUnreachableError(baseUrl, cause)
    } finally {
      clearTimeout(timeout)
    }

    const text = await response.text()
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body: text === '' ? undefined : safeJson(text),
    }
  }

  async open(
    baseUrl: string,
    request: PeerRequest,
    handlers: { onMessage: (message: StreamMessage) => void; onClose?: (reason: string) => void },
  ): Promise<StreamSubscription> {
    const url = new URL(request.path, baseUrl)
    const controller = new AbortController()

    let response: Response
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: { accept: 'text/event-stream', ...request.headers },
        signal: controller.signal,
      })
    } catch (cause) {
      throw new PeerUnreachableError(baseUrl, cause)
    }

    if (!response.ok || !response.body) {
      throw new PeerUnreachableError(baseUrl, `the peer refused the stream with ${response.status}`)
    }

    // Deliberately not awaited: the read loop runs for the life of the stream.
    void this.pump(response.body, handlers, controller)
    return { close: () => controller.abort() }
  }

  private async pump(
    body: ReadableStream<Uint8Array>,
    handlers: { onMessage: (message: StreamMessage) => void; onClose?: (reason: string) => void },
    controller: AbortController,
  ): Promise<void> {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let reason = 'the stream ended'

    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        // SSE frames are separated by a blank line. Anything after the last one
        // is a partial frame and stays in the buffer.
        let boundary = buffer.indexOf('\n\n')
        while (boundary !== -1) {
          const frame = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          const message = parseFrame(frame)
          if (message) handlers.onMessage(message)
          boundary = buffer.indexOf('\n\n')
        }
      }
    } catch (cause) {
      reason = controller.signal.aborted ? 'the stream was closed locally' : String(cause)
    } finally {
      handlers.onClose?.(reason)
    }
  }
}

function parseFrame(frame: string): StreamMessage | undefined {
  let id: string | undefined
  let event = 'message'
  const data: string[] = []

  for (const line of frame.split('\n')) {
    if (line === '' || line.startsWith(':')) continue
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '')
    if (field === 'id') id = value
    else if (field === 'event') event = value
    else if (field === 'data') data.push(value)
  }

  if (id === undefined || data.length === 0) return undefined
  return { id, event, data: safeJson(data.join('\n')) }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/** Serialise one message as an SSE frame. The server half of the same format. */
export function toSseFrame(message: StreamMessage): string {
  return `id: ${message.id}\nevent: ${message.event}\ndata: ${JSON.stringify(message.data)}\n\n`
}
