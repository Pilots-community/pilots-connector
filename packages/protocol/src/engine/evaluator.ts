/**
 * The state machine.
 *
 * A pure function over documents: no I/O, no clock, no store. Given a
 * definition, an instance and a proposed transition, it returns the next
 * instance or a typed refusal. The connector assigns `seq`, signs, appends and
 * delivers; none of that belongs here.
 *
 * `availableTransitions` is the other half and matters more than its size
 * suggests: it is one rule with three consumers — the `action.required`
 * notification, the UI's buttons, and the permission check above. They cannot
 * disagree because there is only one of it.
 */
import { isJsonObject, type JsonObject, type JsonValue } from '../json.js'
import { applyMergePatch } from '../merge-patch.js'
import { Problem, protocolError, type ProtocolError } from '../problems.js'
import { err, ok, type Result } from '../result.js'
import type { AttachmentRef } from '../schemas/common.js'
import {
  CREATE_TRANSITION,
  expandFromStates,
  findTransition,
  isTerminal,
  type ProcessDefinition,
  type TransitionDefinition,
} from '../schemas/definition.js'
import { didsFor, type Instance, type ParticipantMap } from '../schemas/instance.js'
import type { AvailableAction } from '../schemas/subscription.js'
import { defaultSchemaValidator, type SchemaValidator } from '../validation/ajv.js'

/** Who is firing a transition: a participant holding roles, or the runtime itself. */
export type TransitionActor = { roles: readonly string[] } | { runtime: true }

export interface TransitionRequest {
  transition: string
  /** The JSON Merge Patch to apply to `data`. */
  patch?: JsonObject | null
  attachments?: readonly AttachmentRef[]
  actor: TransitionActor
  /** The instant this is applied, from the `Clock` port. */
  at: string
}

export interface TransitionOutcome {
  transition: TransitionDefinition
  from: string
  /** The new state, or `null` for a pure data update. */
  to: string | null
  /** The instance as it will be. `seq` has been advanced by one. */
  instance: Instance
  /** What the event's payload will be: the patch as applied, or `null`. */
  payload: JsonObject | null
  attachments: AttachmentRef[]
}

export interface EvaluatorOptions {
  validator?: SchemaValidator
}

function isRuntime(actor: TransitionActor): actor is { runtime: true } {
  return 'runtime' in actor
}

/**
 * Which of `roles` permits `transition`, in the order the definition lists them.
 * The runtime is not a role: it fires transitions nobody may fire by hand.
 */
function permittingRoles(transition: TransitionDefinition, roles: readonly string[]): string[] {
  return transition.by.filter((role) => roles.includes(role))
}

/**
 * Apply a transition, or say exactly why not.
 *
 * The order of the checks is the order in docs/PROTOCOL.md §9.2, with one
 * addition: a terminal instance is refused before anything else about the
 * transition is considered, because "this process is over" is a better answer
 * than "that state is not in `from`".
 */
