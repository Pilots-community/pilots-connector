/**
 * Per task, two lists: what this step fills in (`patch`) and what must already
 * be present (`guards`). That is all the form shows; a patch or a guard it
 * cannot express makes the task *advanced*, edited in JSON.
 */
import type { TransitionDocument } from '../document.js'
import { isRecord, isStrings } from './fields.js'

export interface TaskFields {
  fills: { name: string; required: boolean }[]
  requires: string[]
}

export interface TaskFieldsView extends TaskFields {
  advanced: boolean
}

const PATCH_KEYS = ['type', 'properties', 'required']

const isSimpleGuard = (guard: unknown): guard is { required: string[] } =>
  isRecord(guard) && Object.keys(guard).length === 1 && isStrings(guard['required'])

export function readTaskFields(transition: TransitionDocument): TaskFieldsView {
  const patch: unknown = transition.patch
  const guards: unknown[] = transition.guards ?? []
  const properties = isRecord(patch) && isRecord(patch['properties']) ? patch['properties'] : {}
  const required = isRecord(patch) && isStrings(patch['required']) ? patch['required'] : []
  const advancedPatch =
    isRecord(patch) && (patch['type'] !== 'object' || Object.keys(patch).some((key) => !PATCH_KEYS.includes(key)))
  return {
    fills: Object.keys(properties).map((name) => ({ name, required: required.includes(name) })),
    requires: [...new Set(guards.filter(isSimpleGuard).flatMap((guard) => guard.required))],
    advanced: advancedPatch || guards.some((guard) => !isSimpleGuard(guard)),
  }
}

/**
 * The `updateTransition` patch for a form edit, or `null` when the task carries
 * JSON Schema the form cannot express. A field the step already had keeps the
 * schema it had there; a new one copies the data schema's.
 */
export function writeTaskFields(
  transition: TransitionDocument,
  data: unknown,
  fields: TaskFields,
): Partial<TransitionDocument> | null {
  if (readTaskFields(transition).advanced) return null
  const patch: unknown = transition.patch
  const existing = isRecord(patch) && isRecord(patch['properties']) ? patch['properties'] : {}
  const fromData = isRecord(data) && isRecord(data['properties']) ? data['properties'] : {}
  const required = fields.fills.filter((field) => field.required).map((field) => field.name)

  const next =
    fields.fills.length === 0
      ? undefined
      : {
          type: 'object',
          ...(required.length > 0 ? { required } : {}),
          properties: Object.fromEntries(
            fields.fills.map((field) => [field.name, existing[field.name] ?? fromData[field.name] ?? {}]),
          ),
        }
  return {
    // The properties are copied JSON Schema; the cast only re-labels `unknown` as the JSON it is.
    patch: next as unknown as TransitionDocument['patch'],
    guards: fields.requires.length === 0 ? undefined : [{ required: [...fields.requires] }],
  }
}
