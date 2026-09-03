/**
 * The definition linter.
 *
 * A definition is agreed once between companies and then executed identically by
 * every node. It is the artefact with the least tolerance for a typo, and the
 * one nobody runs a debugger against. So the checks here are deliberately
 * unsubtle: a definition that fails does not load.
 *
 * Replaces tools/lint-definitions.py, which was a stopgap until this existed.
 */
import { DURATION_SUBSET } from '../duration.js'
import type { JsonValue } from '../json.js'
import {
  ANY_STATE,
  CREATE_TRANSITION,
  ProcessDefinition,
  expandFromStates,
  parseLinkEvent,
  terminalStates,
  type TransitionDefinition,
} from '../schemas/definition.js'
import { createSchemaValidator } from '../validation/ajv.js'

export type LintSeverity = 'error' | 'warning'

export interface LintDiagnostic {
  severity: LintSeverity
  code: string
  message: string
  /** Where in the document, as a JSON pointer. */
  path?: string
}

export interface LintResult {
  /** True when there are no errors. Warnings do not fail a definition. */
  ok: boolean
  diagnostics: LintDiagnostic[]
  /** The parsed definition, when it parsed at all. */
  definition?: ProcessDefinition
}

/** Relations a `links` entry may name today. */
const KNOWN_LINK_RELATIONS = new Set(['quotation'])

