/**
 * The minimal admin UI.
 *
 * What M2 needs it to do: mint and revoke an API key, browse the audit log, and
 * register a notification subscription. Plus the two things an operator asks
 * first — who am I, and is my chain intact.
 *
 * Deliberately small. It manages the connector; it does not run processes.
 */
import { useCallback, useEffect, useState } from 'react'

import {
  ApiError,
  SCOPES,
  api,
  rememberSession,
  storedSession,
  type ApiKey,
  type AuditEntry,
  type DefinitionSummary,
  type Offering,
  type Connection,
  type Participant,
  type Status,
  type Subscription,
  type TrustedPeer,
} from './api.js'

type Tab = 'overview' | 'connections' | 'keys' | 'audit' | 'subscriptions' | 'offerings'

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'connections', label: 'Connections' },
  { id: 'keys', label: 'API keys' },
  { id: 'audit', label: 'Audit log' },
  { id: 'subscriptions', label: 'Notifications' },
  { id: 'offerings', label: 'Offerings' },
]

function Card({
  title,
  children,
  actions,
}: {
  title: string
  children: React.ReactNode
  actions?: React.ReactNode
}) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900">
      <header className="flex items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-slate-700">
        <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{title}</h2>
        {actions}
      </header>
      <div className="p-4">{children}</div>
    </section>
  )
}

function Button({
  children,
  onClick,
  variant = 'primary',
  type = 'button',
  disabled,
}: {
  children: React.ReactNode
  onClick?: () => void
  variant?: 'primary' | 'ghost' | 'danger'
  type?: 'button' | 'submit'
  disabled?: boolean
}) {
  const styles = {
    primary: 'bg-slate-900 text-white hover:bg-slate-700 dark:bg-slate-100 dark:text-slate-900',
    ghost:
      'border border-slate-300 text-slate-700 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800',
    danger:
      'border border-red-300 text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-300',
  }[variant]
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`rounded-md px-3 py-1.5 text-sm font-medium transition disabled:opacity-40 ${styles}`}
    >
      {children}
    </button>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400">
        {label}
      </span>
      {children}
    </label>
  )
}

const inputClass =
  'w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100'

