/** Per task: which fields this step fills in, and which must already be present. */
import { readFields, readTaskFields, writeTaskFields, type Command, type DefinitionDocument, type TransitionDocument } from '@pilots/bpmn'
import { useState } from 'react'

export function TaskFieldsEditor({
  document,
  transition,
  run,
}: {
  document: DefinitionDocument
  transition: TransitionDocument
  run: (c: Command) => void
}) {
  const [refused, setRefused] = useState(false)
  const view = readTaskFields(transition)
  if (view.advanced) {
    return (
      <p className="text-xs text-amber-800 dark:text-amber-300">
        This step’s data rules use JSON Schema the form cannot show. Change them in the Advanced (JSON) section.
      </p>
    )
  }
  const names = [...new Set([...readFields(document.data).map((f) => f.name), ...view.fills.map((f) => f.name)])]
  const update = (fills: typeof view.fills, requires: string[]): void => {
    const patch = writeTaskFields(transition, document.data, { fills, requires })
    setRefused(patch === null)
    if (patch !== null) run({ type: 'updateTransition', id: transition.id, patch })
  }
  return (
    <>
      {refused && (
        <p data-testid="task-fields-refused" className="text-xs text-rose-700 dark:text-rose-400">
          The form cannot make that change to this step. Use the Advanced (JSON) section.
        </p>
      )}
      <table className="w-full text-xs" data-testid="task-fields">
        <thead>
          <tr className="text-left text-slate-500">
            <th>Field</th>
            <th>fills in</th>
            <th>required</th>
            <th>must be present</th>
          </tr>
        </thead>
        <tbody>
          {names.map((name) => {
            const fill = view.fills.find((f) => f.name === name)
            const others = view.fills.filter((f) => f.name !== name)
            return (
              <tr key={name}>
                <td className="font-mono">{name}</td>
                <td>
                  <input
                    type="checkbox"
                    checked={fill !== undefined}
                    onChange={(e) => update(e.target.checked ? [...view.fills, { name, required: false }] : others, view.requires)}
                  />
                </td>
                <td>
                  <input
                    type="checkbox"
                    disabled={fill === undefined}
                    checked={fill?.required ?? false}
                    onChange={(e) => update(view.fills.map((f) => (f.name === name ? { name, required: e.target.checked } : f)), view.requires)}
                  />
                </td>
                <td>
                  <input
                    type="checkbox"
                    checked={view.requires.includes(name)}
                    onChange={(e) =>
                      update(view.fills, e.target.checked ? [...view.requires, name] : view.requires.filter((r) => r !== name))
                    }
                  />
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </>
  )
}
