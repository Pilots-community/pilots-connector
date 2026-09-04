/**
 * The handful of visual primitives every view shares.
 *
 * Deliberately not a component library. Four class strings and two components
 * is the whole of it, and pulling them out of `App.tsx` is what let that file
 * become a shell rather than the app.
 */
import type { ReactNode } from 'react'

import type { UiError } from './api.js'

export const button =
  'rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-slate-700 disabled:opacity-40 dark:bg-slate-100 dark:text-slate-900'
export const ghost =
  'rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800'
export const input =
  'w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-800'

export function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900">
      <header className="border-b border-slate-200 px-4 py-3 dark:border-slate-700">
        <h2 className="text-sm font-semibold">{title}</h2>
      </header>
      <div className="p-4">{children}</div>
    </section>
  )
}

/**
 * A refusal, shown as the connector described it.
 *
 * The two branches are the two a caller must act on differently: a conflict
 * needs a fresh decision, an unreachable peer needs the same request again.
 * Collapsing them into "something went wrong" is what makes a demo unexplainable.
 */
export function Problem({ error }: { error: UiError }) {
  return (
    <div
      data-testid="problem"
      className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300"
    >
      <p className="font-medium">{error.problem.title ?? 'Refused'}</p>
      <p className="mt-1">{error.message}</p>
      {error.isConflict && (
        <p className="mt-1 text-xs">
          Somebody else advanced this while you were looking at it — it is now at seq{' '}
          {error.problem.seq}. Reload and decide again; this is not something to retry blindly.
        </p>
      )}
      {error.isRetryable && (
        <p className="mt-1 text-xs">
          The other party’s connector did not answer. Nothing happened, so the same action is safe
          to try again.
        </p>
      )}
    </div>
  )
}
