import type { InstanceView } from '../api.js'

export interface GroupedInstances {
  /** Something is waiting on you. */
  yours: InstanceView[]
  /** Running, but it is the other party's move. */
  waiting: InstanceView[]
  /** Over, however it ended. */
  done: InstanceView[]
  /** Quotations, listed apart from the services they authorise. */
  quotations: InstanceView[]
}

/**
 * Sort a flat list into the four headings a person actually scans for.
 *
 * Both questions are answered by the connector: `available` for "is it my
 * turn", `outcome` for "is it over". The UI does not recompute either — that is
 * what keeps a new definition from needing UI work, and what stops the screen
 * from disagreeing with the permission check.
 *
 * Order matters. **Finished wins over your-turn**, so a stale `available` can
 * never resurrect a closed process into a row that invites somebody to act.
 */
export function groupInstances(instances: readonly InstanceView[]): GroupedInstances {
  const recentFirst = [...instances].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  const grouped: GroupedInstances = { yours: [], waiting: [], done: [], quotations: [] }

  for (const one of recentFirst) {
    if (one.kind === 'quotation') grouped.quotations.push(one)
    else if (one.outcome !== 'running') grouped.done.push(one)
    else if (one.available.length > 0) grouped.yours.push(one)
    else grouped.waiting.push(one)
  }
  return grouped
}
