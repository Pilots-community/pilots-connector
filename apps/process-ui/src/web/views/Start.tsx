/**
 * Starting a process.
 *
 * Every field on this screen is rendered from the definition: one select per
 * declared role, and a form generated from the definition's own `data` schema.
 * A sixth definition would appear here with no code change.
 */
import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'

import { UiError, api, type Offering } from '../api.js'
import { SchemaForm } from '../components/SchemaForm.js'
import { StateDiagram } from '../graph/StateDiagram.js'
import { queries } from '../queries.js'
import { Card, Problem, button, input } from '../ui.js'
import { Offerings } from './Offerings.js'

export function Start({ onStarted }: { onStarted: (id: string) => void }) {
  const [ref, setRef] = useState('')
  const [participants, setParticipants] = useState<Record<string, string>>({})
  const [data, setData] = useState<Record<string, unknown>>({})
  const [error, setError] = useState<UiError | null>(null)
  /**
   * The offering this start came from, if any.
   *
   * Kept because it decides *how* to start: an offering knows the service its
   * quotation authorises, so the two instances can be created together with the
   * service anchored to the quotation. Without that anchor the agreement
   * contracts nothing.
   */
  const [offering, setOffering] = useState<Offering | null>(null)

  const demoTools = useQuery(queries.session()).data?.demoTools ?? false
  const definitions = useQuery(queries.definitions()).data ?? []
  const connections = useQuery(queries.connections()).data ?? []
  const peers = connections
    .filter((one) => one.status === 'ACTIVE' || one.status === 'DEGRADED')
    .map((one) => ({ did: one.peerDid, name: one.peerDisplayName ?? one.peerDid }))

  /*
   * The out-of-order fetch this used to guard against is gone: react-query keys
   * the definition by ref, so a late answer for the definition you *were*
   * looking at can no longer overwrite the one you are looking at now.
   */
  const definition = useQuery({ ...queries.definition(ref), enabled: ref !== '' }).data?.definition
  /** The summary for the chosen ref, which carries whether it can be started alone. */
  const selected = definitions.find((one) => one.ref === ref)

  useEffect(() => {
    if (ref === '' && definitions[0]) setRef(definitions[0].ref)
  }, [ref, definitions])

  /**
   * Start from an offering.
   *
   * The **quotation** is what a consumer instantiates — the offering says so —
   * and agreeing it is what contracts the service. Selecting the service
   * definition here used to land on a process that cannot be started on its
   * own, so the screen offered a Start button that could only ever fail.
   */
  const fromOffering = (offering: Offering): void => {
    setRef(offering.quotationDefinition)
    setOffering(offering)
    setParticipants({})
    setData({})
    setError(null)
  }

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
                setOffering(null)
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

          {/*
            What you are about to start, before you commit to it. The same
            picture the instance shows afterwards, with nothing walked yet.
          */}
          {definition && <StateDiagram definition={definition} height="h-48" />}

          {definition && (
            <SchemaForm
              schema={definition.data}
              value={data}
              onChange={setData}
              demoTools={demoTools}
            />
          )}

          {/*
            A process contracted by another one cannot be started here. Saying
            so — and saying what would start it — is the difference between a
            screen that guides and one that lets somebody create a process whose
            only remaining action is cancel.
          */}
          {selected !== undefined && !selected.startableStandalone && (
            <p
              data-testid="not-standalone"
              className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
            >
              This process is started by another one reaching agreement — it needs a{' '}
              {selected.requiresRelations.join(' or ')} — so it cannot be started on its own. Start
              the matching quotation instead, or pick it from an offering below.
            </p>
          )}

          {error && <Problem error={error} />}

          <button
            className={button}
            type="button"
            data-testid="start"
            disabled={selected !== undefined && !selected.startableStandalone}
            onClick={() => {
              setError(null)
              /*
               * From an offering, the quotation and the execution it authorises
               * are created together, with the execution pointing at the
               * quotation. Otherwise this is an ordinary single instance.
               */
              const started =
                offering === null
                  ? api
                      .createInstance({ definition: ref, participants, data })
                      .then(({ instance }) => instance.id)
                  : api
                      .startFromOffering({
                        offering: offering.id,
                        quotationDefinition: offering.quotationDefinition,
                        serviceDefinition: offering.serviceDefinition,
                        participants,
                        data,
                      })
                      .then(({ quotation }) => quotation.id)

              void started
                .then((id) => onStarted(id))
                .catch((cause: unknown) => {
                  if (cause instanceof UiError) setError(cause)
                })
            }}
          >
            Start
          </button>
        </div>
      </Card>

      <Offerings onStart={fromOffering} />
    </div>
  )
}
