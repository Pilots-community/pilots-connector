import type { Command, DefinitionDocument } from '@pilots/bpmn'
import { useState } from 'react'

import { input } from '../../ui.js'
import { Labelled, TextField } from '../fields.js'
import { FieldBuilder } from './FieldBuilder.js'
import { VisibilityMatrix } from './VisibilityMatrix.js'

type Tab = 'general' | 'data' | 'visibility'

export function ProcessPanel({ document, run }: { document: DefinitionDocument; run: (c: Command) => void }) {
  const [tab, setTab] = useState<Tab>('general')
  const set = (patch: Extract<Command, { type: 'setProcess' }>['patch']): void => run({ type: 'setProcess', patch })
  return (
    <>
      <div className="flex gap-2 text-xs">
        {(['general', 'data', 'visibility'] as const).map((one) => (
          <button
            key={one}
            type="button"
            data-testid={`process-tab-${one}`}
            className={one === tab ? 'font-semibold underline' : 'text-slate-500'}
            onClick={() => setTab(one)}
          >
            {one === 'general' ? 'Process' : one === 'data' ? 'Data' : 'Who sees what'}
          </button>
        ))}
      </div>

      {tab === 'general' && (
        <>
          <TextField label="Id" value={document.id} testid="process-id" onCommit={(id) => set({ id })} />
          <TextField label="Version" value={document.version} testid="process-version" onCommit={(version) => set({ version })} />
          <TextField label="Title" value={document.title} testid="process-title" onCommit={(title) => set({ title })} />
          <TextField
            label="Description"
            value={document.description ?? ''}
            onCommit={(text) => set({ description: text === '' ? undefined : text })}
          />
          <Labelled label="Kind">
            <select className={input} value={document.kind} onChange={(e) => set({ kind: e.target.value as 'service' | 'quotation' })}>
              <option value="service">service</option>
              <option value="quotation">quotation</option>
            </select>
          </Labelled>
          <Labelled label="Hosted by">
            <select className={input} data-testid="process-hostedBy" value={document.hostedBy} onChange={(e) => set({ hostedBy: e.target.value })}>
              {document.hostedBy === '' && <option value="">— choose a role —</option>}
              {document.roles.map((one) => (
                <option key={one.id} value={one.id}>
                  {one.title}
                </option>
              ))}
            </select>
          </Labelled>
          <Labelled label="Starts in">
            <select
              className={input}
              data-testid="process-initialState"
              value={document.initialState}
              onChange={(e) => set({ initialState: e.target.value })}
            >
              {document.initialState === '' && <option value="">— choose a state —</option>}
              {document.states.map((one) => (
                <option key={one.id} value={one.id}>
                  {one.title} ({one.id})
                </option>
              ))}
            </select>
          </Labelled>
          <Labelled label="Fields nobody is granted">
            <select
              className={input}
              value={document.defaultVisibility ?? 'all'}
              onChange={(e) => set({ defaultVisibility: e.target.value as 'all' | 'none' })}
            >
              <option value="all">are visible to everyone</option>
              <option value="none">are visible to nobody</option>
            </select>
          </Labelled>
          <Labelled label="Who may start it (none ticked: anyone)">
            <div className="flex flex-col gap-1">
              {document.roles.map((one) => {
                const chosen = document.createdBy ?? []
                return (
                  <label key={one.id} className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={chosen.includes(one.id)}
                      onChange={(e) => {
                        const next = e.target.checked ? [...chosen, one.id] : chosen.filter((r) => r !== one.id)
                        set({ createdBy: next.length === 0 ? undefined : next })
                      }}
                    />
                    {one.title}
                  </label>
                )
              })}
            </div>
          </Labelled>
        </>
      )}

      {tab === 'data' && <FieldBuilder document={document} run={run} />}
      {tab === 'visibility' && <VisibilityMatrix document={document} run={run} />}
    </>
  )
}
