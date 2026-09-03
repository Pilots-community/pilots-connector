/**
 * The process definition: the shared artefact.
 *
 * One definition per process, agreed once, executed identically by every node.
 * This schema is the canonical statement of its shape — docs/DEFINITIONS.md is
 * the annotation, and if the two disagree, this file wins.
 *
 * Every object here is strict. A definition is agreed between companies and then
 * content-addressed; a mistyped key that a lenient parser silently drops is
 * exactly the failure this artefact cannot afford.
 */
import { z } from 'zod'

import {
  DataPath,
  DefinitionId,
  Duration,
  Identifier,
  JsonSchemaDocument,
  SemVer,
  StateId,
  StateRef,
} from './common.js'

import { ANY_STATE } from './common.js'

export { ANY_STATE }

export const PROCESS_CONTEXT = 'https://pilots.example/process/v1'

/**
 * The transition id reserved for the event that creates an instance. Every
 * instance's log starts with it, so the log alone can reconstruct the instance
 * — including which definition it pins and what data it was born with.
 */
export const CREATE_TRANSITION = 'create'

export const ProtocolRole = z.enum(['requester', 'provider', 'observer'])
export type ProtocolRole = z.infer<typeof ProtocolRole>

export const ProcessKind = z.enum(['service', 'quotation'])
export type ProcessKind = z.infer<typeof ProcessKind>

export const RoleDefinition = z.strictObject({
  id: Identifier,
  title: z.string().min(1),
  description: z.string().optional(),
  /** How many participants may fill this role. Always stated, always at least one. */
  cardinality: z.int().min(1).default(1),
  /** A hint for generic UI and for defaulting `hostedBy`. Business logic keys off `id`. */
  protocolRole: ProtocolRole.optional(),
})
export type RoleDefinition = z.infer<typeof RoleDefinition>

/**
 * How a process ended, for the states that end it.
 *
 * The business vocabulary stays the definition's own — `VGM_ISSUED`, `AGREED`,
 * `DELIVERED` — and this says what such a state *means* to anything that is not
 * a person reading it. Two values, deliberately: "it did what it was for" and
 * "it stopped without doing it". A third can be added without breaking a reader
 * that already handles these.
 */
export const StateOutcome = z.enum(['fulfilled', 'abandoned'])
export type StateOutcome = z.infer<typeof StateOutcome>

/** `running`, plus the two ways a process can be over. */
export const InstanceOutcome = z.enum(['running', 'fulfilled', 'abandoned'])
export type InstanceOutcome = z.infer<typeof InstanceOutcome>

export const StateDefinition = z.strictObject({
  id: StateId,
  title: z.string().min(1),
  description: z.string().optional(),
  /**
   * Present exactly on the states that end the process, and **is** what makes
   * a state terminal — there is no second list to disagree with.
   *
   * This exists because a terminal flag alone could not tell `AGREED` from
   * `REJECTED`, so every integrator had to hardcode which of a definition's
   * state names meant success. The computed value travels on the instance and
   * in every notification, so an internal system never learns a state name to
   * answer "is this done, and did it work?".
   */
  outcome: StateOutcome.optional(),
})
export type StateDefinition = z.infer<typeof StateDefinition>

export const AttachmentRule = z.strictObject({
  required: z.boolean(),
  mime: z.array(z.string().min(1)).min(1).optional(),
  maxSize: z.int().min(1).optional(),
})
export type AttachmentRule = z.infer<typeof AttachmentRule>

export const TransitionDefinition = z.strictObject({
  id: Identifier,
  title: z.string().min(1),
  description: z.string().optional(),
  /** States this may be applied in. `["*"]` means any non-terminal state. */
  from: z.array(StateRef).min(1),
  /** The resulting state. Omit for a pure data update. */
  to: StateId.optional(),
  /**
   * Roles permitted to fire this. An empty array means no participant may fire
   * it by hand — only the runtime, via `auto`, a `deadline`, or a `link`.
   */
  by: z.array(Identifier),
  /** JSON Schema for the merge patch this transition applies to `data`. */
  patch: JsonSchemaDocument.optional(),
  /**
   * Extra conditions on the data document *after* the patch. Each guard is an
   * ordinary JSON Schema fragment — `{ "required": ["price"] }` already is one —
   * so guards introduce no second expression language.
   */
  guards: z.array(JsonSchemaDocument).optional(),
  attachments: AttachmentRule.optional(),
  /**
   * How long the state this transition **leads to** may last before
   * `onDeadline` fires. Armed on entry into `to`, so `offer` carrying
   * `PT24H` means "an offer sits unanswered for at most a day".
   *
   * Not measured from the `from` state: a transition's own precondition has
   * already been satisfied by the time it fires, so there would be nothing left
   * to time. The linter enforces that `to` exists and that `onDeadline` can
   * actually be applied in it.
   */
  deadline: Duration.optional(),
  /** The id of another transition to fire when the deadline passes. */
  onDeadline: Identifier.optional(),
  /** Fire immediately on entry into a `from` state. This is what makes a standing quotation a definition concern. */
  auto: z.boolean().default(false),
  /** Declared, not yet enforced: the hook for credential gating. */
  requiresCredential: z.string().min(1).optional(),
})
export type TransitionDefinition = z.infer<typeof TransitionDefinition>