function Outcome({ outcome }: { outcome: string }) {
  const styles =
    outcome === 'ok'
      ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300'
      : 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300'
  return <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${styles}`}>{outcome}</span>
}

export function App() {
  const [session, setSession] = useState<string | null>(storedSession())
  const [token, setToken] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('overview')
  const [participantId, setParticipantId] = useState<string>('')
  const [participants, setParticipants] = useState<Participant[]>([])

  const signIn = async () => {
    setError(null)
    try {
      const { session: created } = await api.signIn(token.trim())
      rememberSession(created.id)
      setSession(created.id)
      setToken('')
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'sign-in failed')
    }
  }

  const signOut = useCallback(() => {
    if (session) void api.signOut(session).catch(() => undefined)
    rememberSession(null)
    setSession(null)
  }, [session])

  useEffect(() => {
    if (!session) return
    api
      .participants(session)
      .then(({ participants: list }) => {
        setParticipants(list)
        setParticipantId((current) => current || (list[0]?.id ?? ''))
      })
      .catch(() => signOut())
  }, [session, signOut])

  if (!session) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 p-6">
        <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
          Connector admin
        </h1>
        <p className="text-sm text-slate-600 dark:text-slate-400">
          Paste the admin token the connector printed on first boot. It is stored only as an HMAC,
          so it is shown once and cannot be recovered.
        </p>
        <input
          className={inputClass}
          type="password"
          value={token}
          placeholder="adm_…"
          onChange={(event) => setToken(event.target.value)}
          onKeyDown={(event) => event.key === 'Enter' && void signIn()}
        />
        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        <Button onClick={() => void signIn()}>Sign in</Button>
      </main>
    )
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <header className="border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-6 py-3">
          <h1 className="text-sm font-semibold">Connector admin</h1>
          <div className="flex items-center gap-3">
            {participants.length > 1 && (
              <select
                className={`${inputClass} w-auto`}
                value={participantId}
                onChange={(event) => setParticipantId(event.target.value)}
              >
                {participants.map((participant) => (
                  <option key={participant.id} value={participant.id}>
                    {participant.displayName}
                  </option>
                ))}
              </select>
            )}
            <Button variant="ghost" onClick={signOut}>
              Sign out
            </Button>
          </div>
        </div>
        <nav className="mx-auto flex max-w-5xl gap-1 px-6">
          {TABS.map((entry) => (
            <button
              key={entry.id}
              onClick={() => setTab(entry.id)}
              className={`border-b-2 px-3 py-2 text-sm transition ${
                tab === entry.id
                  ? 'border-slate-900 font-medium dark:border-slate-100'
                  : 'border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
              }`}
            >
              {entry.label}
            </button>
          ))}
        </nav>
      </header>

      <main className="mx-auto flex max-w-5xl flex-col gap-4 p-6">
        {tab === 'overview' && <Overview session={session} participants={participants} />}
        {tab === 'connections' && <Connections session={session} participantId={participantId} />}
        {tab === 'keys' && <Keys session={session} participantId={participantId} />}
        {tab === 'audit' && <Audit session={session} participantId={participantId} />}
        {tab === 'subscriptions' && (
          <Subscriptions session={session} participantId={participantId} />
        )}
        {tab === 'offerings' && <Offerings session={session} participantId={participantId} />}
      </main>
    </div>
  )
}

function Overview({ session, participants }: { session: string; participants: Participant[] }) {
  const [status, setStatus] = useState<Status | null>(null)
  const [definitions, setDefinitions] = useState<DefinitionSummary[]>([])

  useEffect(() => {
    void api.status(session).then(setStatus)
    void api.definitions(session).then(({ definitions: list }) => setDefinitions(list))
  }, [session])

  return (
    <>
      <Card title="This connector">
        {status && (
          <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            {[
              ['Environment', status.environment],
              ['Store', `${status.store} (0 databases)`],
              ['Definitions', String(status.definitions)],
              ['Participants', String(status.participants)],
            ].map(([label, value]) => (
              <div key={label}>
                <dt className="text-xs text-slate-500">{label}</dt>
                <dd className="font-medium">{value}</dd>
              </div>
            ))}
          </dl>
        )}
        {status?.secrets.ephemeral && (
          <p className="mt-4 rounded-md bg-amber-100 px-3 py-2 text-sm text-amber-900 dark:bg-amber-900/30 dark:text-amber-200">
            Secrets were generated but cannot be persisted ({status.secrets.store}). They will
            change on restart, invalidating every API key and moving this participant’s DID
            document.
          </p>
        )}
      </Card>

      <Card title="Participants">
        <ul className="flex flex-col gap-3 text-sm">
          {participants.map((participant) => (
            <li key={participant.id}>
              <div className="font-medium">{participant.displayName}</div>
              <div className="font-mono text-xs text-slate-500">{participant.did}</div>
            </li>
          ))}
        </ul>
      </Card>

      <Card title="Process definitions">
        <table className="w-full text-left text-sm">
          <thead className="text-xs uppercase text-slate-500">
            <tr>
              <th className="pb-2">Definition</th>
              <th className="pb-2">Kind</th>
              <th className="pb-2">Hosted by</th>
              <th className="pb-2">Roles</th>
            </tr>
          </thead>
          <tbody>
            {definitions.map((definition) => (
              <tr key={definition.ref} className="border-t border-slate-100 dark:border-slate-800">
                <td className="py-2 font-mono text-xs">{definition.ref}</td>
                <td className="py-2">{definition.kind}</td>
                <td className="py-2">{definition.hostedBy}</td>
                <td className="py-2 text-slate-500">{definition.roles.join(', ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  )
}

function Keys({ session, participantId }: { session: string; participantId: string }) {
  const [keys, setKeys] = useState<ApiKey[]>([])
  const [label, setLabel] = useState('backoffice-prod')
  const [scopes, setScopes] = useState<string[]>(['instances:read', 'instances:write'])
  const [minted, setMinted] = useState<string | null>(null)

  const reload = useCallback(() => {
    if (participantId)
      void api.apiKeys(session, participantId).then(({ apiKeys }) => setKeys(apiKeys))
  }, [session, participantId])

  useEffect(reload, [reload])

  const create = async () => {
    const created = await api.createApiKey(session, { label, scopes, participantId })
    setMinted(created.secret)
    reload()
  }

  return (
    <>
      <Card title="Mint an API key">
        <div className="flex flex-col gap-3">
          <Field label="Label">
            <input
              className={inputClass}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </Field>
          <Field label="Scopes">
            <div className="flex flex-col gap-1">
              {SCOPES.map((scope) => (
                <label key={scope.value} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={scopes.includes(scope.value)}
                    onChange={(event) =>
                      setScopes((current) =>
                        event.target.checked
                          ? [...current, scope.value]
                          : current.filter((value) => value !== scope.value),
                      )
                    }
                  />
                  <span className="font-mono text-xs">{scope.value}</span>
                  <span className="text-slate-500">{scope.label}</span>
                </label>
              ))}
            </div>
          </Field>
          <div>
            <Button onClick={() => void create()} disabled={scopes.length === 0}>
              Create key
            </Button>
          </div>
          {minted && (
            <div className="rounded-md bg-amber-100 p-3 dark:bg-amber-900/30">
              <p className="text-xs font-medium text-amber-900 dark:text-amber-200">
                Copy this now — it is shown once and never stored in the clear.
              </p>
              <code className="mt-1 block break-all font-mono text-xs">{minted}</code>
            </div>
          )}
        </div>
      </Card>

      <Card title="Keys">
        <table className="w-full text-left text-sm">
          <thead className="text-xs uppercase text-slate-500">
            <tr>
              <th className="pb-2">Label</th>
              <th className="pb-2">Scopes</th>
              <th className="pb-2">Last used</th>
              <th className="pb-2" />
            </tr>
          </thead>
          <tbody>
            {keys.map((key) => (
              <tr key={key.id} className="border-t border-slate-100 dark:border-slate-800">
                <td className="py-2">
                  <div className={key.revokedAt ? 'line-through text-slate-400' : ''}>
                    {key.label}
                  </div>
                  <div className="font-mono text-xs text-slate-500">{key.id}</div>
                </td>
                <td className="py-2 font-mono text-xs text-slate-500">{key.scopes.join(' ')}</td>
                <td className="py-2 text-xs text-slate-500">{key.lastUsedAt ?? 'never'}</td>
                <td className="py-2 text-right">
                  {!key.revokedAt && (
                    <Button
                      variant="danger"
                      onClick={() =>
                        void api.revokeApiKey(session, key.id, participantId).then(reload)
                      }
                    >
                      Revoke
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  )
}

function Audit({ session, participantId }: { session: string; participantId: string }) {
  const [entries, setEntries] = useState<AuditEntry[]>([])
  const [verified, setVerified] = useState<{ ok: boolean; entries: number } | null>(null)

  const reload = useCallback(() => {
    if (!participantId) return
    void api
      .audit(session, participantId)
      .then(({ entries: list }) => setEntries([...list].reverse()))
    void api.verifyAudit(session, participantId).then(setVerified)
  }, [session, participantId])

  useEffect(reload, [reload])

  return (
    <Card
      title="Audit log"
      actions={
        <div className="flex items-center gap-3">
          {verified && (
            <span
              className={`rounded px-2 py-0.5 text-xs font-medium ${
                verified.ok
                  ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300'
                  : 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300'
              }`}
            >
              {verified.ok
                ? `chain intact · ${verified.entries} entries`
                : 'CHAIN BROKEN — entries have been altered'}
            </span>
          )}
          <Button variant="ghost" onClick={reload}>
            Refresh
          </Button>
        </div>
      }
    >
      <p className="mb-3 text-xs text-slate-500">
        Locally hash-chained and never replicated. Refusals appear here and nowhere else — they
        produce no event, because nothing happened.
      </p>
      <table className="w-full text-left text-sm">
        <thead className="text-xs uppercase text-slate-500">
          <tr>
            <th className="pb-2">#</th>
            <th className="pb-2">Action</th>
            <th className="pb-2">Actor</th>
            <th className="pb-2">Outcome</th>
            <th className="pb-2">Detail</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr
              key={entry.seq}
              className="border-t border-slate-100 align-top dark:border-slate-800"
            >
              <td className="py-2 font-mono text-xs text-slate-400">{entry.seq}</td>
              <td className="py-2">
                <div className="font-medium">{entry.action}</div>
                <div className="text-xs text-slate-500">{entry.at}</div>
              </td>
              <td className="py-2 text-xs">
                <div>{entry.actor.kind}</div>
                <div className="text-slate-500">{entry.actor.actorRef ?? entry.actor.id}</div>
              </td>
              <td className="py-2">
                <Outcome outcome={entry.outcome} />
              </td>
              <td className="py-2 text-xs text-slate-500">
                {entry.problem ?? entry.request?.path ?? ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  )
}

function Subscriptions({ session, participantId }: { session: string; participantId: string }) {
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([])
  const [label, setLabel] = useState('backoffice-prod')
  const [url, setUrl] = useState('https://backoffice.internal/pilots/hook')
  const [secretRef, setSecretRef] = useState('env:BACKOFFICE_HOOK_SECRET')

  const reload = useCallback(() => {
    if (participantId) {
      void api
        .subscriptions(session, participantId)
        .then(({ subscriptions: list }) => setSubscriptions(list))
    }
  }, [session, participantId])

  useEffect(reload, [reload])

  return (
    <>
      <Card title="Register a notification subscription">
        <p className="mb-3 text-xs text-slate-500">
          How a party with no UI participates: the connector tells your systems when it is your
          turn, and they answer on the local API. <code className="font-mono">action.required</code>{' '}
          carries the signed event and the transitions available to you, so an internal system needs
          no copy of the definition and no state machine of its own.
        </p>
        <div className="flex flex-col gap-3">
          <Field label="Label">
            <input
              className={inputClass}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </Field>
          <Field label="Webhook URL">
            <input className={inputClass} value={url} onChange={(e) => setUrl(e.target.value)} />
          </Field>
          <Field label="Shared-secret reference (a name, never a value)">
            <input
              className={inputClass}
              value={secretRef}
              onChange={(e) => setSecretRef(e.target.value)}
            />
          </Field>
          <div>
            <Button
              onClick={() =>
                void api
                  .createSubscription(session, participantId, {
                    label,
                    channel: 'webhook',
                    target: { url, secretRef },
                    notify: ['action.required', 'action.cleared'],
                  })
                  .then(reload)
              }
            >
              Create subscription
            </Button>
          </div>
        </div>
      </Card>

      <Card title="Subscriptions">
        <ul className="flex flex-col gap-3 text-sm">
          {subscriptions.map((subscription) => (
            <li
              key={subscription.id}
              className="flex items-start justify-between border-t border-slate-100 pt-3 first:border-0 first:pt-0 dark:border-slate-800"
            >
              <div>
                <div className="font-medium">{subscription.label}</div>
                <div className="font-mono text-xs text-slate-500">
                  {subscription.channel} · {subscription.target?.url ?? 'sse'} ·{' '}
                  {subscription.notify.join(', ')}
                </div>
              </div>
              <Button
                variant="danger"
                onClick={() =>
                  void api.deleteSubscription(session, participantId, subscription.id).then(reload)
                }
              >
                Delete
              </Button>
            </li>
          ))}
          {subscriptions.length === 0 && <li className="text-slate-500">None yet.</li>}
        </ul>
      </Card>
    </>
  )
}

/**
 * Connections — the only screen where a human makes a trust decision.
 *
 * Accepting is an administrative act for exactly that reason. The peer callback
 * that reports the decision lives on the peer surface, so a peer can never
 * accept its own request.
 */
function Connections({ session, participantId }: { session: string; participantId: string }) {
  const [connections, setConnections] = useState<Connection[]>([])
  const [trusted, setTrusted] = useState<TrustedPeer[]>([])
  const [error, setError] = useState<string | null>(null)
  const [form, setForm] = useState({ peerDid: '', peerBaseUrl: '', channel: 'stream' })
  const [allow, setAllow] = useState('')

  const reload = useCallback(() => {
    if (!participantId) return
    void api
      .connections(session, participantId)
      .then(({ connections: list }) => setConnections(list))
    void api
      .trustedPeers(session, participantId)
      .then(({ trustedPeers }) => setTrusted(trustedPeers))
  }, [session, participantId])

  useEffect(reload, [reload])

  const run = (work: Promise<unknown>) => {
    setError(null)
    void work.then(reload).catch((cause: unknown) => {
      setError(cause instanceof ApiError ? cause.message : String(cause))
    })
  }

  return (
    <>
      <Card title="Request a connection">
        <p className="mb-3 text-xs text-slate-500">
          Two participants connect once, and everything afterwards flows over that one relationship
          — in both directions and for either side&rsquo;s offerings. There is no callback URL per
          request and no separate supplier connection. Choose <code>stream</code> to receive events
          over a line this connector holds open: no inbound endpoint, no DNS entry, no certificate.
        </p>
        <div className="flex flex-col gap-3">
          <Field label="Peer DID">
            <input
              className={inputClass}
              placeholder="did:web:vanmoer.example"
              value={form.peerDid}
              onChange={(e) => setForm({ ...form, peerDid: e.target.value })}
            />
          </Field>
          <Field label="Peer base URL">
            <input
              className={inputClass}
              placeholder="https://vanmoer.example"
              value={form.peerBaseUrl}
              onChange={(e) => setForm({ ...form, peerBaseUrl: e.target.value })}
            />
          </Field>
          <Field label="How we want to receive their events">
            <select
              className={inputClass}
              value={form.channel}
              onChange={(e) => setForm({ ...form, channel: e.target.value })}
            >
              <option value="stream">stream — we hold the line open</option>
              <option value="webhook">webhook — they POST to us</option>
            </select>
          </Field>
          <div>
            <Button
              onClick={() =>
                run(
                  api.requestConnection(session, participantId, {
                    peerDid: form.peerDid,
                    peerBaseUrl: form.peerBaseUrl,
                    delivery:
                      form.channel === 'stream'
                        ? { channel: 'stream' }
                        : {
                            channel: 'webhook',
                            url: `${window.location.origin}/api/peer/v1/deliveries`,
                          },
                  }),
                )
              }
              disabled={form.peerDid === '' || form.peerBaseUrl === ''}
            >
              Send request
            </Button>
          </div>
          {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
        </div>
      </Card>

      <Card title="Connections">
        {connections.length === 0 ? (
          <p className="text-sm text-slate-500">No connections yet.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {connections.map((connection) => (
              <li
                key={connection.id}
                className="rounded-md border border-slate-200 p-3 dark:border-slate-700"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                      {connection.peerDisplayName ?? connection.peerDid}
                    </p>
                    <p className="truncate font-mono text-xs text-slate-500">
                      {connection.peerDid}
                    </p>
                  </div>
                  <ConnectionStatus status={connection.status} />
                </div>
                <p className="mt-2 text-xs text-slate-500">
                  we receive by <code>{connection.inbound.channel}</code>, we deliver by{' '}
                  <code>{connection.outbound.channel}</code>
                </p>
                {connection.lastError && (
                  <p className="mt-1 text-xs text-red-600 dark:text-red-400">
                    {connection.lastError}
                  </p>
                )}
                <div className="mt-3 flex gap-2">
                  {connection.status === 'PENDING_INBOUND' && (
                    <>
                      <Button
                        onClick={() =>
                          run(
                            api.decideConnection(session, participantId, connection.id, 'accept', {
                              delivery: { channel: 'stream' },
                            }),
                          )
                        }
                      >
                        Accept
                      </Button>
                      <Button
                        variant="danger"
                        onClick={() =>
                          run(
                            api.decideConnection(
                              session,
                              participantId,
                              connection.id,
                              'reject',
                              {},
                            ),
                          )
                        }
                      >
                        Reject
                      </Button>
                    </>
                  )}
                  {(connection.status === 'ACTIVE' || connection.status === 'DEGRADED') && (
                    <Button
                      variant="danger"
                      onClick={() =>
                        run(api.decideConnection(session, participantId, connection.id, 'revoke'))
                      }
                    >
                      Revoke
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Auto-accept allowlist">
        <p className="mb-3 text-xs text-slate-500">
          A peer on this list has its connection requests accepted without asking you. The trust
          checks still run — the DID is resolved and its document&rsquo;s host must match the base
          URL the caller claims — so this decides <em>who you skip the prompt for</em>, not what is
          verified.
        </p>
        <div className="flex gap-2">
          <input
            className={inputClass}
            placeholder="did:web:vanmoer.example"
            value={allow}
            onChange={(e) => setAllow(e.target.value)}
          />
          <Button
            onClick={() => {
              run(api.trustPeer(session, participantId, { did: allow }))
              setAllow('')
            }}
            disabled={allow === ''}
          >
            Add
          </Button>
        </div>
        <ul className="mt-3 flex flex-col gap-2">
          {trusted.map((peer) => (
            <li key={peer.did} className="flex items-center justify-between gap-3">
              <span className="truncate font-mono text-xs">{peer.did}</span>
              <Button
                variant="ghost"
                onClick={() => run(api.untrustPeer(session, participantId, peer.did))}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      </Card>
    </>
  )
}

function ConnectionStatus({ status }: { status: Connection['status'] }) {
  const styles: Record<string, string> = {
    ACTIVE: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300',
    // Not an error: peer delivery is failing, the business process is not.
    DEGRADED: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
    PENDING_INBOUND: 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300',
    PENDING_OUTBOUND: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
    REJECTED: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
    REVOKED: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  }
  return (
    <span
      className={`shrink-0 rounded px-1.5 py-0.5 text-xs font-medium ${styles[status] ?? styles['REVOKED']}`}
    >
      {status}
    </span>
  )
}

function Offerings({ session, participantId }: { session: string; participantId: string }) {
  const [offerings, setOfferings] = useState<Offering[]>([])
  const [definitions, setDefinitions] = useState<DefinitionSummary[]>([])
  const [form, setForm] = useState({
    id: 'urn:offering:example:container-weighing',
    title: 'Container weighing',
    quotationDefinition: '',
    serviceDefinition: '',
    price: '45',
  })

  const reload = useCallback(() => {
    if (participantId) {
      void api.offerings(session, participantId).then(({ offerings: list }) => setOfferings(list))
    }
  }, [session, participantId])

  useEffect(() => {
    reload()
    void api.definitions(session).then(({ definitions: list }) => {
      setDefinitions(list)
      setForm((current) => ({
        ...current,
        quotationDefinition:
          current.quotationDefinition || (list.find((d) => d.kind === 'quotation')?.ref ?? ''),
        serviceDefinition:
          current.serviceDefinition || (list.find((d) => d.kind === 'service')?.ref ?? ''),
      }))
    })
  }, [reload, session])

  return (
    <>
      <Card title="Publish an offering">
        <p className="mb-3 text-xs text-slate-500">
          Publishing an offering is what makes this participant a supplier. It is a runtime record,
          not configuration and not a deployment mode — withdraw it and it stops being one, with no
          restart, while anything already running carries on.
        </p>
        <div className="flex flex-col gap-3">
          <Field label="Offering URN">
            <input
              className={inputClass}
              value={form.id}
              onChange={(e) => setForm({ ...form, id: e.target.value })}
            />
          </Field>
          <Field label="Title">
            <input
              className={inputClass}
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
            />
          </Field>
          <Field label="Quotation definition">
            <select
              className={inputClass}
              value={form.quotationDefinition}
              onChange={(e) => setForm({ ...form, quotationDefinition: e.target.value })}
            >
              {definitions
                .filter((d) => d.kind === 'quotation')
                .map((d) => (
                  <option key={d.ref}>{d.ref}</option>
                ))}
            </select>
          </Field>
          <Field label="Service definition">
            <select
              className={inputClass}
              value={form.serviceDefinition}
              onChange={(e) => setForm({ ...form, serviceDefinition: e.target.value })}
            >
              {definitions
                .filter((d) => d.kind === 'service')
                .map((d) => (
                  <option key={d.ref}>{d.ref}</option>
                ))}
            </select>
          </Field>
          <Field label="Price (EUR)">
            <input
              className={inputClass}
              value={form.price}
              onChange={(e) => setForm({ ...form, price: e.target.value })}
            />
          </Field>
          <div>
            <Button
              onClick={() =>
                void api
                  .publishOffering(session, {
                    id: form.id,
                    title: form.title,
                    quotationDefinition: form.quotationDefinition,
                    serviceDefinition: form.serviceDefinition,
                    price: { value: Number(form.price), currency: 'EUR' },
                    participantId,
                  })
                  .then(reload)
              }
            >
              Publish
            </Button>
          </div>
        </div>
      </Card>

      <Card title="Offerings">
        <ul className="flex flex-col gap-3 text-sm">
          {offerings.map((offering) => (
            <li
              key={offering.id}
              className="flex items-start justify-between border-t border-slate-100 pt-3 first:border-0 first:pt-0 dark:border-slate-800"
            >
              <div>
                <div className="font-medium">
                  {offering.title}{' '}
                  {offering.status === 'WITHDRAWN' && (
                    <span className="text-xs text-slate-400">(withdrawn)</span>
                  )}
                </div>
                <div className="font-mono text-xs text-slate-500">{offering.id}</div>
              </div>
              {offering.status === 'PUBLISHED' && (
                <Button
                  variant="danger"
                  onClick={() =>
                    void api.withdrawOffering(session, offering.id, participantId).then(reload)
                  }
                >
                  Withdraw
                </Button>
              )}
            </li>
          ))}
          {offerings.length === 0 && <li className="text-slate-500">None yet.</li>}
        </ul>
      </Card>
    </>
  )
}
