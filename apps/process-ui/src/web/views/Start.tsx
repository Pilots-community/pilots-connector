/**
 * Starting a process.
 *
 * Every field on this screen is rendered from the definition: one select per
 * declared role, and a form generated from the definition's own `data` schema.
 * A sixth definition would appear here with no code change.
 */
import { useEffect, useState } from 'react'

import {
  UiError,
  api,
  type DefinitionSummary,
  type Offering,
  type ProcessDefinition,
} from '../api.js'
import { SchemaForm } from '../components/SchemaForm.js'
import { Card, Problem, button, input } from '../ui.js'

export function Start({ onStarted }: { onStarted: (id: string) => void }) {
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
