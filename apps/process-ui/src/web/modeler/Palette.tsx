/**
 * The palette is the restriction (B5): seven things, and none of the BPMN
 * elements a definition cannot express — no parallel gateway, because an
 * instance is in one state at a time; no subprocess, loop or data object.
 * Gateways are not here either: they are derived.
 */
import { freshId, type Command, type DefinitionDocument } from '@pilots/bpmn'

import { ghost } from '../ui.js'
import type { Pending } from './NewElement.js'

export function Palette({
  document,
  run,
  onAsk,
}: {
  document: DefinitionDocument
  run: (command: Command) => void
  onAsk: (pending: Pending) => void
}) {
  const roles = document.roles.map((one) => one.id)
  const states = document.states.map((one) => one.id)
  const item = (label: string, testid: string, act: () => void) => (
    <button key={testid} type="button" className={ghost} data-testid={testid} onClick={act}>
      {label}
    </button>
  )
  return (
    <div className="flex flex-wrap gap-2" data-testid="palette">
      {item('+ Lane', 'palette-lane', () =>
        run({ type: 'addRole', role: { id: freshId('role', roles), title: 'New role' } }),
      )}
      {item('+ State', 'palette-state', () =>
        run({ type: 'addState', state: { id: freshId('STATE', states), title: 'New state' } }),
      )}
      {item('+ End ✓', 'palette-end-fulfilled', () =>
        run({ type: 'addState', state: { id: freshId('DONE', states), title: 'Done', outcome: 'fulfilled' } }),
      )}
      {item('+ End ✕', 'palette-end-abandoned', () =>
        run({ type: 'addState', state: { id: freshId('STOPPED', states), title: 'Stopped', outcome: 'abandoned' } }),
      )}
      {item('+ Task', 'palette-task', () => onAsk({ kind: 'task' }))}
      {item('+ Timer', 'palette-timer', () => onAsk({ kind: 'timer' }))}
      {item('+ Message', 'palette-message', () => onAsk({ kind: 'message' }))}
    </div>
  )
}
