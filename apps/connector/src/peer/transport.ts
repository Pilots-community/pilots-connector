/**
 * The `Transport` port — how a call reaches another connector.
 *
 * This is the port that changes what is *possible* to test. With it, a complete
 * two-party run is a function call, so the whole of S1, S4a and S5 executes
 * inside one test process with no HTTP, no ports and no containers
 * ([TESTING.md §2](../../../../docs/TESTING.md)).
 *
 * The shape is deliberately HTTP's — method, path, headers, body, status. Not
 * because the in-process adapter needs it, but because the *other* adapter is
 * HTTP and any richer abstraction would be one the network could not honour. A
 * port that is easy in-process and impossible over a wire is a port that lies.
 *
 * Note what is **not** here: no notion of a peer's identity beyond a base URL,
 * no signing, no connection state. Those belong to the layers above, so that
 * swapping the transport cannot change who is trusted.
 */

export type PeerMethod = 'GET' | 'POST'

export interface PeerRequest {
  method: PeerMethod
  /** Absolute path on the peer, e.g. `/api/peer/v1/instances`. Includes any query string. */
  path: string
  headers: Record<string, string>
  /** Already-parsed JSON. The transport is responsible for serialisation. */
  body?: unknown
}

export interface PeerResponse {
  status: number
  headers: Record<string, string>
  body: unknown
}

/**
 * One message on a held-open peer stream.
 *
 * `id` is the SSE `id:` field and doubles as the resume cursor: a peer that
 * reconnects sends it back as `Last-Event-ID` and receives everything after it.
 */
export interface StreamMessage {
  id: string
  event: string
  data: unknown
}

export interface StreamSubscription {
  close(): void
}

/**
 * A transport failure — the peer did not answer at all.
 *
 * Distinct from *any* response, including a 500. This distinction is the whole
 * of [PROTOCOL.md §4.3](../../../../docs/PROTOCOL.md#43-relay-error-semantics):
 * collapsing "unreachable" into a business conflict makes retry logic on the
 * integrator's side unwriteable, so the two can never share a type.
 */
export class PeerUnreachableError extends Error {
  constructor(
    readonly baseUrl: string,
    readonly cause_: unknown,
  ) {
    super(`peer at ${baseUrl} did not answer: ${describe(cause_)}`)
    this.name = 'PeerUnreachableError'
  }
}

function describe(cause: unknown): string {
  if (cause instanceof Error) return cause.message
  return String(cause)
}

export interface PeerTransport {
  /** One request/response exchange. Throws `PeerUnreachableError` and nothing else. */
  send(baseUrl: string, request: PeerRequest): Promise<PeerResponse>

  /**
   * Hold a stream open, receiving messages until closed.
   *
   * Rejects with `PeerUnreachableError` if the stream cannot be established; a
   * stream that *drops* later reports through `onClose` instead, because by then
   * the caller has already been told the connection was up.
   */
  open(
    baseUrl: string,
    request: PeerRequest,
    handlers: { onMessage: (message: StreamMessage) => void; onClose?: (reason: string) => void },
  ): Promise<StreamSubscription>
}

/**
 * The `PeerServer` is the peer surface as a plain function.
 *
 * The Nest controller is a thin adapter over this, and the in-process transport
 * calls it directly. That is what makes the scenario tier honest: a scenario
 * test and a container run go through the *same* authentication, the same
 * routing and the same handlers, and only the bytes in between differ.
 */
export interface PeerServer {
  handle(request: PeerRequest): Promise<PeerResponse>
  open(
    request: PeerRequest,
    handlers: { onMessage: (message: StreamMessage) => void; onClose?: (reason: string) => void },
  ): Promise<StreamSubscription | PeerResponse>
}

/** The default before any peer is configured: every call fails as unreachable. */
export const NO_TRANSPORT: PeerTransport = {
  send: (baseUrl) => {
    throw new PeerUnreachableError(baseUrl, 'no peer transport is configured')
  },
  open: (baseUrl) => {
    throw new PeerUnreachableError(baseUrl, 'no peer transport is configured')
  },
}

/** Split `/api/peer/v1/instances/x/events?since=3` into its path and query. */
export function splitPath(path: string): { pathname: string; query: URLSearchParams } {
  const index = path.indexOf('?')
  if (index === -1) return { pathname: path, query: new URLSearchParams() }
  return {
    pathname: path.slice(0, index),
    query: new URLSearchParams(path.slice(index + 1)),
  }
}
