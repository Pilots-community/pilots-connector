/**
 * What the other party will do for you.
 *
 * This is the natural way into starting something: you pick a service somebody
 * offers, rather than a definition ref and a role map. Publishing an offering
 * is what makes a participant a supplier — a runtime record, never a build flag
 * — which is why this list is fetched and not configured.
 */
import { useQuery } from '@tanstack/react-query'

import type { Offering } from '../api.js'
import { queries } from '../queries.js'
import { Card, button } from '../ui.js'

export function Offerings({ onStart }: { onStart: (offering: Offering) => void }) {
  const offerings = useQuery(queries.offerings())
  const rows = offerings.data ?? []

  return (
    <Card title="Offerings">
      {rows.length === 0 ? (
        <p className="text-sm text-slate-500">
          Nothing published here. Publishing an offering is what makes a participant a supplier — it
          is done in the connector’s admin UI, and it is a runtime record rather than a setting.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((offering) => (
            <li
              key={offering.id}
              data-testid="offering"
              className="flex items-center justify-between gap-3 rounded-md border border-slate-200 p-3 dark:border-slate-700"
            >
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">{offering.title}</span>
                <span className="block truncate text-xs text-slate-500">
                  {offering.price ? `${offering.price.value} ${offering.price.currency} · ` : ''}
                  {/*
                    The quotation, because that is what a consumer instantiates
                    first. Naming the service definition here was misleading: it
                    is the thing the quotation *authorises*, and it cannot be
                    started on its own.
                  */}
                  {offering.quotationDefinition} → {offering.serviceDefinition}
                </span>
              </span>
              <button
                type="button"
                className={button}
                data-testid="start-offering"
                onClick={() => onStart(offering)}
              >
                Start one
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
