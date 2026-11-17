/**
 * What the drawing cannot show: ids, titles, the data schema, what each step
 * fills in, who may read what. Driven by the selection; nothing selected is the
 * process itself. A read-only definition shows everything and accepts nothing —
 * but its tabs still switch, or half of what it shows could not be reached.
 */
import type { Command, DefinitionDocument, ElementRef } from '@pilots/bpmn'

import type { DefinitionDiagnostic } from '../api.js'
import { diagnosticsOf } from './flow.js'
import { LinkPanel, RolePanel, StatePanel, TaskPanel } from './properties/ElementPanels.js'
import { ProcessPanel } from './properties/ProcessPanel.js'

export function Properties({
  document,
  selected: ref,
  diagnostics,
  readOnly,
  run,
}: {
  document: DefinitionDocument
  selected: ElementRef | null
  diagnostics: readonly DefinitionDiagnostic[]
  readOnly: boolean
  run: (command: Command) => void
}) {
  const about = ref === null ? [] : diagnosticsOf(document, ref, diagnostics)
  return (
    <aside data-testid="properties" className="flex flex-col gap-3 rounded-lg border border-slate-200 p-3 text-sm dark:border-slate-700">
      {about.length > 0 && (
        <ul data-testid="selected-diagnostics" className="flex flex-col gap-1 text-xs">
          {about.map((one, index) => (
            <li
              key={`${one.code}-${index}`}
              className={one.severity === 'error' ? 'text-rose-700 dark:text-rose-400' : 'text-amber-700 dark:text-amber-400'}
            >
              <span className="font-mono">{one.code}</span> — {one.message}
            </li>
          ))}
        </ul>
      )}
      {ref === null && <ProcessPanel document={document} readOnly={readOnly} run={run} />}
      {ref !== null && (
        <fieldset disabled={readOnly} className="flex flex-col gap-3">
          {ref.kind === 'role' && <RolePanel key={`role:${ref.id}`} document={document} id={ref.id} run={run} />}
          {ref.kind === 'state' && <StatePanel key={`state:${ref.id}`} document={document} id={ref.id} run={run} />}
          {ref.kind === 'transition' && <TaskPanel key={`transition:${ref.id}`} document={document} id={ref.id} run={run} />}
          {ref.kind === 'link' && <LinkPanel key={`link:${ref.index}`} document={document} index={ref.index} run={run} />}
        </fieldset>
      )}
    </aside>
  )
}
