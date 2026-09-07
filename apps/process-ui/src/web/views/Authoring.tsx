/**
 * Writing a process definition.
 *
 * The document is the authority and the diagram is a projection of it — not the
 * other way round. That ordering is deliberate: a canvas editor arrives later
 * and will mutate this same document, so anything the canvas cannot express
 * (data schemas, patches, guards, visibility rules) stays expressible here
 * rather than being lost on a round trip.
 *
 * Validation comes from the connector, not from a copy of the rules in the
 * browser. The linter is the spec; a second implementation here would drift,
 * and the one that mattered would be whichever was more permissive.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import { UiError, api, type DefinitionDiagnostic } from '../api.js'
import { StateDiagram } from '../graph/StateDiagram.js'
import { keys, queries } from '../queries.js'
import { Card, Problem, button, ghost, input } from '../ui.js'

/** A skeleton that lints clean, so the first thing on screen is a working process. */
const STARTER = {
  '@context': 'https://pilots.example/process/v1',
  id: 'my-process',
  version: '1.0.0',
  kind: 'service',
  title: 'My process',
  roles: [
    { id: 'requester', title: 'Requester', cardinality: 1, protocolRole: 'requester' },
    { id: 'provider', title: 'Provider', cardinality: 1, protocolRole: 'provider' },
  ],
  hostedBy: 'provider',
  initialState: 'REQUESTED',
  states: [
    { id: 'REQUESTED', title: 'Requested' },
    { id: 'ACCEPTED', title: 'Accepted' },
    { id: 'COMPLETED', title: 'Completed', outcome: 'fulfilled' },
    { id: 'CANCELLED', title: 'Cancelled', outcome: 'abandoned' },
  ],
  defaultVisibility: 'all',
  data: {
    type: 'object',
    required: ['reference'],
    properties: { reference: { type: 'string' } },
  },
  transitions: [
    {
      id: 'accept',
      title: 'Accept the request',
      from: ['REQUESTED'],
      to: 'ACCEPTED',
      by: ['provider'],
    },
    {
      id: 'complete',
      title: 'Mark it done',
      from: ['ACCEPTED'],
      to: 'COMPLETED',
      by: ['provider'],
    },
    {
      id: 'cancel',
      title: 'Cancel',
      from: ['*'],
      to: 'CANCELLED',
      by: ['requester', 'provider'],
    },
  ],
  visibility: [],
  links: [],
}

/** What the definition schema needs to draw a diagram, once it parses. */
interface Drawable {
  id: string
  version: string
  kind: 'quotation' | 'service'
  title: string
  roles: Array<{ id: string; title: string }>
  hostedBy: string
  initialState: string
  states: Array<{ id: string; title: string; outcome?: 'fulfilled' | 'abandoned' }>
  data: Record<string, unknown>
  transitions: Array<{
    id: string
    title: string
    from: string[]
    to?: string
    by: string[]
  }>
}