export const VisibilityGrant = z.strictObject({
  path: DataPath,
  roles: z.array(Identifier).min(1),
  /** Restricts the grant to certain instance states. */
  whenState: z.array(StateId).min(1).optional(),
})
export type VisibilityGrant = z.infer<typeof VisibilityGrant>

/** Relations by which one instance may be attached to another. */
export const LinkRelation = z.enum(['quotation'])
export type LinkRelation = z.infer<typeof LinkRelation>

export const LinkDefinition = z.strictObject({
  /** `<relation>:<state>` or `<relation>:<transitionId>`. */
  onEvent: z
    .string()
    .regex(
      /^[a-z][A-Za-z0-9]*:[A-Za-z][A-Za-z0-9_-]*$/,
      'expected <relation>:<state|transitionId>',
    ),
  triggers: Identifier,
})
export type LinkDefinition = z.infer<typeof LinkDefinition>

export const ProcessDefinition = z.strictObject({
  '@context': z.union([z.string(), z.array(z.string())]).default(PROCESS_CONTEXT),
  id: DefinitionId,
  version: SemVer,
  kind: ProcessKind,
  title: z.string().min(1),
  description: z.string().optional(),
  roles: z.array(RoleDefinition).min(1),
  /** The id of the role whose participant runs the home node. Resolved per *instance*. */
  hostedBy: Identifier,
  initialState: StateId,
  /**
   * Roles permitted to create an instance. Absent means any participant may.
   * The hook exists so "the definition forbids the caller's role from creating
   * an instance" is a real check rather than a sentence in a document.
   */
  createdBy: z.array(Identifier).min(1).optional(),
  states: z.array(StateDefinition).min(1),
  defaultVisibility: z.enum(['all', 'none']).default('all'),
  /** JSON Schema the data document must satisfy after every transition, not merely at creation. */
  data: JsonSchemaDocument,
  transitions: z.array(TransitionDefinition).min(1),
  visibility: z.array(VisibilityGrant).default([]),
  links: z.array(LinkDefinition).default([]),
})
export type ProcessDefinition = z.infer<typeof ProcessDefinition>

/** `container-transport@1.0.0` — how instances and offerings refer to a definition. */
export function definitionRef(definition: Pick<ProcessDefinition, 'id' | 'version'>): string {
  return `${definition.id}@${definition.version}`
}

/** Split `container-transport@1.0.0` back into its two halves. */
export function parseDefinitionRef(ref: string): { id: string; version: string } {
  const at = ref.lastIndexOf('@')
  if (at <= 0) throw new TypeError(`not a definition reference: ${JSON.stringify(ref)}`)
  return { id: ref.slice(0, at), version: ref.slice(at + 1) }
}

/** Split `quotation:AGREED` into the relation and what it matches. */
export function parseLinkEvent(onEvent: string): { relation: string; match: string } {
  const colon = onEvent.indexOf(':')
  const relation = onEvent.slice(0, colon)
  const match = onEvent.slice(colon + 1)
  return { relation, match }
}

/**
 * The states a transition may be applied in, with `*` expanded to every
 * non-terminal state. Terminal states are excluded by construction: a `["*"]`
 * cancellation must not resurrect a delivered instance.
 */
export function expandFromStates(
  definition: ProcessDefinition,
  transition: TransitionDefinition,
): string[] {
  if (!transition.from.includes(ANY_STATE)) return transition.from
  const expanded = definition.states.filter((s) => s.outcome === undefined).map((s) => s.id)
  for (const explicit of transition.from) {
    if (explicit !== ANY_STATE && !expanded.includes(explicit)) expanded.push(explicit)
  }
  return expanded
}

export function findTransition(
  definition: ProcessDefinition,
  transitionId: string,
): TransitionDefinition | undefined {
  return definition.transitions.find((t) => t.id === transitionId)
}

export function roleIds(definition: ProcessDefinition): string[] {
  return definition.roles.map((r) => r.id)
}

export function isTerminal(definition: ProcessDefinition, state: string): boolean {
  return outcomeOf(definition, state) !== 'running'
}

/**
 * How this instance stands: still running, or over and how it ended.
 *
 * An unknown state answers `running` rather than throwing. A replica can hold
 * an instance whose definition it has since replaced, and a list that crashes
 * is worse than one that says "in progress".
 */
export function outcomeOf(definition: ProcessDefinition, state: string): InstanceOutcome {
  return definition.states.find((one) => one.id === state)?.outcome ?? 'running'
}

/**
 * The states that end the process — derived, never declared.
 *
 * It used to be a field beside `states`, which meant two places could disagree
 * about whether a state was final and the linter had to check they did not.
 */
export function terminalStates(definition: ProcessDefinition): string[] {
  return definition.states.filter((one) => one.outcome !== undefined).map((one) => one.id)
}
