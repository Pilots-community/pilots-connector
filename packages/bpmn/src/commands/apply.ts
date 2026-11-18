/**
 * The one way the editor changes a definition.
 *
 * Commands guarantee **referential integrity** — no dangling reference, no
 * duplicate id, a well-formed id for anything new — and nothing more. Whether a
 * version string, a duration or a link's event is acceptable is the linter's
 * call: a second set of rules here would drift from the one that matters (B6).
 *
 * The input is never mutated: each command works on a clone, so undo is simply
 * keeping the previous document.
 */
import { ANY_STATE, type DefinitionDocument, type TransitionDocument } from '../document.js'
import { assign, checkNewId, done, fail, idsOf, unknown } from './checks.js'
import { setPointer } from './pointer.js'
import { removeElement, renameElement } from './references.js'
import type { Command, CommandError, CommandResult } from './types.js'

export function applyCommand(document: DefinitionDocument, command: Command): CommandResult {
  const next = structuredClone(document)
  switch (command.type) {
    case 'setProcess': {
      const { hostedBy, initialState, createdBy } = command.patch
      const roles = idsOf(next, 'role')
      if (hostedBy !== undefined && !roles.includes(hostedBy)) return fail(unknown('role', hostedBy))
      if (initialState !== undefined && !idsOf(next, 'state').includes(initialState)) {
        return fail(unknown('state', initialState))
      }
      const stranger = (createdBy ?? []).find((role) => !roles.includes(role))
      if (stranger !== undefined) return fail(unknown('role', stranger))
      assign(next, command.patch)
      return done(next)
    }

    case 'addRole': {
      const invalid = checkNewId(next, 'role', command.role.id)
      if (invalid) return fail(invalid)
      next.roles.push(structuredClone(command.role))
      return done(next)
    }
    case 'updateRole': {
      const role = next.roles.find((one) => one.id === command.id)
      if (role === undefined) return fail(unknown('role', command.id))
      assign(role, command.patch)
      return done(next)
    }

    case 'addState': {
      const invalid = checkNewId(next, 'state', command.state.id)
      if (invalid) return fail(invalid)
      next.states.push(structuredClone(command.state))
      return done(next)
    }
    case 'updateState': {
      const state = next.states.find((one) => one.id === command.id)
      if (state === undefined) return fail(unknown('state', command.id))
      assign(state, command.patch)
      return done(next)
    }

    case 'addTransition': {
      const invalid =
        checkNewId(next, 'transition', command.transition.id) ?? checkTransitionRefs(next, command.transition)
      if (invalid) return fail(invalid)
      next.transitions.push(structuredClone(command.transition))
      return done(next)
    }
    case 'updateTransition': {
      const transition = next.transitions.find((one) => one.id === command.id)
      if (transition === undefined) return fail(unknown('transition', command.id))
      const invalid = checkTransitionRefs(next, command.patch)
      if (invalid) return fail(invalid)
      assign(transition, command.patch)
      return done(next)
    }

    case 'moveTask': {
      const transition = next.transitions.find((one) => one.id === command.transition)
      if (transition === undefined) return fail(unknown('transition', command.transition))
      if (!transition.by.includes(command.fromRole)) {
        return fail({ code: 'not-allowed', message: `${command.fromRole} does not fire ${transition.id}` })
      }
      if (!idsOf(next, 'role').includes(command.toRole)) return fail(unknown('role', command.toRole))
      if (transition.by.includes(command.toRole)) {
        return fail({ code: 'not-allowed', message: `${command.toRole} already fires ${transition.id}` })
      }
      transition.by = transition.by.map((role) => (role === command.fromRole ? command.toRole : role))
      return done(next)
    }

    case 'setDeadline': {
      const transition = next.transitions.find((one) => one.id === command.transition)
      if (transition === undefined) return fail(unknown('transition', command.transition))
      if (transition.to === undefined) {
        return fail({
          code: 'not-allowed',
          message: `a deadline arms on entry into the state a transition leads to, and ${transition.id} leads nowhere`,
        })
      }
      if (!idsOf(next, 'transition').includes(command.onDeadline)) {
        return fail(unknown('transition', command.onDeadline))
      }
      transition.deadline = command.deadline
      transition.onDeadline = command.onDeadline
      return done(next)
    }
    case 'clearDeadline': {
      const transition = next.transitions.find((one) => one.id === command.transition)
      if (transition === undefined) return fail(unknown('transition', command.transition))
      delete transition.deadline
      delete transition.onDeadline
      return done(next)
    }

    case 'addLink': {
      if (!idsOf(next, 'transition').includes(command.link.triggers)) {
        return fail(unknown('transition', command.link.triggers))
      }
      next.links = [...(next.links ?? []), structuredClone(command.link)]
      return done(next)
    }
    case 'removeLink': {
      const links = next.links ?? []
      if (!Number.isInteger(command.index) || command.index < 0 || command.index >= links.length) {
        return fail({ code: 'not-allowed', message: `there is no link at position ${command.index}` })
      }
      next.links = links.filter((_, index) => index !== command.index)
      return done(next)
    }

    case 'rename':
      return renameElement(next, command.kind, command.from, command.to)
    case 'remove':
      return removeElement(next, command.kind, command.id, command.cascade ?? false)
    case 'setFragment':
      return setPointer(next, command.pointer, command.value)
  }
}

/** The references a transition (or part of one) makes must all exist. */
function checkTransitionRefs(
  document: DefinitionDocument,
  transition: Partial<TransitionDocument>,
): CommandError | null {
  const states = idsOf(document, 'state')
  const roles = idsOf(document, 'role')
  const stray = (transition.from ?? []).find((state) => state !== ANY_STATE && !states.includes(state))
  if (stray !== undefined) return unknown('state', stray)
  if (transition.to !== undefined && !states.includes(transition.to)) return unknown('state', transition.to)
  const stranger = (transition.by ?? []).find((role) => !roles.includes(role))
  if (stranger !== undefined) return unknown('role', stranger)
  if (transition.onDeadline !== undefined && !idsOf(document, 'transition').includes(transition.onDeadline)) {
    return unknown('transition', transition.onDeadline)
  }
  return null
}
