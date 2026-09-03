/**
 * The demo process management UI.
 *
 * Everything a participant does with a running process, and **nothing that is
 * specific to any one process**. The instance detail renders its buttons from
 * `available`, which the connector computed from the definition, and its forms
 * from the definition's own `patch` schemas. A sixth definition would appear
 * here with no code change, which is the claim this app exists to make good.
 *
 * It is also entirely replaceable. It holds no key, knows no peer, and speaks
 * only to its own BFF — stop this container and the connector will not notice.
 */
import { useCallback, useEffect, useState } from 'react'

import {
  UiError,
  api,
  type DefinitionSummary,
  type InstanceView,
  type Offering,
  type ProcessDefinition,
  type SessionUser,
  type SignedEvent,
  type VerificationReport,
} from './api.js'
import { EventLog, VerificationBanner } from './components/EventLog.js'
import { SchemaForm } from './components/SchemaForm.js'

const button =
  'rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-slate-700 disabled:opacity-40 dark:bg-slate-100 dark:text-slate-900'
const ghost =
  'rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800'
const input =
  'w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-800'

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900">
      <header className="border-b border-slate-200 px-4 py-3 dark:border-slate-700">
        <h2 className="text-sm font-semibold">{title}</h2>
      </header>
      <div className="p-4">{children}</div>
    </section>
  )
}

function Problem({ error }: { error: UiError }) {
  return (
    <div
      data-testid="problem"
      className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300"
    >
      <p className="font-medium">{error.problem.title ?? 'Refused'}</p>
      <p className="mt-1">{error.message}</p>
      {error.isConflict && (
        <p className="mt-1 text-xs">
          Somebody else advanced this while you were looking at it — it is now at seq{' '}
          {error.problem.seq}. Reload and decide again; this is not something to retry blindly.
        </p>
      )}
      {error.isRetryable && (
        <p className="mt-1 text-xs">
          The other party’s connector did not answer. Nothing happened, so the same action is safe
          to try again.
        </p>
      )}
    </div>
  )
}

// ── sign in ─────────────────────────────────────────────────────────────────

function SignIn({
  onDone,
  participant,
  did,
}: {
  onDone: () => void
  participant: string
  did: string | null
}) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  return (
    <div className="mx-auto mt-24 w-full max-w-sm">
      <Card title={`Sign in — ${participant}`}>
        {did ? (
          <p className="mb-3 text-xs text-slate-500" data-testid="signin-did">
            This UI belongs to <span className="font-mono">{did}</span>.
          </p>
        ) : null}
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            setError(null)
            const work = creating
              ? api.signUp(email, password, email.split('@')[0] ?? email)
              : api.signIn(email, password)
            void work.then(onDone).catch((cause: unknown) => {
              setError(cause instanceof Error ? cause.message : String(cause))
            })
          }}
        >
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-600">Email</span>
            <input
              className={input}
              type="email"
              name="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-600">Password</span>
            <input
              className={input}
              type="password"
              name="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          {error && <p className="text-xs text-red-600">{error}</p>}
          <button className={button} type="submit">
            {creating ? 'Create account' : 'Sign in'}
          </button>
          <button
            type="button"
            className="text-xs text-slate-500 underline"
            onClick={() => setCreating(!creating)}
          >
            {creating ? 'I already have an account' : 'Create an account'}
          </button>
        </form>
        <p className="mt-4 text-xs text-slate-500">
          These accounts belong to <em>this</em> UI, not to the connector. The connector
          authenticates one API key and records who was driving as an audit hint — it has no idea
          who you are, and that is what lets somebody else’s UI replace this one.
        </p>
      </Card>
    </div>
  )
}

// ── starting something ──────────────────────────────────────────────────────

