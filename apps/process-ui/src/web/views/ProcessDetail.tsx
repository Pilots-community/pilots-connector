/**
 * One instance: where it is, what you may do next, and the log that proves it.
 *
 * The buttons come from `available`, which the connector computed from the
 * definition — the same answer the permission check and the notifications use.
 * The forms come from each transition's own `patch` schema. Nothing here knows
 * what a weighing is.
 */
import { useCallback, useEffect, useState } from 'react'

import {
  UiError,
  api,
  type InstanceView,
  type ProcessDefinition,
  type SignedEvent,
  type VerificationReport,
} from '../api.js'
import { EventLog, VerificationBanner } from '../components/EventLog.js'
import { SchemaForm } from '../components/SchemaForm.js'
import { Card, Problem, button, ghost } from '../ui.js'

export function ProcessDetail({ id, onBack }: { id: string; onBack: () => void }) {
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