export function Authoring() {
  const [source, setSource] = useState(() => JSON.stringify(STARTER, null, 2))
  const [diagnostics, setDiagnostics] = useState<DefinitionDiagnostic[]>([])
  const [checking, setChecking] = useState(false)
  const [published, setPublished] = useState<string | null>(null)
  const [error, setError] = useState<UiError | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const client = useQueryClient()

  const definitions = useQuery(queries.definitions()).data ?? []

  /** Parsed locally only to draw it. The connector decides whether it is valid. */
  const parsed = useMemo<{ value: Drawable | null; syntax: string | null }>(() => {
    try {
      return { value: JSON.parse(source) as Drawable, syntax: null }
    } catch (cause) {
      return { value: null, syntax: (cause as Error).message }
    }
  }, [source])

  /*
   * Lint on a debounce, so typing is not a request per keystroke, and the
   * result that lands is always the one for the text on screen — a stale answer
   * overwriting a fresh one is the classic bug here.
   */
  useEffect(() => {
    if (parsed.value === null) {
      setDiagnostics([])
      return
    }
    let current = true
    const timer = setTimeout(() => {
      setChecking(true)
      void api
        .lintDefinition(parsed.value as unknown as Record<string, unknown>)
        .then((result) => {
          if (current) setDiagnostics(result.diagnostics)
        })
        .catch(() => {
          if (current) setDiagnostics([])
        })
        .finally(() => {
          if (current) setChecking(false)
        })
    }, 300)

    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [parsed.value, source])

  const errors = diagnostics.filter((one) => one.severity === 'error')
  const warnings = diagnostics.filter((one) => one.severity === 'warning')
  const publishable = parsed.value !== null && parsed.syntax === null && errors.length === 0

  const publish = (): void => {
    if (parsed.value === null) return
    setError(null)
    setPublished(null)
    void api
      .publishDefinition(parsed.value as unknown as Record<string, unknown>)
      .then(async (result) => {
        setPublished(result.ref)
        // The Start screen should offer it immediately; that is the whole point.
        await client.invalidateQueries({ queryKey: keys.definitions })
      })
      .catch((cause: unknown) => {
        if (cause instanceof UiError) setError(cause)
      })
  }

  const importFile = (file: File): void => {
    void file.text().then((text) => {
      try {
        setSource(JSON.stringify(JSON.parse(text), null, 2))
      } catch {
        // Show it as typed and let the linter and the parser explain.
        setSource(text)
      }
      setPublished(null)
    })
  }

  const download = (): void => {
    const blob = new Blob([source], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${parsed.value?.id ?? 'definition'}.json`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="flex flex-col gap-4">
      <Card title="Write a process">
        <div className="flex flex-col gap-3">
          <p className="text-xs text-slate-600 dark:text-slate-400">
            The connector validates this as you type — the same linter it applies to a definition a
            peer sends. Publishing makes it usable immediately, and a definition never changes once
            published: to alter one, bump its <code>version</code>.
          </p>

          <div className="grid gap-3 lg:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-slate-600">
                Definition (JSON)
              </span>
              <textarea
                className={`${input} h-96 font-mono text-xs`}
                data-testid="definition-source"
                spellCheck={false}
                value={source}
                onChange={(event) => {
                  setSource(event.target.value)
                  setPublished(null)
                }}
              />
            </label>

            <div className="flex flex-col gap-2">
              <span className="text-xs font-medium text-slate-600">The process it describes</span>
              {parsed.value === null ? (
                <div className="flex h-96 items-center justify-center rounded-md border border-dashed border-slate-300 p-4 text-center text-xs text-slate-500 dark:border-slate-700">
                  Not valid JSON yet — the diagram appears as soon as it parses.
                </div>
              ) : (
                <StateDiagram definition={parsed.value} height="h-96" />
              )}
            </div>
          </div>

          <div data-testid="diagnostics" className="flex flex-col gap-2">
            {parsed.syntax !== null && (
              <p className="rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-xs text-rose-900 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-300">
                {parsed.syntax}
              </p>
            )}

            {parsed.syntax === null && diagnostics.length === 0 && !checking && (
              <p className="text-xs text-emerald-700 dark:text-emerald-400">
                No problems. This process can be started and can be completed.
              </p>
            )}

            {/* Errors first: they are what stops a publish. */}
            {[...errors, ...warnings].map((diagnostic, index) => (
              <p
                key={`${diagnostic.code}-${diagnostic.path ?? index}`}
                className={
                  diagnostic.severity === 'error'
                    ? 'rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-xs text-rose-900 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-300'
                    : 'rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300'
                }
              >
                <span className="font-mono">{diagnostic.code}</span> — {diagnostic.message}
                {diagnostic.path !== undefined && (
                  <span className="ml-1 font-mono text-slate-500">{diagnostic.path}</span>
                )}
              </p>
            ))}
          </div>

          {error && <Problem error={error} />}
          {published !== null && (
            <p
              data-testid="published"
              className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-xs text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300"
            >
              Published <span className="font-mono">{published}</span>. It is ready to start, and a
              peer will be asked to adopt it the first time you run it with them.
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            <button
              className={button}
              type="button"
              data-testid="publish"
              disabled={!publishable}
              onClick={publish}
            >
              Publish
            </button>
            <button className={ghost} type="button" onClick={() => fileInput.current?.click()}>
              Import a file
            </button>
            <button className={ghost} type="button" onClick={download}>
              Download
            </button>
            <input
              ref={fileInput}
              type="file"
              accept="application/json,.json"
              className="hidden"
              data-testid="import"
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (file) importFile(file)
              }}
            />
          </div>
        </div>
      </Card>

      <Card title="Processes this connector holds">
        <ul className="flex flex-col gap-1 text-xs">
          {definitions.map((one) => (
            <li key={one.ref} className="flex flex-wrap items-baseline gap-2">
              <span className="font-mono">{one.ref}</span>
              <span className="text-slate-600 dark:text-slate-400">{one.title}</span>
              {!one.startableStandalone && (
                <span className="text-amber-700 dark:text-amber-400">
                  started by a {one.requiresRelations.join(' or ')}
                </span>
              )}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  )
}
