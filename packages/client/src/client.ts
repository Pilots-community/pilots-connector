/**
 * The typed client for a connector's **local** API.
 *
 * Note the shape of what is here, and especially what is not. There is no peer
 * address, no DID to resolve, no signing, no token lifecycle, no knowledge of
 * who hosts what. An integrator calls its own connector and the connector deals
 * with the rest — which is the whole argument for the relay existing. If this
 * class ever grows a method that takes a peer's URL, something has gone wrong
 * one layer down.
 *
 * It is also **not privileged**. Our own process UI is an ordinary API-key
 * client, and everything it can do is available to anybody on the same terms.
 * The moment a feature needs a route only our UI can call, that is a design
 * failure rather than a shortcut.
 */
import { ProblemError, TransportError, isProblemDocument, type ProblemDocument } from './errors.js'
import type {
  DefinitionLintResult,
  PublishedDefinition,
  AttachmentRef,
  ClientOptions,
  Connection,
  CreateInstanceRequest,
  DefinitionSummary,
  InstanceView,
  NotificationEnvelope,
  Offering,
  Participant,
  ProcessDefinition,
  RequestOptions,
  SignedEvent,
  TransitionRequest,
  WriteResult,
} from './types.js'

const PREFIX = '/api/local/v1'

export class PilotsClient {
  private readonly baseUrl: string
  private readonly apiKey: string
  private readonly actorRef: string | undefined
  private readonly http: typeof globalThis.fetch

  constructor(options: ClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.apiKey = options.apiKey
    this.actorRef = options.actorRef
    this.http = options.fetch ?? globalThis.fetch.bind(globalThis)
  }

  /** The same client, acting for a different person. Keys are per participant, not per user. */
  as(actorRef: string): PilotsClient {
    return new PilotsClient({
      baseUrl: this.baseUrl,
      apiKey: this.apiKey,
      actorRef,
      fetch: this.http,
    })
  }

  // ── who this key acts for ────────────────────────────────────────────────

  /**
   * The participant this key belongs to.
   *
   * You need your own DID to fill a `participants` map, because a definition
   * names a role and only an instance names who fills it. Asking beats
   * configuring it twice and finding out later that the two disagreed.
   */
  async me(options: RequestOptions = {}): Promise<Participant> {
    const body = await this.request<{ participant: Participant }>('GET', '/me', options)
    return body.participant
  }

  // ── definitions and discovery ────────────────────────────────────────────

  async definitions(options: RequestOptions = {}): Promise<DefinitionSummary[]> {
    const body = await this.request<{ definitions: DefinitionSummary[] }>(
      'GET',
      '/definitions',
      options,
    )
    return body.definitions
  }

  async definition(
    ref: string,
    options: RequestOptions = {},
  ): Promise<{ ref: string; contentHash: string; definition: ProcessDefinition }> {
    return this.request('GET', `/definitions/${encodeURIComponent(ref)}`, options)
  }

  /**
   * Validate a candidate definition without publishing it.
   *
   * Answers 200 whether or not the document is valid: the diagnostics are the
   * answer, and each carries a JSON Pointer into the document so an editor can
   * point at the offending node.
   */
  async lintDefinition(
    definition: Record<string, unknown>,
    options: RequestOptions = {},
  ): Promise<DefinitionLintResult> {
    return this.request('POST', '/definitions/lint', options, { definition })
  }

  /**
   * Publish a definition, making it immediately usable.
   *
   * Immutable once published: the same bytes again is a no-op, and different
   * bytes under the same `id@version` is a conflict rather than an update.
   */
  async publishDefinition(
    definition: Record<string, unknown>,
    options: RequestOptions = {},
  ): Promise<PublishedDefinition> {
    return this.request('POST', '/definitions', options, { definition })
  }

  /**
   * Offerings — ours, or a peer's.
   *
   * Passing `peer` makes this a relayed read. It looks identical from here,
   * which is the point; a peer that did not answer comes back as
   * `peer-unreachable` rather than as an empty list, because "nobody is offering
   * anything" and "I could not ask" are different answers.
   */
  async offerings(peer?: string, options: RequestOptions = {}): Promise<Offering[]> {
    const path = peer === undefined ? '/offerings' : `/offerings?peer=${encodeURIComponent(peer)}`
    const body = await this.request<{ offerings: Offering[] }>('GET', path, options)
    return body.offerings
  }

  /** Read-only: connections are operator state, established on the admin surface. */
  async connections(options: RequestOptions = {}): Promise<Connection[]> {
    const body = await this.request<{ connections: Connection[] }>('GET', '/connections', options)
    return body.connections
  }

  // ── instances ────────────────────────────────────────────────────────────

  async instances(options: RequestOptions = {}): Promise<InstanceView[]> {
    const body = await this.request<{ instances: InstanceView[] }>('GET', '/instances', options)
    return body.instances
  }

  async instance(id: string, options: RequestOptions = {}): Promise<InstanceView> {
    return this.request('GET', `/instances/${encodeURIComponent(id)}`, options)
  }