export function evaluateTransition(
  definition: ProcessDefinition,
  instance: Instance,
  request: TransitionRequest,
  options: EvaluatorOptions = {},
): Result<TransitionOutcome, ProtocolError[]> {
  const validator = options.validator ?? defaultSchemaValidator()

  const transition = findTransition(definition, request.transition)
  if (!transition) {
    return err([
      protocolError(
        Problem.unknownTransition,
        `definition ${definition.id}@${definition.version} has no transition ${JSON.stringify(request.transition)}`,
      ),
    ])
  }

  if (isTerminal(definition, instance.state)) {
    return err([
      protocolError(
        Problem.instanceTerminal,
        `the instance is in terminal state ${instance.state} and cannot advance`,
      ),
    ])
  }

  if (!isRuntime(request.actor)) {
    const permitting = permittingRoles(transition, request.actor.roles)
    if (permitting.length === 0) {
      return err([
        protocolError(
          Problem.roleNotPermitted,
          transition.by.length === 0
            ? `transition ${transition.id} may only be fired by the runtime`
            : `transition ${transition.id} may only be fired by ${transition.by.join(', ')}`,
        ),
      ])
    }
  }

  const from = expandFromStates(definition, transition)
  if (!from.includes(instance.state)) {
    return err([
      protocolError(
        Problem.illegalState,
        `transition ${transition.id} may not be applied in state ${instance.state}`,
      ),
    ])
  }

  const attachmentErrors = checkAttachments(transition, request.attachments ?? [])
  if (attachmentErrors.length > 0) return err(attachmentErrors)

  const patch = request.patch ?? null
  if (transition.patch === undefined) {
    if (patch !== null) {
      return err([
        protocolError(
          Problem.schemaInvalid,
          `transition ${transition.id} applies no patch, so none may be supplied`,
          '/patch',
        ),
      ])
    }
  } else {
    const patchErrors = validator.validate(
      transition.patch,
      patch ?? {},
      Problem.schemaInvalid,
      `patch for ${transition.id}`,
    )
    if (patchErrors.length > 0) return err(patchErrors)
  }

  const nextData = patch === null ? instance.data : applyMergePatch(instance.data, patch)
  if (!isJsonObject(nextData)) {
    return err([
      protocolError(
        Problem.schemaInvalid,
        'the patch replaced the data document with a non-object',
      ),
    ])
  }

  const dataErrors = validator.validate(
    definition.data,
    nextData,
    Problem.schemaInvalid,
    'data document',
  )
  if (dataErrors.length > 0) return err(dataErrors)

  for (const guard of transition.guards ?? []) {
    const guardErrors = validator.validate(
      guard,
      nextData,
      Problem.guardFailed,
      `guard on ${transition.id}`,
    )
    if (guardErrors.length > 0) return err(guardErrors)
  }

  const to = transition.to ?? null
  return ok({
    transition,
    from: instance.state,
    to,
    payload: patch,
    attachments: [...(request.attachments ?? [])],
    instance: {
      ...instance,
      state: to ?? instance.state,
      seq: instance.seq + 1,
      data: nextData,
      updatedAt: request.at,
    },
  })
}

function checkAttachments(
  transition: TransitionDefinition,
  attachments: readonly AttachmentRef[],
): ProtocolError[] {
  const rule = transition.attachments
  if (!rule) {
    return attachments.length === 0
      ? []
      : [
          protocolError(
            Problem.attachmentsInvalid,
            `transition ${transition.id} takes no attachments`,
            '/attachments',
          ),
        ]
  }
  if (rule.required && attachments.length === 0) {
    return [
      protocolError(
        Problem.attachmentsInvalid,
        `transition ${transition.id} requires at least one attachment`,
        '/attachments',
      ),
    ]
  }
  const errors: ProtocolError[] = []
  for (const [index, attachment] of attachments.entries()) {
    if (rule.mime && !rule.mime.includes(attachment.mime)) {
      errors.push(
        protocolError(
          Problem.attachmentsInvalid,
          `attachment ${attachment.sha256} is ${attachment.mime}; ${transition.id} accepts ${rule.mime.join(', ')}`,
          `/attachments/${index}/mime`,
        ),
      )
    }
    if (rule.maxSize !== undefined && attachment.size > rule.maxSize) {
      errors.push(
        protocolError(
          Problem.attachmentsInvalid,
          `attachment ${attachment.sha256} is ${attachment.size} bytes; the limit is ${rule.maxSize}`,
          `/attachments/${index}/size`,
        ),
      )
    }
  }
  return errors
}

/**
 * The transitions this participant may fire right now, and the role that permits
 * each. Deliberately checks state and role only — a guard is about the document
 * *after* a patch, so it cannot be decided before the caller has written one.
 * A button may still be refused; that is what the refusal path is for.
 */
export function availableTransitions(
  definition: ProcessDefinition,
  instance: Pick<Instance, 'state'>,
  roles: readonly string[],
): AvailableAction[] {
  if (isTerminal(definition, instance.state)) return []
  const actions: AvailableAction[] = []
  for (const transition of definition.transitions) {
    if (!expandFromStates(definition, transition).includes(instance.state)) continue
    for (const role of permittingRoles(transition, roles)) {
      actions.push({ transition: transition.id, role })
    }
  }
  return actions
}

