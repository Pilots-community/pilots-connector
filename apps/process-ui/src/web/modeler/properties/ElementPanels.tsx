/** One panel per kind of element: a role, a state, a task (a transition), a link. */
import { ANY_STATE, pointerOf, type Command, type DefinitionDocument } from '@pilots/bpmn'

import { ghost, input } from '../../ui.js'
import { Labelled, NumberField, TextField } from '../fields.js'
import { Advanced } from './Advanced.js'
import { TaskFieldsEditor } from './TaskFieldsEditor.js'

interface Props {
  document: DefinitionDocument
  run: (command: Command) => void
}

/** The element's raw JSON, folded away: whatever its form cannot express is changed here. */
function AdvancedSection({ document, pointer, run }: Props & { pointer: string | null }) {
  if (pointer === null) return null
  return (
    <details>
      <summary className="cursor-pointer text-xs text-slate-500">Advanced (JSON)</summary>
      <Advanced document={document} pointer={pointer} run={run} />
    </details>
  )
}

const removeButton = (label: string, act: () => void) => (
  <button type="button" className={`${ghost} text-rose-700 dark:text-rose-400`} data-testid="remove-element" onClick={act}>
    {label}
  </button>
)

export function RolePanel({ document, id, run }: Props & { id: string }) {
  const role = document.roles.find((one) => one.id === id)
  if (role === undefined) return null
  return (
    <>
      <h3 className="font-semibold">Lane</h3>
      <TextField label="Id" value={role.id} testid="role-id" onCommit={(to) => run({ type: 'rename', kind: 'role', from: id, to })} />
      <TextField label="Title" value={role.title} testid="role-title" onCommit={(title) => run({ type: 'updateRole', id, patch: { title } })} />
      <Labelled label="How many participants fill it">
        <NumberField value={role.cardinality ?? 1} min={1} onCommit={(cardinality) => run({ type: 'updateRole', id, patch: { cardinality } })} />
      </Labelled>
      <Labelled label="Part it plays">
        <select
          className={input}
          value={role.protocolRole ?? ''}
          onChange={(e) =>
            run({ type: 'updateRole', id, patch: { protocolRole: e.target.value === '' ? undefined : (e.target.value as 'requester' | 'provider' | 'observer') } })
          }
        >
          <option value="">—</option>
          <option value="requester">requester</option>
          <option value="provider">provider</option>
          <option value="observer">observer</option>
        </select>
      </Labelled>
      <AdvancedSection document={document} pointer={pointerOf(document, { kind: 'role', id })} run={run} />
      {removeButton('Remove lane', () => run({ type: 'remove', kind: 'role', id }))}
    </>
  )
}

export function StatePanel({ document, id, run }: Props & { id: string }) {
  const state = document.states.find((one) => one.id === id)
  if (state === undefined) return null
  return (
    <>
      <h3 className="font-semibold">State</h3>
      <TextField label="Id" value={state.id} testid="state-id" onCommit={(to) => run({ type: 'rename', kind: 'state', from: id, to })} />
      <TextField label="Title" value={state.title} testid="state-title" onCommit={(title) => run({ type: 'updateState', id, patch: { title } })} />
      <TextField
        label="Description"
        value={state.description ?? ''}
        onCommit={(text) => run({ type: 'updateState', id, patch: { description: text === '' ? undefined : text } })}
      />
      <Labelled label="Ends the process">
        <select
          className={input}
          data-testid="state-outcome"
          value={state.outcome ?? ''}
          onChange={(e) =>
            run({ type: 'updateState', id, patch: { outcome: e.target.value === '' ? undefined : (e.target.value as 'fulfilled' | 'abandoned') } })
          }
        >
          <option value="">no — the process continues</option>
          <option value="fulfilled">yes — fulfilled</option>
          <option value="abandoned">yes — abandoned</option>
        </select>
      </Labelled>
      <AdvancedSection document={document} pointer={pointerOf(document, { kind: 'state', id })} run={run} />
      {removeButton('Remove state', () => run({ type: 'remove', kind: 'state', id }))}
    </>
  )
}

