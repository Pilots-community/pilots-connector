/**
 * The SPA talks to its own BFF and nothing else.
 *
 * Note what is absent: no API key, no connector URL, no DID. The key is a
 * participant-wide credential and would be readable by anyone with devtools, so
 * it stays in the BFF; the browser carries an ordinary session cookie for a user
 * account this UI owns. That is the arrangement, not an implementation detail —
 * it is what makes the UI replaceable without the connector caring.
 */
export class UiError extends Error {
  constructor(
    readonly status: number,
    readonly problem: { type?: string; title?: string; detail?: string; seq?: number },
  ) {
    super(problem.detail ?? problem.title ?? `request failed with ${status}`)
    this.name = 'UiError'
  }

  /** Somebody else moved the instance. Re-read and decide; do not simply retry. */
  get isConflict(): boolean {
    return this.problem.type?.endsWith('seq-conflict') === true
  }

  /** The peer did not answer. Worth trying again unchanged. */
  get isRetryable(): boolean {
    return this.problem.type?.endsWith('peer-unreachable') === true
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    // The session cookie is the whole credential the browser holds.
    credentials: 'same-origin',
    headers: {
      ...(init.body !== undefined && !(init.body instanceof Blob)
        ? { 'content-type': 'application/json' }
        : {}),
      ...(init.headers ?? {}),
    },
  })

  const text = await response.text()
  const body: unknown = text === '' ? undefined : safeJson(text)
  if (!response.ok) throw new UiError(response.status, body ?? {})
  return body as T
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

export interface SessionUser {
  id: string
  email: string
  name: string
}

export interface AvailableAction {
  transition: string
  role: string
}

export interface InstanceView {
  id: string
  kind: 'quotation' | 'service'
  definition: string
  participants: Record<string, string | string[]>
  quotationId: string | null
  offering: string | null
  state: string
  seq: number
  data: Record<string, unknown>
  createdAt: string
  updatedAt: string
  home: boolean
  available: AvailableAction[]
  redacted: boolean
  /** Whether the process is over, and how — computed by the connector. */
  outcome: 'running' | 'fulfilled' | 'abandoned'
}

export interface SignedEvent {
  header: {
    instance: string
    seq: number
    transition: string
    actor: string
    from: string | null
    to: string | null
    at: string
    prev: string | null
    payloadHash: string
    genesis: string
    cause: string | null
    attachments: Array<{ sha256: string; mime: string; size: number }>
  }
  payload: Record<string, unknown> | null
  redacted: boolean
  sig: string
}

export interface VerificationReport {
  status: 'verified' | 'unresolved' | 'broken'
  events: Array<{ seq: number; ok: boolean | null }>
  failures: Array<{ seq: number; type: string; detail: string }>
  unresolved: string[]
}

export interface TransitionDefinition {
  id: string
  title: string
  description?: string
  from: string[]
  to?: string
  by: string[]
  patch?: Record<string, unknown>
  attachments?: { required: boolean; mime?: string[] }
}

export interface ProcessDefinition {
  id: string
  version: string
  kind: 'quotation' | 'service'
  title: string
  roles: Array<{ id: string; title: string }>
  hostedBy: string
  initialState: string
  states: Array<{ id: string; title: string; outcome?: 'fulfilled' | 'abandoned' }>
  data: Record<string, unknown>
  transitions: TransitionDefinition[]
}

export interface DefinitionSummary {
  ref: string
  title: string
  kind: 'quotation' | 'service'
  contentHash: string
  /**
   * Whether an instance under it can reach a fulfilled state with no relation
   * anchored at creation.
   *
   * `false` means the process is contracted by another one — every route to
   * success crosses a transition a link fires — so starting it on its own is
   * refused. Offer it accordingly rather than letting somebody walk into a
   * process whose only remaining action is cancel.
   */
  startableStandalone: boolean
  /** What would make it startable. Empty when it already is. */
  requiresRelations: string[]
}

export interface DefinitionDiagnostic {
  severity: 'error' | 'warning'
  code: string
  message: string
  /** A JSON Pointer into the document, so an editor can point at the node. */
  path?: string
}

export interface DefinitionLintResult {
  ok: boolean
  diagnostics: DefinitionDiagnostic[]
  ref?: string
  startableStandalone?: boolean
}

export interface Offering {
  id: string
  title: string
  quotationDefinition: string
  serviceDefinition: string
  price: { value: number; currency: string } | null
  status: string
}

export interface Connection {
  id: string
  peerDid: string
  peerDisplayName: string | null
  status: string
}

export const api = {
  session: () =>
    request<{
      user: SessionUser | null
      participant: string
      /** Our own DID, so the SPA can label "Us" without ever hardcoding one. */
      did: string | null
      connector: string
      /** Whether this UI offers its demo affordances. See PILOTS_UI_DEMO_TOOLS. */
      demoTools: boolean
    }>('/api/ui/session'),

  signIn: (email: string, password: string) =>
    request('/api/auth/sign-in/email', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),
  signUp: (email: string, password: string, name: string) =>
    request('/api/auth/sign-up/email', {
      method: 'POST',
      body: JSON.stringify({ email, password, name }),
    }),
  signOut: () => request('/api/auth/sign-out', { method: 'POST', body: '{}' }),

  definitions: () => request<{ definitions: DefinitionSummary[] }>('/api/ui/definitions'),
  definition: (ref: string) =>
    request<{ ref: string; contentHash: string; definition: ProcessDefinition }>(
      `/api/ui/definitions/${encodeURIComponent(ref)}`,
    ),
  offerings: (peer?: string) =>
    request<{ offerings: Offering[] }>(
      peer === undefined
        ? '/api/ui/offerings'
        : `/api/ui/offerings?peer=${encodeURIComponent(peer)}`,
    ),
  connections: () => request<{ connections: Connection[] }>('/api/ui/connections'),

  instances: () => request<{ instances: InstanceView[] }>('/api/ui/instances'),
  instance: (id: string) => request<InstanceView>(`/api/ui/instances/${encodeURIComponent(id)}`),
  events: (id: string) =>
    request<{ events: SignedEvent[]; instance: InstanceView; verification: VerificationReport }>(
      `/api/ui/instances/${encodeURIComponent(id)}/events`,
    ),

  createInstance: (body: Record<string, unknown>) =>
    request<{ instance: InstanceView }>('/api/ui/instances', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  applyTransition: (id: string, body: Record<string, unknown>) =>
    request<{ instance: InstanceView }>(`/api/ui/instances/${encodeURIComponent(id)}/transitions`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  lintDefinition: (definition: Record<string, unknown>) =>
    request<DefinitionLintResult>('/api/ui/definitions/lint', {
      method: 'POST',
      body: JSON.stringify({ definition }),
    }),

  publishDefinition: (definition: Record<string, unknown>) =>
    request<{ ref: string; created: boolean; warnings: DefinitionDiagnostic[] }>(
      '/api/ui/definitions',
      { method: 'POST', body: JSON.stringify({ definition }) },
    ),

  startFromOffering: (body: Record<string, unknown>) =>
    request<{ quotation: InstanceView; service: InstanceView }>('/api/ui/offerings/start', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  uploadAttachment: (file: File) =>
    request<{ sha256: string; mime: string; size: number }>('/api/ui/attachments', {
      method: 'POST',
      body: file,
      headers: { 'content-type': file.type || 'application/octet-stream' },
    }),

  attachmentUrl: (sha256: string) => `/api/ui/attachments/${encodeURIComponent(sha256)}`,
}
