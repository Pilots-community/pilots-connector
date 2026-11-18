/**
 * The escape hatch: the selected element's raw JSON. Whatever the forms cannot
 * express is changed here, and judged by the linter like anything else.
 */
import { getPointer, type Command, type DefinitionDocument } from '@pilots/bpmn'
import { useEffect, useState } from 'react'

import { ghost, input } from '../../ui.js'

export function Advanced({ document, pointer, run }: { document: DefinitionDocument; pointer: string; run: (c: Command) => void }) {
  const current = JSON.stringify(getPointer(document, pointer), null, 2)
  const [text, setText] = useState(current)
  const [problem, setProblem] = useState<string | null>(null)
  useEffect(() => setText(current), [current])
  return (
    <div className="flex flex-col gap-1">
      <textarea
        className={`${input} h-48 font-mono text-[11px]`}
        data-testid="advanced-json"
        spellCheck={false}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      {problem !== null && <p className="text-xs text-rose-700 dark:text-rose-400">{problem}</p>}
      <button
        type="button"
        className={ghost}
        data-testid="advanced-apply"
        onClick={() => {
          try {
            run({ type: 'setFragment', pointer, value: JSON.parse(text) })
            setProblem(null)
          } catch (cause) {
            setProblem((cause as Error).message)
          }
        }}
      >
        Apply JSON
      </button>
    </div>
  )
}
