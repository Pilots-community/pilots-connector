/**
 * One instance: where it is, what you may do next, and the log that proves it.
 *
 * The buttons come from `available`, which the connector computed from the
 * definition — the same answer the permission check and the notifications use.
 * The forms come from each transition's own `patch` schema. Nothing here knows
 * what a weighing is.
 */
import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import { UiError, api } from '../api.js'
import { EventLog, VerificationBanner } from '../components/EventLog.js'
import { SchemaForm } from '../components/SchemaForm.js'
import { StateDiagram } from '../graph/StateDiagram.js'
import { keys, queries } from '../queries.js'
import { Card, Problem, button, ghost } from '../ui.js'

export function ProcessDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const client = useQueryClient()
  const log = useQuery(queries.events(id))
  const instance = log.data?.instance
  const events = log.data?.events ?? []
  const report = log.data?.verification

  const definition = useQuery({
    ...queries.definition(instance?.definition ?? ''),
    enabled: Boolean(instance),
  }).data?.definition

  /*
   * Form state, and nothing else, lives here.
   *
   * A revalidation lands every few seconds and must never write to any of it —
   * that is the whole of "refresh without disturbing an open form". `openedAt`
   * is the `seq` the form was started against, which is both what `If-Match`
   * carries and how we notice the instance moved underneath.
   */
  const [chosen, setChosen] = useState<{ transition: string; openedAt: number } | null>(null)
  const [patch, setPatch] = useState<Record<string, unknown>>({})
  const [file, setFile] = useState<File | null>(null)
  const [error, setError] = useState<UiError | null>(null)
  const [busy, setBusy] = useState(false)

  const reload = (): void => {
    void client.invalidateQueries({ queryKey: keys.events(id) })
    void client.invalidateQueries({ queryKey: keys.instances })
  }

  if (!instance || !report) return <p className="text-sm text-slate-500">Loading…</p>

  const transition = chosen
    ? definition?.transitions.find((one) => one.id === chosen.transition)
    : undefined
  const movedUnderneath = chosen !== null && instance.seq !== chosen.openedAt

  return (
    // The id is on the container so a test can open a *particular* instance
    // rather than whichever row happens to sort first.
    <div className="flex flex-col gap-4" data-instance={instance.id}>
      <button type="button" className={`${ghost} self-start`} onClick={onBack}>
        ← All processes
      </button>

      <VerificationBanner report={report} />

      {definition && (
        <Card title={`${definition.title} · ${instance.state}`}>
          {/*
            The state machine and the progress through it, in one picture: the
            path taken is drawn bold, the current state is filled, and what
            remains is dimmed. Derived from the definition, so a sixth process
            needs no work here either.
          */}
          <StateDiagram definition={definition} history={events} current={instance.state} />
        </Card>
      )}

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
          <dt className="text-slate-500">Progress</dt>
          <dd data-testid="outcome">
            {instance.outcome === 'running'
              ? 'in progress'
              : instance.outcome === 'fulfilled'
                ? 'completed'
                : 'stopped before completing'}
          </dd>
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
                  className={action.transition === chosen?.transition ? button : ghost}
                  onClick={() => {
                    // The seq is captured here, not read at submit time: it is
                    // what the person actually saw when they decided.
                    setChosen({ transition: action.transition, openedAt: instance.seq })
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

            {transition && chosen && (
              <div className="flex flex-col gap-3 rounded-md border border-slate-200 p-3 dark:border-slate-700">
                {/*
                  Non-blocking on purpose: nothing is disabled and no field is
                  cleared. Yanking a half-filled form away because the other
                  party moved would lose work that is still perfectly good.
                */}
                {movedUnderneath && (
                  <div
                    data-testid="moved-banner"
                    className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
                  >
                    This process moved on while you were filling this in — it is now{' '}
                    <strong>{instance.state}</strong>. Your entries are untouched, but submitting
                    may be refused.
                  </div>
                )}

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
                          // The seq the form was opened against, not the latest
                          // one. Re-reading it here would silently overwrite
                          // whatever the other party just did — the lost update
                          // this header exists to prevent.
                          ifMatch: chosen.openedAt,
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
