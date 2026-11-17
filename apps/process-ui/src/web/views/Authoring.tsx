/**
 * Writing a process definition.
 *
 * The document is the authority and the diagram is a projection of it — not the
 * other way round. The canvas has arrived: the Diagram tab edits this same
 * document through commands (`@pilots/bpmn`), and the JSON tab remains for
 * anything the canvas cannot express (data schemas, patches, guards, visibility
 * rules), so nothing is lost on a round trip.
 *
 * Validation comes from the connector, not from a copy of the rules in the
 * browser. The linter is the spec; a second implementation here would drift,
 * and the one that mattered would be whichever was more permissive.
 */
import { applyCommand, bumpVersion, targetOf, toDiagram, type DefinitionDocument } from '@pilots/bpmn'
import { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import { UiError, api, type DefinitionDiagnostic } from '../api.js'
import { StateDiagram } from '../graph/StateDiagram.js'
import { draftReducer, initialDraft } from '../modeler/draft.js'
import { Modeler } from '../modeler/Modeler.js'
import { browserStorage, loadDraft, loadLayout, saveDraft, saveLayout } from '../modeler/storage.js'
import { keys, queries } from '../queries.js'
import { Card, Problem, button, ghost, input } from '../ui.js'

/** A skeleton that lints clean, so the first thing on screen is a working process. */
const STARTER: DefinitionDocument = {
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

/** One identity for "nothing yet", so an unsettled render does not rebuild `flagged`. */
const NO_DIAGNOSTICS: DefinitionDiagnostic[] = []

/** An empty canvas. Not a valid process yet — a draft may be incomplete; only publishing is blocked. */
const BLANK: DefinitionDocument = {
  '@context': 'https://pilots.example/process/v1',
  id: 'new-process',
  version: '1.0.0',
  kind: 'service',
  title: 'New process',
  roles: [],
  hostedBy: '',
  initialState: '',
  states: [],
  defaultVisibility: 'all',
  data: { type: 'object' },
  transitions: [],
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
  const storage = useMemo(() => browserStorage(), [])
  const [draft, dispatch] = useReducer(draftReducer, undefined, () =>
    initialDraft(loadDraft(storage) ?? { document: STARTER, layout: {} }),
  )
  const [tab, setTab] = useState<'diagram' | 'json'>('diagram')
  const [source, setSource] = useState(() => JSON.stringify(draft.document, null, 2))
  const [syntax, setSyntax] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const [lintFailed, setLintFailed] = useState(false)
  const [published, setPublished] = useState<string | null>(null)
  const [error, setError] = useState<UiError | null>(null)
  const [conflict, setConflict] = useState<string | null>(null)
  const [opening, setOpening] = useState('')
  const [unreachable, setUnreachable] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const client = useQueryClient()

  const definitions = useQuery(queries.definitions()).data ?? []

  // The text follows the document — except when the text is what changed it,
  // or the cursor would jump on every keystroke.
  useEffect(() => {
    if (draft.origin === 'json') return
    setSource(JSON.stringify(draft.document, null, 2))
    setSyntax(null)
    // Keyed on the revision alone: it is what changes exactly once per edit.
  }, [draft.revision])

  // A banner about a publish must not outlive the draft it was about. The
  // publish itself sets `published` only when it answers, after this has run.
  useEffect(() => {
    setPublished(null)
    setConflict(null)
  }, [draft.revision])

  useEffect(() => {
    if (storage !== null) saveDraft(storage, { document: draft.document, layout: draft.layout })
  }, [storage, draft.document, draft.layout])

  /*
   * Lint on a debounce, tagged with the revision it was asked about. The
   * reducer drops an answer for any other revision, so a slow linter cannot
   * paint old errors over a newer drawing.
   */
  useEffect(() => {
    const revision = draft.revision
    const timer = setTimeout(() => {
      setChecking(true)
      void api
        .lintDefinition(draft.document as unknown as Record<string, unknown>)
        .then((result) => {
          dispatch({ type: 'linted', revision, diagnostics: result.diagnostics })
          setLintFailed(false)
        })
        .catch(() => setLintFailed(true))
        .finally(() => setChecking(false))
    }, 300)
    return () => clearTimeout(timer)
  }, [draft.revision, draft.document])

  const settled = draft.diagnostics.revision === draft.revision
  const diagnostics = settled ? draft.diagnostics.items : NO_DIAGNOSTICS
  const errors = diagnostics.filter((one) => one.severity === 'error')
  const warnings = diagnostics.filter((one) => one.severity === 'warning')
  const publishable = !draft.readOnly && syntax === null && settled && !lintFailed && errors.length === 0

  const model = useMemo(() => toDiagram(draft.document), [draft.document])
  const flagged = useMemo(
    () =>
      new Set(
        diagnostics.flatMap((one) => {
          const target = targetOf(draft.document, model, one.path)
          return target.kind === 'process' ? [] : [target.key]
        }),
      ),
    [diagnostics, draft.document, model],
  )

  const publish = (document: DefinitionDocument = draft.document): void => {
    setError(null)
    setUnreachable(false)
    setPublished(null)
    setConflict(null)
    void api
      .publishDefinition(document as unknown as Record<string, unknown>)
      .then(async (result) => {
        setPublished(result.ref)
        if (storage !== null) saveLayout(storage, result.ref, draft.layout)
        await client.invalidateQueries({ queryKey: keys.definitions })
      })
      .catch((cause: unknown) => {
        if (!(cause instanceof UiError)) {
          setUnreachable(true)
          return
        }
        // Same id@version, different bytes: a published definition never changes,
        // so the answer is the next version, offered in one click.
        if (cause.problem.type?.endsWith('definition-conflict') === true) {
          setConflict(bumpVersion(document.version))
          return
        }
        setError(cause)
      })
  }

  const publishAsNext = (): void => {
    if (conflict === null) return
    const command = { type: 'setProcess' as const, patch: { version: conflict } }
    const bumped = applyCommand(draft.document, command)
    if (!bumped.ok) return
    dispatch({ type: 'command', command })
    publish(bumped.document)
  }

  const open = (ref: string): void => {
    setUnreachable(false)
    void api
      .definition(ref)
      .then((result) => {
        dispatch({
          type: 'replace',
          document: result.definition as unknown as DefinitionDocument,
          origin: 'open',
          readOnly: true,
          layout: storage === null ? {} : loadLayout(storage, ref),
        })
        setPublished(null)
        setConflict(null)
      })
      .catch(() => setUnreachable(true))
  }

  const typed = (text: string): void => {
    setSource(text)
    setPublished(null)
    try {
      const value: unknown = JSON.parse(text)
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        setSyntax('A definition is a JSON object.')
        return
      }
      setSyntax(null)
      dispatch({ type: 'replace', document: value as DefinitionDocument, origin: 'json' })
    } catch (cause) {
      setSyntax((cause as Error).message)
    }
  }

  const importFile = (file: File): void => {
    void file.text().then((text) => {
      setTab('json')
      typed(text)
    })
  }

  const download = (): void => {
    const blob = new Blob([JSON.stringify(draft.document, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${draft.document.id || 'definition'}.json`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  const parsed = syntax === null ? (draft.document as unknown as Drawable) : null
  const tabClass = (one: 'diagram' | 'json'): string =>
    one === tab ? 'border-b-2 border-slate-900 pb-1 font-semibold dark:border-slate-100' : 'pb-1 text-slate-500'

  return (
    <div className="flex flex-col gap-4">
      <Card title="Write a process">
        <div className="flex flex-col gap-3">
          <p className="text-xs text-slate-600 dark:text-slate-400">
            Draw it or write it — both tabs edit the same definition. The connector validates it as you go, with the
            same linter it applies to a definition a peer sends. A published definition never changes: to alter
            one, start a new version.
          </p>

          <div className="flex flex-wrap items-end gap-2">
            <select className={`${input} w-auto`} data-testid="open-ref" value={opening} onChange={(e) => setOpening(e.target.value)}>
              <option value="">Open a published process…</option>
              {definitions.map((one) => (
                <option key={one.ref} value={one.ref}>
                  {one.ref}
                </option>
              ))}
            </select>
            <button type="button" className={ghost} data-testid="open-definition" disabled={opening === ''} onClick={() => open(opening)}>
              Open
            </button>
            <button
              type="button"
              className={ghost}
              data-testid="new-process"
              onClick={() => dispatch({ type: 'replace', document: BLANK, origin: 'open', layout: {} })}
            >
              New process
            </button>
            <button type="button" className={ghost} data-testid="undo" disabled={draft.past.length === 0} onClick={() => dispatch({ type: 'undo' })}>
              Undo
            </button>
            <button type="button" className={ghost} data-testid="redo" disabled={draft.future.length === 0} onClick={() => dispatch({ type: 'redo' })}>
              Redo
            </button>
          </div>

          {draft.readOnly && (
            <p data-testid="read-only" className="flex items-center gap-2 rounded-md border border-sky-300 bg-sky-50 px-3 py-2 text-xs text-sky-900 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-300">
              {draft.document.id}@{draft.document.version} is published and read-only.
              <button type="button" className={ghost} data-testid="new-version" onClick={() => dispatch({ type: 'newVersion' })}>
                New version
              </button>
            </p>
          )}
          {storage === null && (
            <p data-testid="storage-warning" className="text-xs text-amber-700 dark:text-amber-400">
              This browser will not keep the draft: it is lost on reload.
            </p>
          )}
          {lintFailed && (
            <p data-testid="lint-unavailable" className="text-xs text-amber-700 dark:text-amber-400">
              Cannot validate — the connector did not answer. Publishing waits until it does.
            </p>
          )}

          <div className="flex gap-4 text-sm">
            <button type="button" data-testid="authoring-tab-diagram" className={tabClass('diagram')} onClick={() => setTab('diagram')}>
              Diagram
            </button>
            <button type="button" data-testid="authoring-tab-json" className={tabClass('json')} onClick={() => setTab('json')}>
              JSON
            </button>
          </div>

          {tab === 'diagram' ? (
            <Modeler draft={draft} dispatch={dispatch} flagged={flagged} />
          ) : (
            <div className="grid gap-3 lg:grid-cols-2">
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-slate-600">Definition (JSON)</span>
                <textarea
                  className={`${input} h-96 font-mono text-xs`}
                  data-testid="definition-source"
                  spellCheck={false}
                  readOnly={draft.readOnly}
                  value={source}
                  onChange={(event) => typed(event.target.value)}
                />
              </label>
              <div className="flex flex-col gap-2">
                <span className="text-xs font-medium text-slate-600">The process it describes</span>
                {parsed === null ? (
                  <div className="flex h-96 items-center justify-center rounded-md border border-dashed border-slate-300 p-4 text-center text-xs text-slate-500 dark:border-slate-700">
                    Not valid JSON yet — the diagram appears as soon as it parses.
                  </div>
                ) : (
                  <StateDiagram definition={parsed} height="h-96" />
                )}
              </div>
            </div>
          )}

          <div data-testid="diagnostics" className="flex flex-col gap-2">
            {syntax !== null && (
              <p className="rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-xs text-rose-900 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-300">
                {syntax}
              </p>
            )}
            {syntax === null && settled && diagnostics.length === 0 && !checking && (
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
                {diagnostic.path !== undefined && <span className="ml-1 font-mono text-slate-500">{diagnostic.path}</span>}
              </p>
            ))}
          </div>

          {error && <Problem error={error} />}
          {unreachable && (
            <p
              data-testid="unreachable"
              className="rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-xs text-rose-900 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-300"
            >
              Could not reach the connector. Try again.
            </p>
          )}
          {conflict !== null && (
            <p className="flex items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
              {draft.document.id}@{draft.document.version} is already published with different content.
              <button type="button" className={ghost} data-testid="publish-next" onClick={publishAsNext}>
                Publish as {conflict}
              </button>
            </p>
          )}
          {published !== null && (
            <p
              data-testid="published"
              className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-xs text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300"
            >
              Published <span className="font-mono">{published}</span>. It is ready to start, and a peer will be asked
              to adopt it the first time you run it with them.
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            <button className={button} type="button" data-testid="publish" disabled={!publishable} onClick={() => publish()}>
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
