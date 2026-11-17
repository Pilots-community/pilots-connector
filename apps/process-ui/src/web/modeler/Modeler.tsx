/**
 * The Diagram tab: palette, canvas, properties, and the one place a refused
 * command is explained — with "remove with dependents" offered when that is
 * what the refusal was about (B6).
 */
import { toDiagram, withLayout, type Command } from '@pilots/bpmn'
import { useMemo, useState } from 'react'

import { ghost } from '../ui.js'
import { Canvas } from './Canvas.js'
import type { DraftAction, DraftState } from './draft.js'
import { NewElement, type Pending } from './NewElement.js'
import { Palette } from './Palette.js'
import { Properties } from './Properties.js'

export function Modeler({
  draft,
  dispatch,
  flagged,
}: {
  draft: DraftState
  dispatch: (action: DraftAction) => void
  flagged: ReadonlySet<string>
}) {
  const model = useMemo(() => toDiagram(draft.document), [draft.document])
  const layout = useMemo(() => withLayout(model, draft.layout), [model, draft.layout])
  const [selected, setSelected] = useState<string | null>(null)
  // Each request is its own form: the counter is the key, so a second arrow
  // never inherits what was typed for the first.
  const [pending, setPendingState] = useState<{ request: Pending; id: number } | null>(null)
  const [requests, setRequests] = useState(0)
  const setPending = (request: Pending): void => {
    setPendingState({ request, id: requests })
    setRequests(requests + 1)
  }
  const run = (command: Command): void => dispatch({ type: 'command', command })
  const failure = draft.failure

  return (
    <div className="flex flex-col gap-3" data-testid="modeler">
      {!draft.readOnly && <Palette document={draft.document} run={run} onAsk={setPending} />}
      {pending !== null && !draft.readOnly && (
        <NewElement
          key={pending.id}
          pending={pending.request}
          document={draft.document}
          run={run}
          onClose={() => setPendingState(null)}
        />
      )}

      {failure !== null && (
        <div data-testid="command-problem" className="rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-xs text-rose-900 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-300">
          <p>{failure.error.message}</p>
          {failure.error.dependents !== undefined && (
            <ul className="ml-4 list-disc">
              {failure.error.dependents.map((one) => (
                <li key={one}>{one}</li>
              ))}
            </ul>
          )}
          <div className="mt-2 flex gap-2">
            {failure.error.code === 'has-dependents' && failure.command.type === 'remove' && (
              <button
                type="button"
                className={ghost}
                data-testid="remove-with-dependents"
                onClick={() => {
                  if (failure.command.type === 'remove') run({ ...failure.command, cascade: true })
                }}
              >
                Remove with dependents
              </button>
            )}
            <button type="button" className={ghost} onClick={() => dispatch({ type: 'dismiss' })}>
              Dismiss
            </button>
          </div>
        </div>
      )}

      <div className="grid gap-3 lg:grid-cols-[1fr_22rem]">
        <Canvas
          model={model}
          layout={layout}
          flagged={flagged}
          readOnly={draft.readOnly}
          onMove={(key, x, y) => dispatch({ type: 'move', key, x, y })}
          onMoveTask={(change) => run({ type: 'moveTask', ...change })}
          onConnectStates={(from, to) => setPending({ kind: 'task', from, to })}
          onSelect={setSelected}
        />
        <Properties document={draft.document} model={model} selected={selected} readOnly={draft.readOnly} run={run} />
      </div>
    </div>
  )
}