export function lintDefinition(raw: unknown): LintResult {
  const diagnostics: LintDiagnostic[] = []
  const error = (code: string, message: string, path?: string): void => {
    diagnostics.push(
      path === undefined
        ? { severity: 'error', code, message }
        : { severity: 'error', code, message, path },
    )
  }
  const warn = (code: string, message: string, path?: string): void => {
    diagnostics.push(
      path === undefined
        ? { severity: 'warning', code, message }
        : { severity: 'warning', code, message, path },
    )
  }

  const parsed = ProcessDefinition.safeParse(raw)
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      error('schema', issue.message, `/${issue.path.join('/')}`)
    }
    return { ok: false, diagnostics }
  }
  const definition = parsed.data

  // — duplicates —
  const roles = new Set<string>()
  for (const [index, role] of definition.roles.entries()) {
    if (roles.has(role.id)) error('duplicate-id', `duplicate role ${role.id}`, `/roles/${index}/id`)
    roles.add(role.id)
  }

  const states = new Set<string>()
  for (const [index, state] of definition.states.entries()) {
    if (states.has(state.id))
      error('duplicate-id', `duplicate state ${state.id}`, `/states/${index}/id`)
    states.add(state.id)
    if (!/^[A-Z][A-Z0-9_]*$/.test(state.id)) {
      warn(
        'naming',
        `state ${state.id} is not UPPER_SNAKE_CASE; every shipped definition is, and a shared artefact reads better consistent`,
        `/states/${index}/id`,
      )
    }
  }

  const transitions = new Map<string, TransitionDefinition>()
  for (const [index, transition] of definition.transitions.entries()) {
    if (transitions.has(transition.id)) {
      error('duplicate-id', `duplicate transition ${transition.id}`, `/transitions/${index}/id`)
    }
    if (transition.id === CREATE_TRANSITION) {
      error(
        'reserved-id',
        `transition id "${CREATE_TRANSITION}" is reserved for the event that creates an instance`,
        `/transitions/${index}/id`,
      )
    }
    transitions.set(transition.id, transition)
  }

  // — references —
  const terminal = new Set(terminalStates(definition))
  if (!states.has(definition.initialState)) {
    error(
      'unknown-state',
      `initialState ${definition.initialState} is not a declared state`,
      '/initialState',
    )
  }
  /*
   * A process must be able to end.
   *
   * This replaces the schema's old `terminalStates: min(1)`. Terminality is
   * derived from `outcome` now, so "no state declares an outcome" is the shape
   * a definition with no ending takes — and without this the dead-end check
   * below has no targets and silently passes.
   */
  if (terminal.size === 0) {
    error(
      'no-terminal-state',
      'no state declares an `outcome`, so this process can never end',
      '/states',
    )
  }
  if (terminal.has(definition.initialState)) {
    warn(
      'degenerate',
      `initialState ${definition.initialState} is also terminal: instances are born finished`,
      '/initialState',
    )
  }
  if (!roles.has(definition.hostedBy)) {
    error(
      'unknown-role',
      `hostedBy names ${definition.hostedBy}, which is not a declared role`,
      '/hostedBy',
    )
  }
  for (const [index, role] of (definition.createdBy ?? []).entries()) {
    if (!roles.has(role)) {
      error(
        'unknown-role',
        `createdBy names ${role}, which is not a declared role`,
        `/createdBy/${index}`,
      )
    }
  }

  const validator = createSchemaValidator()
  const checkJsonSchema = (schema: Record<string, unknown>, path: string, what: string): void => {
    try {
      validator.assertValidSchema(schema)
    } catch (cause) {
      error(
        'invalid-json-schema',
        `${what} is not valid JSON Schema: ${(cause as Error).message}`,
        path,
      )
    }
  }
  checkJsonSchema(definition.data, '/data', 'the data schema')

  const usedRoles = new Set<string>()
  const edges: Array<[from: string, to: string]> = []

  for (const [index, transition] of definition.transitions.entries()) {
    const at = `/transitions/${index}`

    for (const [roleIndex, role] of transition.by.entries()) {
      if (!roles.has(role)) {
        error(
          'unknown-role',
          `${transition.id}: by names unknown role ${role}`,
          `${at}/by/${roleIndex}`,
        )
      }
      usedRoles.add(role)
    }

    for (const [fromIndex, from] of transition.from.entries()) {
      if (from === ANY_STATE) continue
      if (!states.has(from)) {
        error(
          'unknown-state',
          `${transition.id}: unknown from-state ${from}`,
          `${at}/from/${fromIndex}`,
        )
      } else if (terminal.has(from)) {
        error(
          'terminal-outgoing',
          `${transition.id}: ${from} is terminal and must have no outgoing transition`,
          `${at}/from/${fromIndex}`,
        )
      }
    }

    if (transition.to !== undefined && !states.has(transition.to)) {
      error('unknown-state', `${transition.id}: unknown to-state ${transition.to}`, `${at}/to`)
    }

    if (transition.patch)
      checkJsonSchema(transition.patch, `${at}/patch`, `the patch schema of ${transition.id}`)
    for (const [guardIndex, guard] of (transition.guards ?? []).entries()) {
      checkJsonSchema(
        guard,
        `${at}/guards/${guardIndex}`,
        `guard ${guardIndex} of ${transition.id}`,
      )
    }

    if (transition.auto && transition.by.length > 0) {
      warn(
        'auto-with-by',
        `${transition.id} is auto and also fireable by ${transition.by.join(', ')}; it will have fired before anyone can`,
        `${at}/auto`,
      )
    }

    lintDeadline(definition, transition, at, transitions, terminal, error)

    // Edges, for the reachability checks below. A transition with no `to` is a
    // pure data update, which is a self-loop and moves nothing.
    const froms = expandFromStates(definition, transition).filter((state) => states.has(state))
    for (const from of froms) {
      edges.push([from, transition.to ?? from])
    }
  }

  for (const role of definition.roles) {
    if (!usedRoles.has(role.id) && role.protocolRole !== 'observer') {
      warn(
        'unused-role',
        `role ${role.id} may fire no transition; declare it as protocolRole "observer" if that is intended`,
        '/roles',
      )
    }
  }

  for (const [index, link] of definition.links.entries()) {
    if (!transitions.has(link.triggers)) {
      error(
        'dangling-reference',
        `link ${link.onEvent} triggers unknown transition ${link.triggers}`,
        `/links/${index}/triggers`,
      )
    }
    const { relation } = parseLinkEvent(link.onEvent)
    if (!KNOWN_LINK_RELATIONS.has(relation)) {
      warn(
        'unknown-relation',
        `link relation ${relation} is not one the runtime knows (${[...KNOWN_LINK_RELATIONS].join(', ')}), so it will never fire`,
        `/links/${index}/onEvent`,
      )
    }
  }

  const dataProperties = propertyNamesOf(definition.data)
  for (const [index, grant] of definition.visibility.entries()) {
    for (const [roleIndex, role] of grant.roles.entries()) {
      if (!roles.has(role)) {
        error(
          'unknown-role',
          `visibility grant on ${grant.path}: unknown role ${role}`,
          `/visibility/${index}/roles/${roleIndex}`,
        )
      }
    }
    for (const [stateIndex, state] of (grant.whenState ?? []).entries()) {
      if (!states.has(state)) {
        error(
          'unknown-state',
          `visibility grant on ${grant.path}: unknown state ${state}`,
          `/visibility/${index}/whenState/${stateIndex}`,
        )
      }
    }
    const root = grant.path.split('.')[0]!
    if (dataProperties !== undefined && !dataProperties.has(root)) {
      warn(
        'visibility-path',
        `visibility grant on ${grant.path} names ${root}, which the data schema does not declare`,
        `/visibility/${index}/path`,
      )
    }
  }

  if (definition.defaultVisibility === 'none' && definition.visibility.length === 0) {
    warn(
      'nothing-visible',
      'defaultVisibility is "none" and there are no grants: no participant may read anything',
      '/defaultVisibility',
    )
  }

  // — reachability, both directions —
  if (states.has(definition.initialState)) {
    const forward = reachable(edges, [definition.initialState], 'forward')
    const unreachable = [...states].filter((state) => !forward.has(state))
    if (unreachable.length > 0) {
      error(
        'unreachable-state',
        `unreachable from ${definition.initialState}: ${unreachable.sort().join(', ')}`,
        '/states',
      )
    }
  }

  const declaredTerminals = [...terminal]
  if (declaredTerminals.length > 0) {
    const backward = reachable(edges, declaredTerminals, 'backward')
    const deadEnds = [...states].filter((state) => !backward.has(state))
    if (deadEnds.length > 0) {
      error(
        'dead-end-state',
        `no path to any terminal state from: ${deadEnds.sort().join(', ')}`,
        '/states',
      )
    }
  }

  return {
    ok: !diagnostics.some((d) => d.severity === 'error'),
    diagnostics,
    definition,
  }
}

