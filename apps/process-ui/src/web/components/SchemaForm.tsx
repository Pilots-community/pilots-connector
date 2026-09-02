/**
 * A form rendered from a transition's `patch` JSON Schema.
 *
 * This is the component the milestone actually turns on: **a new definition
 * needs no UI work.** Nothing here knows what a container number or a gross mass
 * is. It walks the schema the definition supplies, renders an input per
 * property, and posts a JSON Merge Patch back. Adding a sixth process to the
 * repo changes no code in this app.
 *
 * It renders what it understands and says so when it does not. The alternative —
 * silently dropping a field it has no widget for — would make a transition
 * quietly incomplete, and the connector would refuse it with a schema error the
 * user could do nothing about. A raw JSON escape hatch is the honest fallback.
 */
import { useState } from 'react'

export interface JsonSchema {
  type?: string | string[]
  title?: string
  description?: string
  format?: string
  enum?: unknown[]
  properties?: Record<string, JsonSchema>
  required?: string[]
  items?: JsonSchema
  minimum?: number
  maximum?: number
  pattern?: string
  default?: unknown
}

const label = 'mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400'
const input =
  'w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100'

function titleFor(name: string, schema: JsonSchema): string {
  if (schema.title) return schema.title
  // `containerNumber` → `Container number`. Good enough, and it means a
  // definition author gets a readable form without writing titles.
  const spaced = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ')
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

function typeOf(schema: JsonSchema): string {
  if (Array.isArray(schema.type)) return schema.type.find((one) => one !== 'null') ?? 'string'
  return schema.type ?? (schema.properties ? 'object' : 'string')
}

function Field({
  name,
  schema,
  value,
  required,
  onChange,
  path,
}: {
  name: string
  schema: JsonSchema
  value: unknown
  required: boolean
  onChange: (next: unknown) => void
  path: string
}) {
  const type = typeOf(schema)
  const title = titleFor(name, schema)

  if (type === 'object' && schema.properties) {
    const current = (value ?? {}) as Record<string, unknown>
    return (
      <fieldset className="rounded-md border border-slate-200 p-3 dark:border-slate-700">
        <legend className="px-1 text-xs font-medium text-slate-600 dark:text-slate-400">
          {title}
        </legend>
        <div className="flex flex-col gap-3">
          {Object.entries(schema.properties).map(([child, childSchema]) => (
            <Field
              key={child}
              name={child}
              schema={childSchema}
              value={current[child]}
              required={(schema.required ?? []).includes(child)}
              path={`${path}.${child}`}
              onChange={(next) => {
                const updated = { ...current }
                // An absent key and an empty one are different things to a
                // merge patch: `null` deletes, so never send one by accident.
                if (next === undefined || next === '') delete updated[child]
                else updated[child] = next
                onChange(Object.keys(updated).length === 0 ? undefined : updated)
              }}
            />
          ))}
        </div>
      </fieldset>
    )
  }

  if (schema.enum) {
    return (
      <label className="block">
        <span className={label}>
          {title}
          {required && <span className="text-red-600"> *</span>}
        </span>
        <select
          className={input}
          data-field={path}
          value={(value as string) ?? ''}
          onChange={(event) => onChange(event.target.value === '' ? undefined : event.target.value)}
        >
          <option value="">—</option>
          {schema.enum.map((option) => (
            <option key={String(option)} value={String(option)}>
              {String(option)}
            </option>
          ))}
        </select>
      </label>
    )
  }

  if (type === 'boolean') {
    return (
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          data-field={path}
          checked={value === true}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span className="text-sm">{title}</span>
      </label>
    )
  }

  const inputType =
    type === 'number' || type === 'integer'
      ? 'number'
      : schema.format === 'date-time'
        ? 'datetime-local'
        : 'text'

  return (
    <label className="block">
      <span className={label}>
        {title}
        {required && <span className="text-red-600"> *</span>}
      </span>
      <input
        className={input}
        type={inputType}
        data-field={path}
        placeholder={schema.pattern ?? schema.description ?? ''}
        value={toInputValue(value, inputType)}
        onChange={(event) => onChange(fromInputValue(event.target.value, type, inputType))}
      />
      {schema.description && (
        <span className="mt-1 block text-xs text-slate-500">{schema.description}</span>
      )}
    </label>
  )
}

function toInputValue(value: unknown, inputType: string): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') {
    // `2026-08-24T09:19:00.000Z` → what the widget wants.
    return inputType === 'datetime-local' ? value.slice(0, 16) : value
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  // Anything else has no text widget. The JSON escape hatch is where it belongs,
  // and stringifying an object into a text box would silently corrupt it.
  return JSON.stringify(value)
}

function fromInputValue(raw: string, type: string, inputType: string): unknown {
  if (raw === '') return undefined
  if (type === 'number' || type === 'integer') {
    const parsed = Number(raw)
    return Number.isNaN(parsed) ? undefined : parsed
  }
  // Back to the protocol's timestamp format: UTC, milliseconds, always `Z`.
  if (inputType === 'datetime-local') return new Date(raw).toISOString()
  return raw
}

export function SchemaForm({
  schema,
  value,
  onChange,
}: {
  schema: JsonSchema | undefined
  value: Record<string, unknown>
  onChange: (next: Record<string, unknown>) => void
}) {
  const [raw, setRaw] = useState<string | null>(null)

  if (!schema || !schema.properties || Object.keys(schema.properties).length === 0) {
    return <p className="text-sm text-slate-500">This transition takes no data.</p>
  }

  if (raw !== null) {
    return (
      <div className="flex flex-col gap-2">
        <textarea
          className={`${input} h-40 font-mono`}
          value={raw}
          data-field="$raw"
          onChange={(event) => {
            setRaw(event.target.value)
            try {
              onChange(JSON.parse(event.target.value) as Record<string, unknown>)
            } catch {
              // Left for the user to finish typing. The connector validates the
              // result anyway, so a half-typed object is not a problem here.
            }
          }}
        />
        <button
          type="button"
          className="self-start text-xs text-slate-500 underline"
          onClick={() => setRaw(null)}
        >
          back to the form
        </button>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {Object.entries(schema.properties).map(([name, property]) => (
        <Field
          key={name}
          name={name}
          schema={property}
          value={value[name]}
          required={(schema.required ?? []).includes(name)}
          path={name}
          onChange={(next) => {
            const updated = { ...value }
            if (next === undefined) delete updated[name]
            else updated[name] = next
            onChange(updated)
          }}
        />
      ))}
      <button
        type="button"
        className="self-start text-xs text-slate-500 underline"
        onClick={() => setRaw(JSON.stringify(value, null, 2))}
      >
        edit as JSON
      </button>
    </div>
  )
}