function Start({ onStarted }: { onStarted: (id: string) => void }) {
  const [definitions, setDefinitions] = useState<DefinitionSummary[]>([])
  const [offerings, setOfferings] = useState<Offering[]>([])
  const [peers, setPeers] = useState<Array<{ did: string; name: string }>>([])
  const [ref, setRef] = useState('')
  const [definition, setDefinition] = useState<ProcessDefinition | null>(null)
  const [participants, setParticipants] = useState<Record<string, string>>({})
  const [data, setData] = useState<Record<string, unknown>>({})
  const [error, setError] = useState<UiError | null>(null)

  useEffect(() => {
    void api.definitions().then(({ definitions: list }) => {
      setDefinitions(list)
      if (list[0]) setRef(list[0].ref)
    })
    void api.offerings().then(({ offerings: list }) => setOfferings(list))
    void api.connections().then(({ connections }) => {
      setPeers(
        connections
          .filter((one) => one.status === 'ACTIVE' || one.status === 'DEGRADED')
          .map((one) => ({ did: one.peerDid, name: one.peerDisplayName ?? one.peerDid })),
      )
    })
  }, [])

  useEffect(() => {
    if (ref === '') return
    // Two fetches can be in flight — the initial default and whatever the user
    // just picked — and they can land out of order. Without this guard the
    // stale one wins and quietly wipes the form the user is filling in.
    let current = true
    // Only the definition. Clearing the form here would race with the user
    // filling it in: the fetch lands whenever it lands, and by then they may
    // have chosen a role. The reset belongs where the change happens.
    void api.definition(ref).then(({ definition: found }) => {
      if (current) setDefinition(found)
    })
    return () => {
      current = false
    }
  }, [ref])

  return (
    <div className="flex flex-col gap-4">
      <Card title="Start a process">
        <div className="flex flex-col gap-3">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-600">Definition</span>
            <select
              className={input}
              name="definition"
              value={ref}
              onChange={(event) => {
                // Synchronous, so a half-filled form for one definition can
                // never be submitted against another.
                setRef(event.target.value)
                setParticipants({})
                setData({})
              }}
            >
              {definitions.map((one) => (
                <option key={one.ref} value={one.ref}>
                  {one.title} ({one.kind})
                </option>
              ))}
            </select>
          </label>

          {/*
            One select per role the definition declares. A definition names a
            role; only an instance names the participant filling it — which is
            why this cannot be baked in anywhere.
          */}
          {definition?.roles.map((role) => (
            <label key={role.id} className="block">
              <span className="mb-1 block text-xs font-medium text-slate-600">
                {role.title}
                {role.id === definition.hostedBy && (
                  <span className="ml-1 text-slate-400">· hosts this process</span>
                )}
              </span>
              <select
                className={input}
                data-role={role.id}
                value={participants[role.id] ?? ''}
                onChange={(event) =>
                  setParticipants({ ...participants, [role.id]: event.target.value })
                }
              >
                <option value="">—</option>
                <option value="__self__">Us</option>
                {peers.map((peer) => (
                  <option key={peer.did} value={peer.did}>
                    {peer.name}
                  </option>
                ))}
              </select>
            </label>
          ))}

          {definition && <SchemaForm schema={definition.data} value={data} onChange={setData} />}

          {error && <Problem error={error} />}

          <button
            className={button}
            type="button"
            data-testid="start"
            onClick={() => {
              setError(null)
              void api
                .createInstance({ definition: ref, participants, data })
                .then(({ instance }) => onStarted(instance.id))
                .catch((cause: unknown) => {
                  if (cause instanceof UiError) setError(cause)
                })
            }}
          >
            Start
          </button>
        </div>
      </Card>

      <Card title="Offerings">
        {offerings.length === 0 ? (
          <p className="text-sm text-slate-500">
            Nothing published here. Publishing an offering is what makes a participant a supplier —
            it is done in the connector’s admin UI, and it is a runtime record rather than a
            setting.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {offerings.map((offering) => (
              <li key={offering.id} className="text-sm">
                <span className="font-medium">{offering.title}</span>
                {offering.price && (
                  <span className="ml-2 text-slate-500">
                    {offering.price.value} {offering.price.currency}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}

// ── one instance ────────────────────────────────────────────────────────────

function Detail({ id, onBack }: { id: string; onBack: () => void }) {
  const [instance, setInstance] = useState<InstanceView | null>(null)
  const [definition, setDefinition] = useState<ProcessDefinition | null>(null)
  const [events, setEvents] = useState<SignedEvent[]>([])
  const [report, setReport] = useState<VerificationReport | null>(null)
  const [chosen, setChosen] = useState<string | null>(null)
  const [patch, setPatch] = useState<Record<string, unknown>>({})
  const [file, setFile] = useState<File | null>(null)
  const [error, setError] = useState<UiError | null>(null)
  const [busy, setBusy] = useState(false)

  const reload = useCallback(() => {
    void api.events(id).then(({ events: log, instance: current, verification }) => {
      setEvents(log)
      setInstance(current)
      setReport(verification)
      void api.definition(current.definition).then(({ definition: found }) => setDefinition(found))
    })
  }, [id])

  useEffect(reload, [reload])

  if (!instance || !report) return <p className="text-sm text-slate-500">Loading…</p>

  const transition = definition?.transitions.find((one) => one.id === chosen)

  return (
    <div className="flex flex-col gap-4">
      <button type="button" className={`${ghost} self-start`} onClick={onBack}>
        ← All processes
      </button>

      <VerificationBanner report={report} />

      <Card title={`${instance.definition} · ${instance.state}`}>
        <dl className="grid grid-cols-2 gap-2 text-sm">
          <dt className="text-slate-500">State</dt>
          <dd data-testid="state" className="font-medium">
            {instance.state}
          </dd>
          <dt className="text-slate-500">Sequence</dt>
          <dd className="font-mono">{instance.seq}</dd>
          <dt className="text-slate-500">Record</dt>
          <dd>{instance.home ? 'authoritative here' : 'a verified replica'}</dd>
        </dl>

        <pre
          data-testid="data"
          className="mt-3 overflow-x-auto rounded bg-slate-100 p-2 text-xs dark:bg-slate-800"
        >
          {JSON.stringify(instance.data, null, 2)}
        </pre>
        {instance.redacted && (
          <p className="mt-2 text-xs text-slate-500">
            Some fields are withheld from your role in this state. The chain still verifies — the
            header commits to the payload by hash, so what you cannot read you can still check.
          </p>
        )}
      </Card>

      <Card title="What you can do now">
        {instance.available.length === 0 ? (
          <p data-testid="no-actions" className="text-sm text-slate-500">
            Nothing, at the moment. Either it is the other party’s turn or this process has
            finished.
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {/*
              Rendered from `available`, which the connector computed from the
              definition — the same answer the permission check and the
              notifications use. One rule, three consumers.
            */}
            <div className="flex flex-wrap gap-2">
              {instance.available.map((action) => (
                <button
                  key={action.transition}
                  type="button"
                  data-transition={action.transition}
                  className={action.transition === chosen ? button : ghost}
                  onClick={() => {
                    setChosen(action.transition)
                    setPatch({})
                    setError(null)
                  }}
                >
                  {definition?.transitions.find((one) => one.id === action.transition)?.title ??
                    action.transition}
                  <span className="ml-1 text-xs opacity-60">as {action.role}</span>
                </button>
              ))}
            </div>

            {transition && (
              <div className="flex flex-col gap-3 rounded-md border border-slate-200 p-3 dark:border-slate-700">
                <SchemaForm schema={transition.patch} value={patch} onChange={setPatch} />

                {transition.attachments && (
                  <label className="block">
                    <span className="mb-1 block text-xs font-medium text-slate-600">
                      Document{transition.attachments.required && ' (required)'}
                    </span>
                    <input
                      type="file"
                      data-testid="attachment"
                      className="text-sm"
                      onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                    />
                  </label>
                )}

                {error && <Problem error={error} />}

                <button
                  className={`${button} self-start`}
                  type="button"
                  data-testid="apply"
                  disabled={busy}
                  onClick={() => {
                    setBusy(true)
                    setError(null)
                    void (async () => {
                      try {
                        const attachments = file ? [await api.uploadAttachment(file)] : undefined
                        await api.applyTransition(id, {
                          transition: transition.id,
                          patch: Object.keys(patch).length === 0 ? null : patch,
                          ...(attachments ? { attachments } : {}),
                          // The seq we read. Two people acting at once produce a
                          // conflict here rather than a silent overwrite.
                          ifMatch: instance.seq,
                        })
                        setChosen(null)
                        setPatch({})
                        setFile(null)
                        reload()
                      } catch (cause) {
                        if (cause instanceof UiError) setError(cause)
                        else throw cause
                      } finally {
                        setBusy(false)
                      }
                    })()
                  }}
                >
                  {transition.title}
                </button>
              </div>
            )}
          </div>
        )}
      </Card>

      <Card title="Event log">
        <EventLog events={events} report={report} />
      </Card>
    </div>
  )
}

// ── the shell ───────────────────────────────────────────────────────────────

export function App() {
  const [user, setUser] = useState<SessionUser | null>(null)
  const [participant, setParticipant] = useState('Process UI')
  // Our own DID, shown rather than merely used. Two of these UIs sit side by
  // side in a demo, and "which organisation am I looking at" must never be a
  // question anybody has to answer by checking the port number.
  const [did, setDid] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const [instances, setInstances] = useState<InstanceView[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [tab, setTab] = useState<'processes' | 'start'>('processes')

  const refresh = useCallback(() => {
    void api
      .session()
      .then((session) => {
        setUser(session.user)
        setParticipant(session.participant)
        setDid(session.did)
        // The browser tab too: two tabs called "Pilots" is exactly the ambiguity
        // this is meant to remove.
        document.title = `${session.participant} — Pilots`
        setReady(true)
        if (session.user) void api.instances().then(({ instances: list }) => setInstances(list))
      })
      .catch(() => {
        /*
         * The BFF is unreachable, or answered something unreadable.
         *
         * Without this the promise rejects, `ready` stays false and the app
         * renders `null` — a blank page that never resolves and says nothing.
         * A sign-in screen is both honest and actionable.
         */
        setUser(null)
        setReady(true)
      })
  }, [])

  useEffect(refresh, [refresh])

  if (!ready) return null
  if (!user) return <SignIn participant={participant} did={did} onDone={refresh} />

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4 p-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold" data-testid="participant">
            {participant}
          </h1>
          <p className="text-xs text-slate-500">
            {/*
              The label is configuration; the DID is the identity. Showing both
              keeps the demo honest about which is which — rename an
              organisation and its DID does not move.
            */}
            <span data-testid="did">{did ?? 'connector not reachable'}</span> · signed in as{' '}
            {user.email}
          </p>
        </div>
        <button type="button" className={ghost} onClick={() => void api.signOut().then(refresh)}>
          Sign out
        </button>
      </header>

      {selected ? (
        <Detail
          id={selected}
          onBack={() => {
            setSelected(null)
            refresh()
          }}
        />
      ) : (
        <>
          <nav className="flex gap-2">
            <button
              type="button"
              className={tab === 'processes' ? button : ghost}
              onClick={() => setTab('processes')}
            >
              Processes
            </button>
            <button
              type="button"
              className={tab === 'start' ? button : ghost}
              data-testid="tab-start"
              onClick={() => setTab('start')}
            >
              Start something
            </button>
          </nav>

          {tab === 'start' ? (
            <Start
              onStarted={(id) => {
                setSelected(id)
                setTab('processes')
              }}
            />
          ) : (
            <Card title="Processes">
              {instances.length === 0 ? (
                <p className="text-sm text-slate-500">Nothing running yet.</p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {instances.map((one) => (
                    <li key={one.id}>
                      <button
                        type="button"
                        data-testid="instance-row"
                        data-instance={one.id}
                        className="flex w-full items-center justify-between rounded-md border border-slate-200 p-3 text-left hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800"
                        onClick={() => setSelected(one.id)}
                      >
                        <span>
                          <span className="block text-sm font-medium">{one.definition}</span>
                          <span className="block font-mono text-xs text-slate-500">{one.id}</span>
                        </span>
                        <span className="flex items-center gap-2">
                          {one.available.length > 0 && (
                            <span className="rounded bg-sky-100 px-1.5 py-0.5 text-xs font-medium text-sky-800 dark:bg-sky-900/40 dark:text-sky-300">
                              your turn
                            </span>
                          )}
                          <span className="text-sm">{one.state}</span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          )}
        </>
      )}
    </div>
  )
}
