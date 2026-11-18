/**
 * The shell: who is signed in, which tab is showing, and keeping it all current.
 *
 * Everything a participant *does* lives in `views/`. What stays here is the
 * session gate, the header that says which organisation this screen belongs to,
 * and the one place that decides when server state is revalidated.
 *
 * It holds no key, knows no peer, and speaks only to its own BFF — stop this
 * container and the connector will not notice.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import { api } from './api.js'
import { browserFocusTarget } from './live/browser-target.js'
import { focusFeed, mergeFeeds, pollingFeed } from './live/change-feed.js'
import { useLiveSync } from './live/useLiveSync.js'
import { queries } from './queries.js'
import { button, ghost } from './ui.js'
import { ProcessDetail } from './views/ProcessDetail.js'
import { Authoring } from './views/Authoring.js'
import { Processes } from './views/Processes.js'
import { SignIn } from './views/SignIn.js'
import { Start } from './views/Start.js'

// ── the shell ───────────────────────────────────────────────────────────────

export function App() {
  const client = useQueryClient()
  const [selected, setSelected] = useState<string | null>(null)
  const [tab, setTab] = useState<'processes' | 'start' | 'authoring'>('processes')

  /*
   * Why the two feeds are built once, outside render.
   *
   * `useLiveSync` subscribes in an effect keyed on the feed. A feed rebuilt on
   * every render would tear the subscription down and stand it up again each
   * time, so the interval would never actually reach five seconds.
   */
  const feed = useMemo(() => mergeFeeds(pollingFeed(5_000), focusFeed(browserFocusTarget())), [])
  useLiveSync(feed)

  const session = useQuery(queries.session())
  const user = session.data?.user ?? null
  const participant = session.data?.participant ?? 'Process UI'
  // Our own DID, shown rather than merely used. Two of these UIs sit side by
  // side in a demo, and "which organisation am I looking at" must never be a
  // question anybody has to answer by checking the port number.
  const did = session.data?.did ?? null

  const instanceList = useQuery({ ...queries.instances(), enabled: Boolean(user) })
  const instances = instanceList.data ?? []

  // The browser tab too: two tabs called "Pilots" is exactly the ambiguity this
  // is meant to remove.
  useEffect(() => {
    if (session.data) document.title = `${session.data.participant} — Pilots`
  }, [session.data])

  const refresh = useCallback(() => {
    void client.invalidateQueries()
  }, [client])

  /*
   * `isPending` rather than "no data": a failed session call must reach the
   * sign-in screen, not leave a blank page that never resolves. react-query
   * settles into an error state, and an error here means "not signed in as far
   * as this screen is concerned".
   */
  if (session.isPending) return null
  if (!user) return <SignIn participant={participant} did={did} onDone={refresh} />

  return (
    // Authoring takes the whole window: a process with a few lanes does not fit a reading column.
    <div
      className={`mx-auto flex flex-col gap-4 p-6 ${tab === 'authoring' && !selected ? 'max-w-none' : 'max-w-4xl'}`}
    >
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold" data-testid="participant">
            {participant}
          </h1>
          <p className="text-xs text-slate-500">
            {/*
              The label is configuration; the DID is the identity. Showing both
              keeps the demo honest about which is which — rename an
              organisation and its DID does not move.
            */}
            <span data-testid="did">{did ?? 'connector not reachable'}</span> · signed in as{' '}
            {user.email}
          </p>
        </div>
        <button type="button" className={ghost} onClick={() => void api.signOut().then(refresh)}>
          Sign out
        </button>
      </header>

      {selected ? (
        <ProcessDetail
          id={selected}
          onBack={() => {
            setSelected(null)
            refresh()
          }}
        />
      ) : (
        <>
          <nav className="flex gap-2">
            <button
              type="button"
              className={tab === 'processes' ? button : ghost}
              onClick={() => setTab('processes')}
            >
              Processes
            </button>
            <button
              type="button"
              className={tab === 'start' ? button : ghost}
              data-testid="tab-start"
              onClick={() => setTab('start')}
            >
              Start something
            </button>
            <button
              type="button"
              className={tab === 'authoring' ? button : ghost}
              data-testid="tab-authoring"
              onClick={() => setTab('authoring')}
            >
              Write a process
            </button>
          </nav>

          {tab === 'authoring' ? (
            <Authoring />
          ) : tab === 'start' ? (
            <Start
              onStarted={(id) => {
                setSelected(id)
                setTab('processes')
              }}
            />
          ) : (
            <Processes instances={instances} onOpen={setSelected} />
          )}
        </>
      )}
    </div>
  )
}
