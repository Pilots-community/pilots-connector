/**
 * The visibility filter.
 *
 * `visibility` maps a dotted path in the data document to the roles that may
 * read it, optionally only in certain states. It is applied on instance reads,
 * on log replay, on the event stream, on notifications and on attachment
 * fetches, on **both** the peer and the local surface. One enforcement point,
 * in the runtime — not the caller's good manners.
 *
 * Two things this deliberately does *not* do:
 *
 * - It does not blind the host. The party named in `hostedBy` physically holds
 *   the bytes. What the architecture guarantees is that the host cannot lie, not
 *   that it cannot look. A value that must be withheld from the host does not
 *   belong in the instance.
 * - It does not break verification. Redaction removes payload fields, never
 *   header fields, and the header commits to the payload by hash — so a peer
 *   verifies a complete chain including events whose payload it never saw.
 */
import { cloneJson, isJsonObject, type JsonObject, type JsonValue } from '../json.js'
import type { ProcessDefinition, VisibilityGrant } from '../schemas/definition.js'
import type { Instance } from '../schemas/instance.js'

export interface Filtered<T> {
  value: T
  /** True when at least one field was withheld from this view. */
  redacted: boolean
}

interface GrantIndex {
  /** Grants keyed by their exact path. */
  byPath: Map<string, VisibilityGrant[]>
  /** Paths that have a grant somewhere below them, so the walk knows to descend. */
  prefixes: Set<string>
  defaultVisible: boolean
}

const indexCache = new WeakMap<ProcessDefinition, GrantIndex>()

function indexOf(definition: ProcessDefinition): GrantIndex {
  let index = indexCache.get(definition)
  if (index) return index

  const byPath = new Map<string, VisibilityGrant[]>()
  const prefixes = new Set<string>()
  for (const grant of definition.visibility) {
    const existing = byPath.get(grant.path)
    if (existing) existing.push(grant)
    else byPath.set(grant.path, [grant])

    const segments = grant.path.split('.')
    for (let i = 1; i < segments.length; i += 1) {
      prefixes.add(segments.slice(0, i).join('.'))
    }
  }

  index = { byPath, prefixes, defaultVisible: definition.defaultVisibility === 'all' }
  indexCache.set(definition, index)
  return index
}

function decide(
  grants: readonly VisibilityGrant[],
  roles: readonly string[],
  state: string,
): boolean {
  return grants.some(
    (grant) =>
      grant.roles.some((role) => roles.includes(role)) &&
      (grant.whenState === undefined || grant.whenState.includes(state)),
  )
}

/**
 * May this viewer read this path?
 *
 * The nearest grant along the path decides; if no ancestor is granted at all,
 * `defaultVisibility` does.
 */
export function canReadPath(
  definition: ProcessDefinition,
  path: string,
  roles: readonly string[],
  state: string,
): boolean {
  const { byPath, defaultVisible } = indexOf(definition)
  const segments = path.split('.')
  let visible = defaultVisible
  for (let i = 1; i <= segments.length; i += 1) {
    const grants = byPath.get(segments.slice(0, i).join('.'))
    if (grants) visible = decide(grants, roles, state)
  }
  return visible
}

function walk(
  index: GrantIndex,
  source: JsonObject,
  prefix: string,
  inherited: boolean,
  roles: readonly string[],
  state: string,
  report: { redacted: boolean },
): JsonObject {
  const result: JsonObject = {}

  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue
    const path = prefix === '' ? key : `${prefix}.${key}`
    const grants = index.byPath.get(path)
    const visible = grants ? decide(grants, roles, state) : inherited
    const hasDeeperGrants = index.prefixes.has(path)

    if (isJsonObject(value) && hasDeeperGrants) {
      // Descend even when this node is not itself visible: with
      // `defaultVisibility: "none"`, a granted leaf must still be reachable
      // through an ungranted container.
      const nested = walk(index, value, path, visible, roles, state, report)
      if (Object.keys(nested).length > 0 || visible) result[key] = nested
      else report.redacted = true
      continue
    }

    if (visible) result[key] = cloneJson(value)
    else report.redacted = true
  }

  return result
}

/** The data document as one viewer may see it, in one instance state. */
export function filterData(
  definition: ProcessDefinition,
  data: JsonObject,
  roles: readonly string[],
  state: string,
): Filtered<JsonObject> {
  const index = indexOf(definition)
  const report = { redacted: false }
  const value = walk(index, data, '', index.defaultVisible, roles, state, report)
  return { value, redacted: report.redacted }
}

/** An instance as one viewer may see it. The envelope is never filtered — only `data`. */
export function filterInstance(
  definition: ProcessDefinition,
  instance: Instance,
  roles: readonly string[],
): { instance: Instance; redacted: boolean } {
  const filtered = filterData(definition, instance.data, roles, instance.state)
  return {
    instance: { ...instance, data: filtered.value },
    redacted: filtered.redacted,
  }
}

/**
 * An event payload as one viewer may see it.
 *
 * Filtered against the instance's **current** state, not the state the event was
 * written in. That is what makes S1 step 6→8 work: the same stored `weigh` event
 * is filtered one way before payment and another way after, with nothing re-sent
 * and nothing re-signed. It is also the invariant that keeps notifications
 * honest — a notification never carries a field its recipient could not have
 * read from `GET /instances/{id}`.
 */
export function filterPayload(
  definition: ProcessDefinition,
  payload: JsonObject | null,
  roles: readonly string[],
  currentState: string,
): Filtered<JsonObject | null> {
  if (payload === null) return { value: null, redacted: false }
  return filterData(definition, payload, roles, currentState)
}

export type { JsonValue }
