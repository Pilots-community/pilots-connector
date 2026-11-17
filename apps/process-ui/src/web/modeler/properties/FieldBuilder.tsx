/**
 * The `data` schema as a list of fields. A field the form cannot show is listed
 * with an *edited in JSON* badge and no controls: it is kept, never rewritten.
 */
import {
  readFields,
  removeField,
  setField,
  type Command,
  type DefinitionDocument,
  type FieldResult,
  type FieldType,
  type FieldView,
} from '@pilots/bpmn'
import { useState } from 'react'

import { ghost, input } from '../../ui.js'
import { ListField } from '../fields.js'

const TYPES: FieldType[] = ['text', 'number', 'datetime', 'choice', 'boolean', 'group']

export function FieldBuilder({ document, run }: { document: DefinitionDocument; run: (c: Command) => void }) {
  const [problem, setProblem] = useState<string | null>(null)
  const write = (result: FieldResult): void => {
    if (!result.ok) {
      setProblem(result.message)
      return
    }
    setProblem(null)
    run({ type: 'setProcess', patch: { data: result.schema as DefinitionDocument['data'] } })
  }
  return (
    <div className="flex flex-col gap-2" data-testid="field-builder">
      <Fields fields={readFields(document.data)} path={[]} data={document.data} write={write} />
      {problem !== null && <p className="text-xs text-rose-700 dark:text-rose-400">{problem}</p>}
    </div>
  )
}

function Fields({
  fields,
  path,
  data,
  write,
}: {
  fields: FieldView[]
  path: string[]
  data: unknown
  write: (result: FieldResult) => void
}) {
  const [name, setName] = useState('')
  const [type, setType] = useState<FieldType>('text')
  return (
    <div className={path.length > 0 ? 'ml-3 border-l border-slate-200 pl-2 dark:border-slate-700' : ''}>
      {fields.map((field) => {
        const at = [...path, field.name]
        const fieldType = field.type
        return (
          <div key={field.name} className="flex flex-col gap-1 py-1">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="font-mono">{field.name}</span>
              {fieldType === null ? (
                <span className="rounded bg-amber-100 px-1 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200">
                  edited in JSON
                </span>
              ) : (
                <>
                  <select
                    className="rounded border border-slate-300 bg-transparent px-1 dark:border-slate-600"
                    value={fieldType}
                    onChange={(e) => write(setField(data, at, { type: e.target.value as FieldType, required: field.required, options: field.options }))}
                  >
                    {TYPES.map((one) => (
                      <option key={one} value={one}>
                        {one}
                      </option>
                    ))}
                  </select>
                  <label className="flex items-center gap-1">
                    <input
                      type="checkbox"
                      checked={field.required}
                      onChange={(e) => write(setField(data, at, { type: fieldType, required: e.target.checked, options: field.options }))}
                    />
                    required
                  </label>
                  {fieldType === 'choice' && (
                    <ListField
                      className="rounded border border-slate-300 bg-transparent px-1 dark:border-slate-600"
                      value={field.options}
                      placeholder="option, option"
                      onCommit={(options) => write(setField(data, at, { type: 'choice', required: field.required, options }))}
                    />
                  )}
                </>
              )}
              <button type="button" className="text-rose-700 dark:text-rose-400" onClick={() => write(removeField(data, at))}>
                remove
              </button>
            </div>
            {field.type === 'group' && <Fields fields={field.fields} path={at} data={data} write={write} />}
          </div>
        )
      })}
      <div className="flex gap-2 pt-1">
        <input className={input} placeholder="new field" value={name} data-testid="field-new-name" onChange={(e) => setName(e.target.value)} />
        <select className={input} value={type} onChange={(e) => setType(e.target.value as FieldType)}>
          {TYPES.map((one) => (
            <option key={one} value={one}>
              {one}
            </option>
          ))}
        </select>
        <button
          type="button"
          className={ghost}
          data-testid="field-add"
          onClick={() => {
            const result = setField(data, [...path, name.trim()], { type, required: false })
            write(result)
            if (result.ok) setName('')
          }}
        >
          Add
        </button>
      </div>
    </div>
  )
}
