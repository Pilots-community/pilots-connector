/**
 * What the drawing cannot show: ids, titles, the data schema, what each step
 * fills in, who may read what. Driven by the selection; nothing selected is the
 * process itself. A read-only definition shows everything and accepts nothing.
 */
import type { Command, DefinitionDocument, DiagramModel } from '@pilots/bpmn'

import { refOfKey } from './flow.js'
import { LinkPanel, RolePanel, StatePanel, TaskPanel } from './properties/ElementPanels.js'
import { ProcessPanel } from './properties/ProcessPanel.js'

export function Properties({
  document,
  model,
  selected,
  readOnly,
  run,
}: {
  document: DefinitionDocument
  model: DiagramModel
  selected: string | null
  readOnly: boolean
  run: (command: Command) => void
}) {
  const ref = selected === null ? null : refOfKey(model, selected)
  return (
    <aside data-testid="properties" className="rounded-lg border border-slate-200 p-3 text-sm dark:border-slate-700">
      <fieldset disabled={readOnly} className="flex flex-col gap-3">
        {ref === null && <ProcessPanel document={document} run={run} />}
        {ref?.kind === 'role' && <RolePanel key={`role:${ref.id}`} document={document} id={ref.id} run={run} />}
        {ref?.kind === 'state' && <StatePanel key={`state:${ref.id}`} document={document} id={ref.id} run={run} />}
        {ref?.kind === 'transition' && <TaskPanel key={`transition:${ref.id}`} document={document} id={ref.id} run={run} />}
        {ref?.kind === 'link' && <LinkPanel key={`link:${ref.index}`} document={document} index={ref.index} run={run} />}
      </fieldset>
    </aside>
  )
}
