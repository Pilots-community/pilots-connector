/**
 * What changed between two versions of a process definition.
 *
 * This exists for one screen: an operator being asked to accept version `1.1.0`
 * of a process they already agreed to at `1.0.0`. The question they are actually
 * answering is *"what am I agreeing to now that I wasn't before"*, and a text
 * diff answers it badly — reordered keys look like changes, and a renamed title
 * looks the same size as a new party gaining the right to cancel.
 *
 * So the comparison is **structural and by identity**: roles, states and
 * transitions are matched by `id`, visibility grants by `path`, links by
 * `onEvent`. Anything matched on both sides is compared field by field, and the
 * fields that differ are named — because "transition `deliver` changed" is not
 * useful, while "transition `deliver` changed: by, attachments" is.
 *
 * Deliberately not a general-purpose JSON differ. It knows the shape of a
 * definition, which is what lets it say `role added: terminal` instead of
 * `/roles/2 added`.
 */
import { canonicalise } from '../canonical.js'
import type { JsonValue } from '../json.js'
import type { ProcessDefinition } from '../schemas/definition.js'

export type DefinitionChangeKind =
  'metadata' | 'role' | 'state' | 'transition' | 'visibility' | 'link'

export interface DefinitionChange {
  kind: DefinitionChangeKind
  change: 'added' | 'removed' | 'changed'
  /** The identity of the thing that changed: a role id, a state id, a field name. */
  id: string
  /** Human-readable, and specific enough to act on. */
  detail: string
}

/** The definition-level fields worth reporting on their own. */
const METADATA = [
  'title',
  'description',
  'kind',
  'hostedBy',
  'initialState',
  'defaultVisibility',
  'createdBy',
] as const

export function diffDefinitions(
  before: ProcessDefinition,
  after: ProcessDefinition,
): DefinitionChange[] {
  const changes: DefinitionChange[] = []

  for (const field of METADATA) {
    const from = before[field as keyof ProcessDefinition]
    const to = after[field as keyof ProcessDefinition]
    if (!same(from, to)) {
      changes.push({
        kind: 'metadata',
        change: 'changed',
        id: field,
        detail: `${field}: ${describe(from)} → ${describe(to)}`,
      })
    }
  }

  if (!same(before.data, after.data)) {
    changes.push({
      kind: 'metadata',
      change: 'changed',
      id: 'data',
      detail: 'the data schema changed, so what an instance may hold is different',
    })
  }

  collect(changes, 'role', before.roles, after.roles, (role) => role.id, [
    'title',
    'cardinality',
    'protocolRole',
  ])
  collect(changes, 'state', before.states, after.states, (state) => state.id, [
    'title',
    'description',
    'outcome',
  ])
  collect(
    changes,
    'transition',
    before.transitions,
    after.transitions,
    (transition) => transition.id,
    [
      'title',
      'from',
      'to',
      'by',
      'patch',
      'guards',
      'attachments',
      'deadline',
      'onDeadline',
      'auto',
    ],
  )
  collect(changes, 'visibility', before.visibility, after.visibility, (grant) => grant.path, [
    'roles',
    'whenState',
  ])
  collect(changes, 'link', before.links, after.links, (link) => link.onEvent, ['triggers'])

  return changes
}

function collect<T extends Record<string, unknown>>(
  into: DefinitionChange[],
  kind: DefinitionChangeKind,
  before: readonly T[],
  after: readonly T[],
  identity: (item: T) => string,
  fields: readonly string[],
): void {
  const left = new Map(before.map((item) => [identity(item), item]))
  const right = new Map(after.map((item) => [identity(item), item]))

  for (const [id, item] of right) {
    const previous = left.get(id)
    if (!previous) {
      into.push({
        kind,
        change: 'added',
        id,
        detail: `${kind} added: ${id}${summarise(kind, item)}`,
      })
      continue
    }
    const differing = fields.filter((field) => !same(previous[field], item[field]))
    if (differing.length > 0) {
      into.push({
        kind,
        change: 'changed',
        id,
        detail: `${kind} ${id} changed: ${differing.join(', ')}`,
      })
    }
  }

  for (const [id] of left) {
    if (!right.has(id)) {
      into.push({ kind, change: 'removed', id, detail: `${kind} removed: ${id}` })
    }
  }
}

/**
 * A word about *why* an addition matters, where the shape makes it obvious.
 *
 * A new transition that a party may fire is a new right; a new terminal state
 * is a new way the process can end. Both are the kind of thing an operator
 * should not have to open the JSON to notice.
 */
function summarise(kind: DefinitionChangeKind, item: Record<string, unknown>): string {
  if (kind === 'transition') {
    const by = item['by']
    if (Array.isArray(by) && by.length > 0) return ` (fireable by ${by.join(', ')})`
    return ' (fired by the runtime, not by a participant)'
  }
  if (kind === 'state' && typeof item['outcome'] === 'string') {
    return ` (a terminal state: ${item['outcome']})`
  }
  return ''
}

/** Structural equality, so a reordered object is not a change. */
function same(left: unknown, right: unknown): boolean {
  if (left === undefined && right === undefined) return true
  if (left === undefined || right === undefined) return false
  return canonicalise(left as JsonValue) === canonicalise(right as JsonValue)
}

function describe(value: unknown): string {
  if (value === undefined) return '(absent)'
  if (typeof value === 'string') return value
  return canonicalise(value as JsonValue)
}
