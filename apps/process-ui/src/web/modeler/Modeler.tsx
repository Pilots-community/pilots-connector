/**
 * The Diagram tab: palette, canvas, properties, and the one place a refused
 * command is explained — with "remove with dependents" offered when that is
 * what the refusal was about (B6).
 */
import {
  applyCommand,
  withLayout,
  type Command,
  type DiagramModel,
  type ElementRef,
} from '@pilots/bpmn'
import { useEffect, useMemo, useState } from 'react'

import type { DefinitionDiagnostic } from '../api.js'
import { ghost } from '../ui.js'
import { Canvas } from './Canvas.js'
import type { DraftAction, DraftState } from './draft.js'
import { refOfKey } from './flow.js'
import { NewElement, type Pending } from './NewElement.js'
import { Palette } from './Palette.js'
import { Properties } from './Properties.js'

export function Modeler({
  draft,
  dispatch,
  model,
  flagged,
  diagnostics,
}: {
  draft: DraftState
  dispatch: (action: DraftAction) => void
  /** Projected by the caller, which projects only a document `isDrawable` accepts. */
  model: DiagramModel
  flagged: ReadonlySet<string>
  diagnostics: readonly DefinitionDiagnostic[]
}) {
  const layout = useMemo(() => withLayout(model, draft.layout), [model, draft.layout])
  // The element, not its node key: a rename changes the key, and must not drop the selection.
  const [selected, setSelected] = useState<ElementRef | null>(null)
  // Each request is its own form: the counter is the key, so a second arrow
  // never inherits what was typed for the first.
  const [pending, setPendingState] = useState<{ request: Pending; id: number } | null>(null)
  const [requests, setRequests] = useState(0)
  const setPending = (request: Pending): void => {
    setPendingState({ request, id: requests })
    setRequests(requests + 1)
  }
  const run = (command: Command): void => {
    if (
      command.type === 'rename' &&
      !draft.readOnly &&
      selected !== null &&
      selected.kind === command.kind &&
      selected.id === command.from &&
      applyCommand(draft.document, command).ok
    ) {
      setSelected({ kind: command.kind, id: command.to })
    }
    dispatch({ type: 'command', command })
  }
  const failure = draft.failure

  // Full screen lays the modeler over the whole window; Escape is the way out.
  const [fullScreen, setFullScreen] = useState(false)
  useEffect(() => {
    if (!fullScreen) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setFullScreen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [fullScreen])

  return (
    <div
      className={
        fullScreen
          ? 'fixed inset-0 z-50 flex flex-col gap-3 bg-white p-4 dark:bg-slate-950'
          : 'flex flex-col gap-3'
      }
      data-testid="modeler"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        {draft.readOnly ? (
          <span />
        ) : (
          <Palette document={draft.document} run={run} onAsk={setPending} />
        )}
        <button
          type="button"
          className={ghost}
          data-testid="modeler-fullscreen"
          onClick={() => setFullScreen(!fullScreen)}
        >
          {fullScreen ? 'Exit full screen (Esc)' : 'Full screen'}
        </button>
      </div>
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
        <div
          data-testid="command-problem"
          className="rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-xs text-rose-900 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-300"
        >
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

      <div
        className={`grid gap-3 lg:grid-cols-[1fr_24rem] ${fullScreen ? 'min-h-0 flex-1 lg:grid-rows-[minmax(0,1fr)]' : ''}`}
      >
        <Canvas
          fill={fullScreen}
          model={model}
          layout={layout}
          flagged={flagged}
          readOnly={draft.readOnly}
          onMove={(key, x, y) => dispatch({ type: 'move', key, x, y })}
          onMoveTask={(change) => run({ type: 'moveTask', ...change })}
          onConnectStates={(from, to) => setPending({ kind: 'task', from, to })}
          onSelect={(key) => setSelected(key === null ? null : refOfKey(model, key))}
        />
        <div className={fullScreen ? 'min-h-0 overflow-y-auto' : ''}>
          <Properties
            document={draft.document}
            selected={selected}
            diagnostics={diagnostics}
            readOnly={draft.readOnly}
            run={run}
          />
        </div>
      </div>
    </div>
  )
}