  /** The signed log, visibility-filtered. `since` is a `seq`, not a cursor. */
  async events(id: string, since = 0, options: RequestOptions = {}): Promise<SignedEvent[]> {
    const body = await this.request<{ events: SignedEvent[] }>(
      'GET',
      `/instances/${encodeURIComponent(id)}/events?since=${since}`,
      options,
    )
    return body.events
  }

  async createInstance(
    request: CreateInstanceRequest,
    options: RequestOptions = {},
  ): Promise<WriteResult> {
    return this.request('POST', '/instances', options, request)
  }

  /**
   * The one mutating call.
   *
   * `ifMatch` is required, not optional — a mutating call without it is a `428`,
   * and that is deliberate: it is how two parties acting at once produce a
   * conflict instead of a silent overwrite. It is also, less obviously, what
   * lets your connector build and sign the event itself, since knowing the
   * instance is at `seq` 3 is knowing the next event is 4.
   *
   * On a conflict this throws a `ProblemError` whose `seq` is where the instance
   * actually is, so a caller can re-read and decide rather than guess.
   */
  async applyTransition(
    id: string,
    request: TransitionRequest,
    ifMatch: number,
    options: RequestOptions = {},
  ): Promise<WriteResult> {
    return this.request(
      'POST',
      `/instances/${encodeURIComponent(id)}/transitions`,
      options,
      request,
      {
        'if-match': `"${ifMatch}"`,
      },
    )
  }

  // ── local delivery ───────────────────────────────────────────────────────

  /**
   * Replay notifications from a cursor. **Authoritative**: a backoffice that was
   * down catches up here without anyone deciding whether a delivery "really"
   * happened. Deduplicate on `cursor`, which you must do anyway — delivery is
   * at-least-once.
   */
  async notifications(
    since?: string,
    limit?: number,
    options: RequestOptions = {},
  ): Promise<{ notifications: NotificationEnvelope[]; cursor: string | null }> {
    const query = new URLSearchParams()
    if (since !== undefined) query.set('since', since)
    if (limit !== undefined) query.set('limit', String(limit))
    const suffix = query.size === 0 ? '' : `?${query.toString()}`
    return this.request('GET', `/notifications${suffix}`, options)
  }

  // ── attachments ──────────────────────────────────────────────────────────

  /**
   * Upload document bytes and get back the reference a transition carries.
   *
   * The connector computes the hash. You do not send one, and could not usefully
   * — an address you chose for content you supplied proves nothing.
   */
  async uploadAttachment(
    bytes: Uint8Array | ArrayBuffer | Blob,
    mime: string,
    options: RequestOptions = {},
  ): Promise<AttachmentRef> {
    const url = `${this.baseUrl}${PREFIX}/attachments`
    const response = await this.send(url, {
      method: 'POST',
      headers: { ...this.headers(), 'content-type': mime },
      body: bytes instanceof Blob ? bytes : new Blob([bytes as BlobPart]),
      ...(options.signal ? { signal: options.signal } : {}),
    })
    return (await this.unwrap(response)) as AttachmentRef
  }

  /** Document bytes, if this participant may read them. Pulled from the host if we lack them. */
  async attachment(sha256: string, options: RequestOptions = {}): Promise<Blob> {
    const url = `${this.baseUrl}${PREFIX}/attachments/${encodeURIComponent(sha256)}`
    const response = await this.send(url, {
      method: 'GET',
      headers: this.headers(),
      ...(options.signal ? { signal: options.signal } : {}),
    })
    if (!response.ok) await this.unwrap(response)
    return response.blob()
  }

  // ── plumbing ─────────────────────────────────────────────────────────────

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      authorization: `ApiKey ${this.apiKey}`,
      ...(this.actorRef === undefined ? {} : { 'x-actor-ref': this.actorRef }),
      ...extra,
    }
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    options: RequestOptions,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<T> {
    const headers = this.headers({
      accept: 'application/json',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.idempotencyKey === undefined
        ? {}
        : { 'idempotency-key': options.idempotencyKey }),
      ...extraHeaders,
    })

    const url = `${this.baseUrl}${PREFIX}${path}`
    const response = await this.send(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(options.signal ? { signal: options.signal } : {}),
    })
    return (await this.unwrap(response)) as T
  }

  private async send(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.http(url, init)
    } catch (cause) {
      // The connector itself is unreachable. Distinct from a peer being
      // unreachable, which the connector reports as an ordinary problem
      // document — this is "your own connector is down".
      throw new TransportError(url, cause)
    }
  }

  private async unwrap(response: Response): Promise<unknown> {
    const text = await response.text()
    const body: unknown = text === '' ? undefined : safeJson(text)

    if (response.ok) return body
    if (isProblemDocument(body)) throw new ProblemError(body)

    // Something answered, but not in the shape every surface promises. Report it
    // as a problem anyway rather than throwing a bare `Error`, so a caller has
    // one thing to catch.
    throw new ProblemError({
      type: 'about:blank',
      title: 'Unexpected response',
      status: response.status,
      detail: typeof body === 'string' ? body : `the connector answered ${response.status}`,
    } satisfies ProblemDocument)
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}
