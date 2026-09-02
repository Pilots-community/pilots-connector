/**
 * The signed log, with what verification made of it.
 *
 * **A broken chain is loud and red, and it does not offer a way out.** There is
 * no "retry", no "resync", no "refresh to fix". A failure at `prev` or at the
 * `from` state means the host rewrote history; the honest thing a UI can do is
 * say so, name the event, and stop. Offering a button that appeared to repair it
 * would be the single most dishonest thing in the product.
 *
 * `unresolved` is amber, never green. It means the signatures could not be
 * checked because a participant's DID document could not be fetched — which in
 * this demo is the normal case, since every DID is on the reserved `.example`
 * TLD. Showing a tick for a check that did not run would defeat the point of
 * running it.
 */
import type { SignedEvent, VerificationReport } from '../api.js'

const badge = 'rounded px-1.5 py-0.5 text-xs font-medium'

export function VerificationBanner({ report }: { report: VerificationReport }) {
  if (report.status === 'broken') {
    const failure = report.failures[0]
    return (
      <div
        data-testid="chain-broken"
        className="rounded-md border-2 border-red-500 bg-red-50 p-4 dark:bg-red-950/40"
      >
        <p className="text-sm font-semibold text-red-800 dark:text-red-300">
          This history has been rewritten.
        </p>
        <p className="mt-1 text-sm text-red-700 dark:text-red-400">
          Verification failed at event {failure?.seq}: {failure?.detail}
        </p>
        <p className="mt-2 text-xs text-red-700 dark:text-red-400">
          This is not a transient error and reloading will not change it. The signed chain no longer
          matches what the host is serving. Do not act on this process.
        </p>
      </div>
    )
  }

  if (report.status === 'unresolved') {
    return (
      <div
        data-testid="chain-unresolved"
        className="rounded-md border border-amber-400 bg-amber-50 p-3 dark:bg-amber-950/30"
      >
        <p className="text-sm font-medium text-amber-800 dark:text-amber-300">
          Chain intact; signatures not checked.
        </p>
        <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
          The published key could not be fetched for {report.unresolved.join(', ')}, so the
          signatures were not verified. The links between events check out — this is not a green
          tick, and it should not be read as one.
        </p>
      </div>
    )
  }

  return (
    <div
      data-testid="chain-verified"
      className="rounded-md border border-emerald-400 bg-emerald-50 p-3 dark:bg-emerald-950/30"
    >
      <p className="text-sm font-medium text-emerald-800 dark:text-emerald-300">
        Verified: {report.events.length} event{report.events.length === 1 ? '' : 's'}, every
        signature and every link.
      </p>
      <p className="mt-1 text-xs text-emerald-700 dark:text-emerald-400">
        Checked here, against each participant’s published key — not taken from the connector’s word
        for it.
      </p>
    </div>
  )
}

function EventStatus({ ok }: { ok: boolean | null }) {
  if (ok === false) {
    return (
      <span className={`${badge} bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300`}>
        failed
      </span>
    )
  }
  if (ok === null) {
    return (
      <span
        className={`${badge} bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300`}
      >
        unchecked
      </span>
    )
  }
  return (
    <span
      className={`${badge} bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300`}
    >
      verified
    </span>
  )
}

export function EventLog({
  events,
  report,
}: {
  events: SignedEvent[]
  report: VerificationReport
}) {
  const status = new Map(report.events.map((one) => [one.seq, one.ok]))

  return (
    <ol className="flex flex-col gap-2">
      {events.map((event) => (
        <li
          key={event.header.seq}
          data-testid={`event-${event.header.seq}`}
          className="rounded-md border border-slate-200 p-3 dark:border-slate-700"
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs text-slate-500">#{event.header.seq}</span>
            <span className="text-sm font-medium">{event.header.transition}</span>
            {event.header.to && (
              <span className="text-xs text-slate-500">
                {event.header.from ?? '—'} → {event.header.to}
              </span>
            )}
            <EventStatus ok={status.get(event.header.seq) ?? null} />
            {event.redacted && (
              <span
                className={`${badge} bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300`}
                title="Fields were withheld from you by the definition’s visibility rules. The chain still verifies."
              >
                redacted
              </span>
            )}
          </div>

          <p className="mt-1 text-xs text-slate-500">
            {new Date(event.header.at).toLocaleString()} · {event.header.actor}
          </p>

          {/*
            A runtime-fired transition names what justified it. `by: []` means no
            participant could have invoked it by hand, so without this it would be
            the one move a host could invent unchallenged.
          */}
          {event.header.cause && (
            <p className="mt-1 font-mono text-xs text-slate-500" title="The event that caused this">
              caused by {event.header.cause.slice(0, 23)}…
            </p>
          )}

          {event.payload && Object.keys(event.payload).length > 0 && (
            <pre className="mt-2 overflow-x-auto rounded bg-slate-100 p-2 text-xs dark:bg-slate-800">
              {JSON.stringify(event.payload, null, 2)}
            </pre>
          )}

          {event.header.attachments.length > 0 && (
            <ul className="mt-2 flex flex-col gap-1">
              {event.header.attachments.map((ref) => (
                <li key={ref.sha256} className="text-xs">
                  <a
                    className="text-sky-700 underline dark:text-sky-400"
                    href={`/api/ui/attachments/${encodeURIComponent(ref.sha256)}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {ref.mime} · {ref.size} bytes
                  </a>
                  <span className="ml-2 font-mono text-slate-400">{ref.sha256.slice(0, 23)}…</span>
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ol>
  )
}