/** True when it is this participant's turn — the whole of `action.required`. */
export function actionRequired(
  definition: ProcessDefinition,
  instance: Pick<Instance, 'state'>,
  roles: readonly string[],
): boolean {
  return availableTransitions(definition, instance, roles).length > 0
}

/**
 * Transitions marked `auto` that apply in the instance's current state. The
 * runtime fires these on entry, which is the whole of a standing quotation:
 * a definition whose first transition auto-fires, not a special case in code.
 */
export function autoTransitions(
  definition: ProcessDefinition,
  instance: Pick<Instance, 'state'>,
): TransitionDefinition[] {
  if (isTerminal(definition, instance.state)) return []
  return definition.transitions.filter(
    (transition) =>
      transition.auto && expandFromStates(definition, transition).includes(instance.state),
  )
}

export interface CreateRequest {
  id: string
  /** `sha256` of the definition document, so the genesis pins the bytes. */
  definitionHash: string
  participants: ParticipantMap
  data?: JsonObject
  quotationId?: string | null
  offering?: string | null
  /** The DID of the participant creating this. Must be one of `participants`. */
  actorDid: string
  at: string
}

/**
 * Evaluate the creation of an instance.
 *
 * Creation is event `seq` 1, with the reserved transition id `create`. That is
 * what lets the log alone reconstruct the instance — which definition it pins,
 * who is in it, and what data it was born with. An instance whose existence is
 * not in its own log is an instance a replica cannot rebuild.
 */
export function evaluateCreate(
  definition: ProcessDefinition,
  request: CreateRequest,
  options: EvaluatorOptions = {},
): Result<Instance, ProtocolError[]> {
  const validator = options.validator ?? defaultSchemaValidator()
  const errors: ProtocolError[] = []

  const declared = new Set(definition.roles.map((role) => role.id))
  for (const role of Object.keys(request.participants)) {
    if (!declared.has(role)) {
      errors.push(
        protocolError(
          Problem.notAParticipant,
          `definition ${definition.id} declares no role ${JSON.stringify(role)}`,
          `/participants/${role}`,
        ),
      )
    }
  }
  for (const role of definition.roles) {
    const filled = didsFor(request.participants, role.id)
    if (filled.length !== role.cardinality) {
      errors.push(
        protocolError(
          Problem.notAParticipant,
          `role ${role.id} needs exactly ${role.cardinality} participant(s), got ${filled.length}`,
          `/participants/${role.id}`,
        ),
      )
    }
  }
  if (errors.length > 0) return err(errors)

  const actorRoles = rolesForDid(request.participants, request.actorDid)
  if (actorRoles.length === 0) {
    return err([
      protocolError(
        Problem.notAParticipant,
        `${request.actorDid} holds no role in this instance`,
        '/participants',
      ),
    ])
  }

  if (definition.createdBy !== undefined) {
    const permitted = actorRoles.some((role) => definition.createdBy?.includes(role))
    if (!permitted) {
      return err([
        protocolError(
          Problem.roleNotPermitted,
          `only ${definition.createdBy.join(', ')} may create an instance of ${definition.id}`,
        ),
      ])
    }
  }

  const data = request.data ?? {}
  const dataErrors = validator.validate(
    definition.data,
    data,
    Problem.schemaInvalid,
    'data document',
  )
  if (dataErrors.length > 0) return err(dataErrors)

  return ok({
    id: request.id,
    kind: definition.kind,
    definition: `${definition.id}@${definition.version}`,
    definitionHash: request.definitionHash,
    participants: request.participants,
    quotationId: request.quotationId ?? null,
    offering: request.offering ?? null,
    state: definition.initialState,
    seq: 1,
    data,
    createdAt: request.at,
    updatedAt: request.at,
  })
}

function rolesForDid(participants: ParticipantMap, did: string): string[] {
  return Object.keys(participants).filter((role) => didsFor(participants, role).includes(did))
}

export { CREATE_TRANSITION }
export type { JsonValue }