export function TaskPanel({ document, id, run }: Props & { id: string }) {
  const transition = document.transitions.find((one) => one.id === id)
  if (transition === undefined) return null
  const update = (patch: Extract<Command, { type: 'updateTransition' }>['patch']): void =>
    run({ type: 'updateTransition', id, patch })
  const wildcard = transition.from.includes(ANY_STATE)
  return (
    <>
      <h3 className="font-semibold">Task</h3>
      <TextField label="Id" value={transition.id} testid="task-id" onCommit={(to) => run({ type: 'rename', kind: 'transition', from: id, to })} />
      <TextField label="Title" value={transition.title} testid="task-title" onCommit={(title) => update({ title })} />
      <Labelled label="May happen in">
        <div className="flex flex-col gap-1 text-xs">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={wildcard} onChange={(e) => update({ from: e.target.checked ? [ANY_STATE] : [document.initialState] })} />
            any state that has not ended
          </label>
          {!wildcard &&
            document.states.map((state) => (
              <label key={state.id} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={transition.from.includes(state.id)}
                  onChange={(e) => {
                    const next = e.target.checked ? [...transition.from, state.id] : transition.from.filter((s) => s !== state.id)
                    if (next.length > 0) update({ from: next })
                  }}
                />
                {state.title}
              </label>
            ))}
        </div>
      </Labelled>
      <Labelled label="Leads to">
        <select className={input} value={transition.to ?? ''} onChange={(e) => update({ to: e.target.value === '' ? undefined : e.target.value })}>
          <option value="">stays — a data update</option>
          {document.states.map((state) => (
            <option key={state.id} value={state.id}>
              {state.title}
            </option>
          ))}
        </select>
      </Labelled>
      <Labelled label="Done by (none: only the connector, on a timer or message)">
        <div className="flex flex-col gap-1 text-xs">
          {document.roles.map((role) => (
            <label key={role.id} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={transition.by.includes(role.id)}
                onChange={(e) => update({ by: e.target.checked ? [...transition.by, role.id] : transition.by.filter((r) => r !== role.id) })}
              />
              {role.title}
            </label>
          ))}
        </div>
      </Labelled>
      <label className="flex items-center gap-2 text-xs">
        <input type="checkbox" checked={transition.auto === true} onChange={(e) => update({ auto: e.target.checked ? true : undefined })} />
        happens automatically as soon as it can
      </label>
      <label className="flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={transition.attachments?.required === true}
          onChange={(e) => {
            const rest = { ...(transition.attachments ?? { required: false }) }
            const attachments = { ...rest, required: e.target.checked }
            const onlyFlag = Object.keys(attachments).length === 1
            update({ attachments: !e.target.checked && onlyFlag ? undefined : attachments })
          }}
        />
        requires a document
      </label>
      <Deadline document={document} id={id} run={run} />
      <h4 className="pt-2 text-xs font-semibold">Data in this step</h4>
      <TaskFieldsEditor document={document} transition={transition} run={run} />
      <AdvancedSection document={document} pointer={pointerOf(document, { kind: 'transition', id })} run={run} />
      {removeButton('Remove task', () => run({ type: 'remove', kind: 'transition', id }))}
    </>
  )
}

function Deadline({ document, id, run }: Props & { id: string }) {
  const transition = document.transitions.find((one) => one.id === id)
  if (transition === undefined || transition.to === undefined) return null
  const deadline = transition.deadline
  return (
    <div className="flex flex-col gap-1 rounded border border-slate-200 p-2 text-xs dark:border-slate-700">
      <span className="font-medium">Timer on {transition.to}</span>
      {deadline === undefined ? (
        <span className="text-slate-500">None. Add one from the palette.</span>
      ) : (
        <>
          <TextField
            label="Duration"
            value={deadline}
            onCommit={(next) => run({ type: 'setDeadline', transition: id, deadline: next, onDeadline: transition.onDeadline ?? id })}
          />
          <Labelled label="Then fires">
            <select
              className={input}
              value={transition.onDeadline ?? ''}
              onChange={(e) => run({ type: 'setDeadline', transition: id, deadline, onDeadline: e.target.value })}
            >
              {transition.onDeadline === undefined && <option value="">— choose —</option>}
              {document.transitions.map((one) => (
                <option key={one.id} value={one.id}>
                  {one.title}
                </option>
              ))}
            </select>
          </Labelled>
          <button type="button" className={ghost} onClick={() => run({ type: 'clearDeadline', transition: id })}>
            Remove timer
          </button>
        </>
      )}
    </div>
  )
}

export function LinkPanel({ document, index, run }: Props & { index: number }) {
  const link = (document.links ?? [])[index]
  if (link === undefined) return null
  return (
    <>
      <h3 className="font-semibold">Message</h3>
      <TextField
        label="Event in the linked instance"
        value={link.onEvent}
        placeholder="relation:STATE"
        onCommit={(onEvent) => run({ type: 'setFragment', pointer: `/links/${index}/onEvent`, value: onEvent })}
      />
      <Labelled label="Then fires">
        <select
          className={input}
          value={link.triggers}
          onChange={(e) => run({ type: 'setFragment', pointer: `/links/${index}/triggers`, value: e.target.value })}
        >
          {document.transitions.map((one) => (
            <option key={one.id} value={one.id}>
              {one.title}
            </option>
          ))}
        </select>
      </Labelled>
      <AdvancedSection document={document} pointer={pointerOf(document, { kind: 'link', index })} run={run} />
      {removeButton('Remove message', () => run({ type: 'removeLink', index }))}
    </>
  )
}
