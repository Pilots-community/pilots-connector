/**
 * The list of processes this participant takes part in.
 *
 * Grouped by the question a person actually arrives with — *is anything waiting
 * on me?* — rather than by when things happened. Both the grouping and the
 * "your turn" badge come from what the connector computed; see `grouping.ts`.
 */
import { useQuery } from '@tanstack/react-query'

import type { InstanceView } from '../api.js'
import { queries } from '../queries.js'
import { Card } from '../ui.js'
import { groupInstances } from './grouping.js'

/** `2026-08-24T09:00:00Z` → `2 hours ago`. Good enough, and no dependency. */
function ago(iso: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

function Row({
  instance,
  title,
  counterparty,
  onOpen,
}: {
  instance: InstanceView
  title: string
  counterparty: string | null
  onOpen: (id: string) => void
}) {
  const yourTurn = instance.outcome === 'running' && instance.available.length > 0
  return (
    <li>
      <button
        type="button"
        data-testid="instance-row"
        data-instance={instance.id}
        data-outcome={instance.outcome}
        className="flex w-full items-center justify-between gap-3 rounded-md border border-slate-200 p-3 text-left hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800"
        onClick={() => onOpen(instance.id)}
      >
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium">{title}</span>
          <span className="block truncate text-xs text-slate-500">
            {counterparty ? `with ${counterparty} · ` : ''}
            {ago(instance.updatedAt, Date.now())}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {yourTurn && (
            <span className="rounded bg-sky-100 px-1.5 py-0.5 text-xs font-medium text-sky-800 dark:bg-sky-900/40 dark:text-sky-300">
              your turn
            </span>
          )}
          {instance.outcome === 'fulfilled' && (
            <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-xs font-medium text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300">
              completed
            </span>
          )}
          {instance.outcome === 'abandoned' && (
            <span className="rounded bg-slate-200 px-1.5 py-0.5 text-xs font-medium text-slate-700 dark:bg-slate-700 dark:text-slate-300">
              stopped
            </span>
          )}
          <span className="text-right text-sm" data-testid="row-state">
            {instance.state}
          </span>
        </span>
      </button>
    </li>
  )
}

export function Processes({
  instances,
  onOpen,
}: {
  instances: readonly InstanceView[]
  onOpen: (id: string) => void
}) {
  // Titles and counterparty names are lookups, not new endpoints: both lists
  // are already loaded for the start form, and they change rarely.
  const definitions = useQuery(queries.definitions())
  const connections = useQuery(queries.connections())
  const session = useQuery(queries.session())

  const titleOf = (instance: InstanceView): string =>
    definitions.data?.find((one) => one.ref === instance.definition)?.title ?? instance.definition

  const nameOf = (did: string): string =>
    connections.data?.find((one) => one.peerDid === did)?.peerDisplayName ?? did

  /** Who else is in this process, by display name where we know one. */
  const counterpartyOf = (instance: InstanceView): string | null => {
    const dids = Object.values(instance.participants).flat()
    const others = [...new Set(dids)].filter((did) => did !== session.data?.did)
    return others.length === 0 ? null : others.map(nameOf).join(', ')
  }

  const grouped = groupInstances(instances)
  const sections: Array<[string, InstanceView[]]> = [
    ['Your turn', grouped.yours],
    ['Waiting on them', grouped.waiting],
    ['Quotations', grouped.quotations],
    ['Done', grouped.done],
  ]

  if (instances.length === 0) {
    return (
      <Card title="Processes">
        <p className="text-sm text-slate-500">
          Nothing running yet. Start one from an offering, or from a definition, under{' '}
          <em>Start something</em>.
        </p>
      </Card>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      {sections
        .filter(([, rows]) => rows.length > 0)
        .map(([heading, rows]) => (
          <Card key={heading} title={`${heading} (${rows.length})`}>
            <ul className="flex flex-col gap-2">
              {rows.map((one) => (
                <Row
                  key={one.id}
                  instance={one}
                  title={titleOf(one)}
                  counterparty={counterpartyOf(one)}
                  onOpen={onOpen}
                />
              ))}
            </ul>
          </Card>
        ))}
    </div>
  )
}
