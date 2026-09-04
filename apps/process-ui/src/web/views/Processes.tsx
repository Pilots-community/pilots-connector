/**
 * The list of processes this participant takes part in.
 *
 * "Your turn" comes from `available`, which the connector computed from the
 * definition. The UI does not get a second opinion about whose turn it is; it
 * only decides where to put the row.
 */
import type { InstanceView } from '../api.js'
import { Card } from '../ui.js'

export function Processes({
  instances,
  onOpen,
}: {
  instances: readonly InstanceView[]
  onOpen: (id: string) => void
}) {
  return (
    <Card title="Processes">
      {instances.length === 0 ? (
        <p className="text-sm text-slate-500">Nothing running yet.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {instances.map((one) => (
            <li key={one.id}>
              <button
                type="button"
                data-testid="instance-row"
                data-instance={one.id}
                className="flex w-full items-center justify-between rounded-md border border-slate-200 p-3 text-left hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800"
                onClick={() => onOpen(one.id)}
              >
                <span>
                  <span className="block text-sm font-medium">{one.definition}</span>
                  <span className="block font-mono text-xs text-slate-500">{one.id}</span>
                </span>
                <span className="flex items-center gap-2">
                  {one.available.length > 0 && (
                    <span className="rounded bg-sky-100 px-1.5 py-0.5 text-xs font-medium text-sky-800 dark:bg-sky-900/40 dark:text-sky-300">
                      your turn
                    </span>
                  )}
                  <span className="text-sm">{one.state}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
