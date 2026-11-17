/**
 * Whether a value has the shape the projection and the forms walk.
 *
 * Not validation — that is the linter's job, and a draft the linter rejects is
 * still drawn. This is the much smaller promise `toDiagram` needs not to throw:
 * the collections are arrays, every element has a string id, and a transition's
 * `from` and `by` are lists. A JSON object half-typed in a text box is often
 * none of these, and an editor must say so rather than fail.
 */
import type { DefinitionDocument } from './document.js'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isStrings = (value: unknown): boolean =>
  Array.isArray(value) && value.every((one) => typeof one === 'string')

/** Absent, or a string — a label the canvas prints. */
const optionalString = (value: unknown): boolean => value === undefined || typeof value === 'string'

const isElement = (value: unknown): value is Record<string, unknown> =>
  isRecord(value) && typeof value['id'] === 'string' && optionalString(value['title'])

const listOf = (value: unknown, each: (one: unknown) => boolean): boolean =>
  Array.isArray(value) && value.every(each)

export function isDrawable(value: unknown): value is DefinitionDocument {
  if (!isRecord(value)) return false
  return (
    listOf(value['roles'], isElement) &&
    listOf(value['states'], isElement) &&
    listOf(
      value['transitions'],
      (one) =>
        isElement(one) &&
        isStrings(one['from']) &&
        isStrings(one['by']) &&
        optionalString(one['deadline']),
    ) &&
    (value['links'] === undefined ||
      listOf(
        value['links'],
        (one) => isRecord(one) && optionalString(one['onEvent']) && optionalString(one['triggers']),
      )) &&
    (value['visibility'] === undefined ||
      listOf(
        value['visibility'],
        (one) =>
          isRecord(one) &&
          isStrings(one['roles']) &&
          (one['whenState'] === undefined || isStrings(one['whenState'])),
      ))
  )
}
