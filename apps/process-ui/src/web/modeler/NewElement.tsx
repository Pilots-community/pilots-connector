/**
 * The three additions that need more than one value: a task (lane, from, to),
 * a timer (which transition arms it, how long, what it fires) and a message
 * (which linked event, what it fires).
 */
import { ANY_STATE, identifierFrom, type Command, type DefinitionDocument } from '@pilots/bpmn'
import { useState } from 'react'

import { input } from '../ui.js'
import { Labelled, Panel } from './fields.js'

export type Pending = { kind: 'task'; from?: string; to?: string } | { kind: 'timer' } | { kind: 'message' }

interface Props {
  document: DefinitionDocument
  run: (command: Command) => void
  onClose: () => void
}

export function NewElement({ pending, ...props }: Props & { pending: Pending }) {
  switch (pending.kind) {
    case 'task':
      return <NewTask {...props} from={pending.from} to={pending.to} />
    case 'timer':
      return <NewTimer {...props} />
    case 'message':
      return <NewMessage {...props} />
  }
}

function NewTask({ document, run, onClose, from, to }: Props & { from?: string; to?: string }) {
  const [title, setTitle] = useState('')
  const [role, setRole] = useState(document.roles[0]?.id ?? '')
  const [source, setSource] = useState(from ?? document.initialState)
  const [target, setTarget] = useState(to ?? '')
  const submit = (): void => {
    const id = identifierFrom(title, document.transitions.map((one) => one.id))
    run({
      type: 'addTransition',
      transition: {
        id,
        title: title.trim() === '' ? id : title.trim(),
        from: [source],
        ...(target === '' ? {} : { to: target }),
        by: [role],
      },
    })
    onClose()
  }
  return (
    <Panel title="New task" onClose={onClose} onSubmit={submit} submitLabel="Add task">
      <Labelled label="Title">
        <input className={input} data-testid="new-task-title" value={title} onChange={(e) => setTitle(e.target.value)} />
      </Labelled>
      <Labelled label="Lane">
        <select className={input} data-testid="new-task-lane" value={role} onChange={(e) => setRole(e.target.value)}>
          {document.roles.map((one) => (
            <option key={one.id} value={one.id}>
              {one.title}
            </option>
          ))}
        </select>
      </Labelled>
      <Labelled label="From">
        <select className={input} data-testid="new-task-from" value={source} onChange={(e) => setSource(e.target.value)}>
          <option value={ANY_STATE}>any state</option>
          {document.states.map((one) => (
            <option key={one.id} value={one.id}>
              {one.title} ({one.id})
            </option>
          ))}
        </select>
      </Labelled>
      <Labelled label="To">
        <select className={input} data-testid="new-task-to" value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value="">stays — a data update</option>
          {document.states.map((one) => (
            <option key={one.id} value={one.id}>
              {one.title} ({one.id})
            </option>
          ))}
        </select>
      </Labelled>
    </Panel>
  )
}

function NewTimer({ document, run, onClose }: Props) {
  const arming = document.transitions.filter((one) => one.to !== undefined)
  const [transition, setTransition] = useState(arming[0]?.id ?? '')
  const [duration, setDuration] = useState('PT24H')
  const [target, setTarget] = useState(document.transitions[0]?.id ?? '')
  const submit = (): void => {
    run({ type: 'setDeadline', transition, deadline: duration.trim(), onDeadline: target })
    onClose()
  }
  return (
    <Panel title="New timer" onClose={onClose} onSubmit={submit} submitLabel="Add timer">
      <Labelled label="Starts when this task completes">
        <select className={input} data-testid="new-timer-arming" value={transition} onChange={(e) => setTransition(e.target.value)}>
          {arming.map((one) => (
            <option key={one.id} value={one.id}>
              {one.title} → {one.to}
            </option>
          ))}
        </select>
      </Labelled>
      <Labelled label="Duration (P#D, PT#H or PT#M)">
        <input className={input} data-testid="new-timer-duration" value={duration} onChange={(e) => setDuration(e.target.value)} />
      </Labelled>
      <Labelled label="Then fires">
        <select className={input} data-testid="new-timer-target" value={target} onChange={(e) => setTarget(e.target.value)}>
          {document.transitions.map((one) => (
            <option key={one.id} value={one.id}>
              {one.title}
            </option>
          ))}
        </select>
      </Labelled>
    </Panel>
  )
}

function NewMessage({ document, run, onClose }: Props) {
  const [onEvent, setOnEvent] = useState('')
  const [target, setTarget] = useState(document.transitions[0]?.id ?? '')
  const submit = (): void => {
    run({ type: 'addLink', link: { onEvent: onEvent.trim(), triggers: target } })
    onClose()
  }
  return (
    <Panel title="New message" onClose={onClose} onSubmit={submit} submitLabel="Add message">
      <Labelled label="Event in the linked instance">
        <input
          className={input}
          data-testid="new-message-event"
          placeholder="relation:STATE"
          value={onEvent}
          onChange={(e) => setOnEvent(e.target.value)}
        />
      </Labelled>
      <Labelled label="Then fires">
        <select className={input} data-testid="new-message-target" value={target} onChange={(e) => setTarget(e.target.value)}>
          {document.transitions.map((one) => (
            <option key={one.id} value={one.id}>
              {one.title}
            </option>
          ))}
        </select>
      </Labelled>
    </Panel>
  )
}
