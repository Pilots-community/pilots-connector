/**
 * The admin UI talks to `/api/admin/v1` and nothing else.
 *
 * It cannot start a process or apply a transition, because that surface does not
 * offer it — those are the local API's job, and routing them through the admin
 * surface would create exactly the privileged path the design forbids.
 */
const SESSION_KEY = 'pilots.adminSession'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly problem: { type?: string; title?: string; detail?: string },
  ) {
    super(problem.detail ?? problem.title ?? `request failed with ${status}`)
    this.name = 'ApiError'
  }
}

export function storedSession(): string | null {
  try {
    return localStorage.getItem(SESSION_KEY)
  } catch {
    return null
  }
}

export function rememberSession(id: string | null): void {
  try {
    if (id === null) localStorage.removeItem(SESSION_KEY)
    else localStorage.setItem(SESSION_KEY, id)
  } catch {
    // A private window without storage still works; the session just does not
    // survive a reload.
  }
}

async function request<T>(path: string, init: RequestInit = {}, session?: string): Promise<T> {
  const response = await fetch(`/api/admin/v1${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(session ? { authorization: `Session ${session}` } : {}),
      ...(init.headers ?? {}),
    },
  })

  const text = await response.text()
  const body = text === '' ? undefined : (JSON.parse(text) as unknown)
  if (!response.ok) {
    throw new ApiError(response.status, body ?? {})
  }
  return body as T
}

export interface Scope {
  value: string
  label: string
}

export const SCOPES: Scope[] = [
  { value: 'instances:read', label: 'Read instances and their event log' },
  { value: 'instances:write', label: 'Create instances and apply transitions' },
  { value: 'events:read', label: 'Subscribe to local delivery' },
  { value: 'attachments:read', label: 'Fetch attachments' },
  { value: 'attachments:write', label: 'Upload attachments' },
  { value: 'connections:read', label: 'List connections' },
  { value: 'definitions:read', label: 'Read definitions and offerings' },
]

export interface ApiKey {
  id: string
  label: string
  scopes: string[]
  createdAt: string
  lastUsedAt: string | null
  revokedAt: string | null
  expiresAt: string | null
}

export interface AuditEntry {
  seq: number
  at: string
  category: string
  action: string
  actor: { kind: string; id: string; actorRef: string | null }
  subject: Record<string, string | null>
  outcome: 'ok' | 'denied' | 'failed'
  problem: string | null
  detail: string | null
  request: { method: string; path: string } | null
  prev: string | null
}

export interface Participant {
  id: string
  did: string
  displayName: string
  baseUrl: string
  didDocument: unknown
}

export interface Status {
  environment: string
  store: string
  definitions: number
  participants: number
  secrets: { store: string; ephemeral: boolean }
  sessions: number
}

export interface Offering {
  id: string
  title: string
  quotationDefinition: string
  serviceDefinition: string
  price: { value: number; currency: string } | null
  status: 'PUBLISHED' | 'WITHDRAWN'
}

export interface Subscription {
  id: string
  label: string
  channel: string
  target: { url: string; secretRef: string | null } | null
  notify: string[]
  filter: Record<string, unknown>
  status: string
}

export interface Connection {
  id: string
  peerDid: string
  peerBaseUrl: string
  peerDisplayName: string | null
  status: 'PENDING_INBOUND' | 'PENDING_OUTBOUND' | 'ACTIVE' | 'DEGRADED' | 'REJECTED' | 'REVOKED'
  inbound: { channel: string; url?: string }
  outbound: { channel: string; url?: string }
  lastError: string | null
  createdAt: string
  updatedAt: string
}

export interface TrustedPeer {
  did: string
  addedAt: string
  note: string | null
}

export interface DefinitionSummary {
  ref: string
  title: string
  kind: string
  hostedBy: string
  roles: string[]
  contentHash: string
}

export const api = {
  signIn: (token: string) =>
    request<{ session: { id: string; expiresAt: string } }>('/sessions', {
      method: 'POST',
      body: JSON.stringify({ token }),
    }),
  signOut: (session: string) => request('/sessions/current', { method: 'DELETE' }, session),

  status: (session: string) => request<Status>('/status', {}, session),
  participants: (session: string) =>
    request<{ participants: Participant[] }>('/participants', {}, session),
  definitions: (session: string) =>
    request<{ definitions: DefinitionSummary[] }>('/definitions', {}, session),

  apiKeys: (session: string, participantId: string) =>
    request<{ apiKeys: ApiKey[] }>(`/apikeys?participantId=${participantId}`, {}, session),
  createApiKey: (
    session: string,
    body: { label: string; scopes: string[]; participantId: string },
  ) =>
    request<ApiKey & { secret: string }>(
      '/apikeys',
      { method: 'POST', body: JSON.stringify(body) },
      session,
    ),
  revokeApiKey: (session: string, id: string, participantId: string) =>
    request(`/apikeys/${id}?participantId=${participantId}`, { method: 'DELETE' }, session),

  connections: (session: string, participantId: string) =>
    request<{ connections: Connection[] }>(
      `/connections?participantId=${participantId}`,
      {},
      session,
    ),
  requestConnection: (session: string, participantId: string, body: Record<string, unknown>) =>
    request<{ connection: Connection }>(
      `/connections?participantId=${participantId}`,
      { method: 'POST', body: JSON.stringify(body) },
      session,
    ),
  decideConnection: (
    session: string,
    participantId: string,
    id: string,
    decision: 'accept' | 'reject' | 'revoke',
    body: Record<string, unknown> = {},
  ) =>
    request<{ connection: Connection }>(
      `/connections/${id}/${decision}?participantId=${participantId}`,
      { method: 'POST', body: JSON.stringify(body) },
      session,
    ),

  trustedPeers: (session: string, participantId: string) =>
    request<{ trustedPeers: TrustedPeer[] }>(
      `/trusted-peers?participantId=${participantId}`,
      {},
      session,
    ),
  trustPeer: (session: string, participantId: string, body: { did: string; note?: string }) =>
    request(
      `/trusted-peers?participantId=${participantId}`,
      { method: 'POST', body: JSON.stringify(body) },
      session,
    ),
  untrustPeer: (session: string, participantId: string, did: string) =>
    request(
      `/trusted-peers/${encodeURIComponent(did)}?participantId=${participantId}`,
      { method: 'DELETE' },
      session,
    ),

  audit: (session: string, participantId: string, since = 0) =>
    request<{ entries: AuditEntry[]; total: number }>(
      `/audit?participantId=${participantId}&since=${since}&limit=200`,
      {},
      session,
    ),
  verifyAudit: (session: string, participantId: string) =>
    request<{ ok: boolean; entries: number; failures: unknown[] }>(
      `/audit/verify?participantId=${participantId}`,
      {},
      session,
    ),

  offerings: (session: string, participantId: string) =>
    request<{ offerings: Offering[] }>(`/offerings?participantId=${participantId}`, {}, session),
  publishOffering: (session: string, body: Record<string, unknown>) =>
    request<Offering>('/offerings', { method: 'POST', body: JSON.stringify(body) }, session),
  withdrawOffering: (session: string, id: string, participantId: string) =>
    request(
      `/offerings/${encodeURIComponent(id)}?participantId=${participantId}`,
      { method: 'DELETE' },
      session,
    ),

  subscriptions: (session: string, participantId: string) =>
    request<{ subscriptions: Subscription[] }>(
      `/subscriptions?participantId=${participantId}`,
      {},
      session,
    ),
  createSubscription: (session: string, participantId: string, body: Record<string, unknown>) =>
    request<Subscription>(
      `/subscriptions?participantId=${participantId}`,
      { method: 'POST', body: JSON.stringify(body) },
      session,
    ),
  deleteSubscription: (session: string, participantId: string, id: string) =>
    request(`/subscriptions/${id}?participantId=${participantId}`, { method: 'DELETE' }, session),
}
