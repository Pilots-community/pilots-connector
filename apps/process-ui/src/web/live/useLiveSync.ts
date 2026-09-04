import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'

import { keys } from '../queries.js'
import type { ChangeFeed } from './change-feed.js'

/**
 * Revalidate the screens that can change underneath you.
 *
 * Deliberately not a bare `invalidateQueries()`: that would also refetch the
 * session and every definition on every tick, which changes nothing and costs
 * a request each time.
 *
 * The instance and event keys are invalidated by prefix, so whichever instance
 * happens to be open is covered without this hook knowing which one it is.
 * react-query only refetches what is actually mounted, so the cost is one
 * request for the list plus at most two for an open detail view.
 */
export function useLiveSync(feed: ChangeFeed): void {
  const client = useQueryClient()

  useEffect(
    () =>
      feed.subscribe(() => {
        void client.invalidateQueries({ queryKey: keys.instances })
        void client.invalidateQueries({ queryKey: ['instance'] })
        void client.invalidateQueries({ queryKey: ['events'] })
      }),
    [client, feed],
  )
}