/**
 * A `deadline` arms when the instance enters the state the transition leads to,
 * and `onDeadline` fires if it is still there when the duration elapses.
 *
 * That is the reading the shipped definitions and SCENARIOS.md S2 both use —
 * `offer` leads to `OFFERED` and `expire` applies in `OFFERED`, so the timer is
 * "how long may an offer sit unanswered". A deadline on a transition with no
 * `to` has nothing to arm on, and an `onDeadline` target that cannot be applied
 * in that state can never fire; both are errors rather than surprises at runtime.
 */
function lintDeadline(
  definition: ProcessDefinition,
  transition: TransitionDefinition,
  at: string,
  transitions: Map<string, TransitionDefinition>,
  terminal: Set<string>,
  error: (code: string, message: string, path?: string) => void,
): void {
  if (transition.deadline === undefined && transition.onDeadline === undefined) return

  if (transition.deadline === undefined) {
    error('deadline', `${transition.id}: onDeadline without a deadline`, `${at}/onDeadline`)
    return
  }
  if (transition.onDeadline === undefined) {
    error('deadline', `${transition.id}: deadline without an onDeadline to fire`, `${at}/deadline`)
    return
  }
  if (transition.to === undefined) {
    error(
      'deadline',
      `${transition.id}: a deadline arms on entry into the transition's "to" state, and this transition has none (${DURATION_SUBSET})`,
      `${at}/deadline`,
    )
    return
  }

  const target = transitions.get(transition.onDeadline)
  if (!target) {
    error(
      'dangling-reference',
      `${transition.id}: onDeadline references unknown transition ${transition.onDeadline}`,
      `${at}/onDeadline`,
    )
    return
  }

  if (terminal.has(transition.to)) {
    error(
      'deadline',
      `${transition.id}: a deadline on entry into terminal state ${transition.to} can never fire`,
      `${at}/deadline`,
    )
    return
  }

  if (!expandFromStates(definition, target).includes(transition.to)) {
    error(
      'deadline',
      `${transition.id}: the deadline arms in ${transition.to}, but ${target.id} may not be applied there`,
      `${at}/onDeadline`,
    )
  }
}

function reachable(
  edges: ReadonlyArray<readonly [string, string]>,
  seeds: readonly string[],
  direction: 'forward' | 'backward',
): Set<string> {
  const adjacency = new Map<string, Set<string>>()
  for (const [from, to] of edges) {
    const [key, value] = direction === 'forward' ? [from, to] : [to, from]
    const bucket = adjacency.get(key)
    if (bucket) bucket.add(value)
    else adjacency.set(key, new Set([value]))
  }

  const seen = new Set(seeds)
  const stack = [...seeds]
  while (stack.length > 0) {
    const current = stack.pop()!
    for (const next of adjacency.get(current) ?? []) {
      if (!seen.has(next)) {
        seen.add(next)
        stack.push(next)
      }
    }
  }
  return seen
}

/** The top-level property names a JSON Schema declares, when it declares any. */
function propertyNamesOf(schema: Record<string, unknown>): Set<string> | undefined {
  const properties = (schema as { properties?: unknown }).properties
  if (typeof properties !== 'object' || properties === null) return undefined
  return new Set(Object.keys(properties))
}

/** A one-line rendering of a diagnostic, for the CLI and for test failures. */
export function formatDiagnostic(diagnostic: LintDiagnostic): string {
  const where = diagnostic.path ? ` (${diagnostic.path})` : ''
  return `${diagnostic.severity}: [${diagnostic.code}] ${diagnostic.message}${where}`
}

export type { JsonValue }
