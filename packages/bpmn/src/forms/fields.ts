/**
 * The field builder — the `data` schema, as a business user edits it.
 *
 * Six kinds of field and nothing else. Anything richer is classified `null`:
 * the form shows it read-only, marked *edited in JSON*, and every write here
 * replaces only the one field it names, so what the form cannot express is
 * never dropped on the way through.
 */
export type FieldType = 'text' | 'number' | 'datetime' | 'choice' | 'boolean' | 'group'

export interface FieldView {
  name: string
  required: boolean
  /** `null` when the form cannot show this field faithfully. */
  type: FieldType | null
  options: string[]
  fields: FieldView[]
}

export interface FieldEdit {
  type: FieldType
  options?: string[]
  required: boolean
}

export type FieldResult = { ok: true; schema: Record<string, unknown> } | { ok: false; message: string }

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
export const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((one) => typeof one === 'string')

const ALLOWED: Record<FieldType, readonly string[]> = {
  text: ['type'],
  number: ['type'],
  datetime: ['type', 'format'],
  choice: ['type', 'enum'],
  boolean: ['type'],
  group: ['type', 'properties', 'required'],
}

export function classify(schema: unknown): FieldType | null {
  if (!isRecord(schema)) return null
  const fits = (type: FieldType): boolean => Object.keys(schema).every((key) => ALLOWED[type].includes(key))
  switch (schema['type']) {
    case 'string':
      if (schema['format'] === 'date-time') return fits('datetime') ? 'datetime' : null
      if (schema['enum'] !== undefined) return isStrings(schema['enum']) && fits('choice') ? 'choice' : null
      return fits('text') ? 'text' : null
    case 'number':
      return fits('number') ? 'number' : null
    case 'boolean':
      return fits('boolean') ? 'boolean' : null
    case 'object':
      return fits('group') &&
        (schema['properties'] === undefined || isRecord(schema['properties'])) &&
        (schema['required'] === undefined || isStrings(schema['required']))
        ? 'group'
        : null
    default:
      return null
  }
}

export function readFields(schema: unknown): FieldView[] {
  if (!isRecord(schema) || !isRecord(schema['properties'])) return []
  const required = isStrings(schema['required']) ? schema['required'] : []
  return Object.entries(schema['properties']).map(([name, child]) => {
    const type = classify(child)
    return {
      name,
      required: required.includes(name),
      type,
      options: type === 'choice' && isRecord(child) && isStrings(child['enum']) ? child['enum'] : [],
      fields: type === 'group' ? readFields(child) : [],
    }
  })
}

export function schemaFor(type: FieldType, options: string[] = []): Record<string, unknown> {
  switch (type) {
    case 'text':
      return { type: 'string' }
    case 'number':
      return { type: 'number' }
    case 'datetime':
      return { type: 'string', format: 'date-time' }
    case 'choice':
      return { type: 'string', enum: [...options] }
    case 'boolean':
      return { type: 'boolean' }
    case 'group':
      return { type: 'object', properties: {} }
  }
}

/** Set one field at `path` — group names, then the field's own. The root is never replaced. */
export function setField(root: unknown, path: string[], edit: FieldEdit): FieldResult {
  const next = structuredClone(isRecord(root) ? root : { type: 'object' })
  const name = path[path.length - 1]
  if (name === undefined || name.trim() === '') return { ok: false, message: 'a field needs a name' }
  const parent = groupAt(next, path.slice(0, -1))
  if (parent === null) return { ok: false, message: `there is no group at ${path.slice(0, -1).join('.')}` }
  if (!isRecord(parent['properties'])) parent['properties'] = {}
  const properties = parent['properties'] as Record<string, unknown>

  const existing = properties[name]
  if (existing !== undefined && classify(existing) === null) {
    return { ok: false, message: `${path.join('.')} uses JSON Schema this form cannot show; change it in the JSON tab` }
  }
  const keepGroup = edit.type === 'group' && classify(existing) === 'group'
  properties[name] = keepGroup ? existing : schemaFor(edit.type, edit.options)
  setRequired(parent, name, edit.required)
  return { ok: true, schema: next }
}

export function removeField(root: unknown, path: string[]): FieldResult {
  const next = structuredClone(isRecord(root) ? root : { type: 'object' })
  const name = path[path.length - 1]
  const parent = groupAt(next, path.slice(0, -1))
  if (name === undefined || parent === null || !isRecord(parent['properties'])) {
    return { ok: false, message: `there is no field at ${path.join('.')}` }
  }
  delete parent['properties'][name]
  setRequired(parent, name, false)
  return { ok: true, schema: next }
}

function groupAt(root: Record<string, unknown>, path: string[]): Record<string, unknown> | null {
  let current = root
  for (const name of path) {
    const properties = current['properties']
    const child = isRecord(properties) ? properties[name] : undefined
    if (!isRecord(child) || classify(child) !== 'group') return null
    current = child
  }
  return current
}

function setRequired(parent: Record<string, unknown>, name: string, required: boolean): void {
  const list = isStrings(parent['required']) ? parent['required'] : []
  const has = list.includes(name)
  if (required && !has) parent['required'] = [...list, name]
  if (!required && has) {
    const left = list.filter((one) => one !== name)
    if (left.length === 0) delete parent['required']
    else parent['required'] = left
  }
}
