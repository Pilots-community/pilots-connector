/**
 * Who still refers to what — and what a rename or a removal has to follow.
 *
 * `links[].onEvent` is deliberately never touched: it names a state or a
 * transition of the *linked* definition, not of this one.
 */
import type { DefinitionDocument } from '../document.js'
import { checkNewId, done, fail, idsOf, unknown } from './checks.js'
import type { CommandResult, ElementKind } from './types.js'

export function dependentsOf(document: DefinitionDocument, kind: ElementKind, id: string): string[] {
  const out: string[] = []
  switch (kind) {
    case 'role':
      if (document.hostedBy === id) out.push('hostedBy')
      if (document.createdBy?.includes(id) === true) out.push('createdBy')
      for (const t of document.transitions) if (t.by.includes(id)) out.push(`transition ${t.id} (by)`)
      for (const g of document.visibility ?? []) if (g.roles.includes(id)) out.push(`visibility of ${g.path}`)
      break
    case 'state':
      if (document.initialState === id) out.push('initialState')
      for (const t of document.transitions) {
        if (t.from.includes(id)) out.push(`transition ${t.id} (from)`)
        if (t.to === id) out.push(`transition ${t.id} (to)`)
      }
      for (const g of document.visibility ?? []) {
        if (g.whenState?.includes(id) === true) out.push(`visibility of ${g.path}`)
      }
      break
    case 'transition':
      for (const t of document.transitions) if (t.onDeadline === id) out.push(`deadline of ${t.id}`)
      for (const l of document.links ?? []) if (l.triggers === id) out.push(`link ${l.onEvent}`)
      break
  }
  return out
}

/** Mutates `document` (a clone, from `applyCommand`). */
export function renameElement(
  document: DefinitionDocument,
  kind: ElementKind,
  from: string,
  to: string,
): CommandResult {
  if (!idsOf(document, kind).includes(from)) return fail(unknown(kind, from))
  if (from === to) return done(document)
  const invalid = checkNewId(document, kind, to)
  if (invalid) return fail(invalid)
  const swap = (value: string): string => (value === from ? to : value)

  switch (kind) {
    case 'role':
      for (const role of document.roles) role.id = swap(role.id)
      document.hostedBy = swap(document.hostedBy)
      if (document.createdBy !== undefined) document.createdBy = document.createdBy.map(swap)
      for (const t of document.transitions) t.by = t.by.map(swap)
      for (const g of document.visibility ?? []) g.roles = g.roles.map(swap)
      break
    case 'state':
      for (const state of document.states) state.id = swap(state.id)
      document.initialState = swap(document.initialState)
      for (const t of document.transitions) {
        t.from = t.from.map(swap)
        if (t.to !== undefined) t.to = swap(t.to)
      }
      for (const g of document.visibility ?? []) {
        if (g.whenState !== undefined) g.whenState = g.whenState.map(swap)
      }
      break
    case 'transition':
      for (const t of document.transitions) {
        t.id = swap(t.id)
        if (t.onDeadline !== undefined) t.onDeadline = swap(t.onDeadline)
      }
      for (const l of document.links ?? []) l.triggers = swap(l.triggers)
      break
  }
  return done(document)
}

/** Mutates `document` (a clone, from `applyCommand`). */
export function removeElement(
  document: DefinitionDocument,
  kind: ElementKind,
  id: string,
  cascade: boolean,
): CommandResult {
  if (!idsOf(document, kind).includes(id)) return fail(unknown(kind, id))
  if (kind === 'role' && document.hostedBy === id) {
    return fail({ code: 'not-allowed', message: `${id} hosts this process; choose another host before removing it` })
  }
  if (kind === 'state' && document.initialState === id) {
    return fail({
      code: 'not-allowed',
      message: `${id} is where the process starts; choose another initial state before removing it`,
    })
  }
  const dependents = dependentsOf(document, kind, id)
  if (dependents.length > 0 && !cascade) {
    return fail({ code: 'has-dependents', message: `${id} is still used in ${dependents.length} place(s)`, dependents })
  }

  switch (kind) {
    case 'role':
      removeRole(document, id)
      break
    case 'state':
      removeState(document, id)
      break
    case 'transition':
      removeTransition(document, id)
      break
  }
  if (document.transitions.length === 0) {
    return fail({ code: 'not-allowed', message: 'a process needs at least one transition' })
  }
  return done(document)
}

function removeRole(document: DefinitionDocument, id: string): void {
  document.roles = document.roles.filter((one) => one.id !== id)
  for (const t of document.transitions) t.by = t.by.filter((role) => role !== id)
  if (document.createdBy !== undefined) {
    const left = document.createdBy.filter((role) => role !== id)
    if (left.length === 0) delete document.createdBy
    else document.createdBy = left
  }
  if (document.visibility !== undefined) {
    document.visibility = document.visibility.flatMap((grant) => {
      if (!grant.roles.includes(id)) return [grant]
      const roles = grant.roles.filter((role) => role !== id)
      return roles.length === 0 ? [] : [{ ...grant, roles }]
    })
  }
}

function removeState(document: DefinitionDocument, id: string): void {
  document.states = document.states.filter((one) => one.id !== id)
  const doomed: string[] = []
  for (const t of document.transitions) {
    if (t.to === id) {
      doomed.push(t.id)
      continue
    }
    if (!t.from.includes(id)) continue
    const from = t.from.filter((state) => state !== id)
    if (from.length === 0) doomed.push(t.id)
    else t.from = from
  }
  for (const transition of doomed) removeTransition(document, transition)
  if (document.visibility !== undefined) {
    document.visibility = document.visibility.flatMap((grant) => {
      if (grant.whenState?.includes(id) !== true) return [grant]
      const whenState = grant.whenState.filter((state) => state !== id)
      // Never widen a grant: one that applied only in this state goes with it,
      // rather than losing its condition and applying always.
      return whenState.length === 0 ? [] : [{ ...grant, whenState }]
    })
  }
}

function removeTransition(document: DefinitionDocument, id: string): void {
  document.transitions = document.transitions.filter((one) => one.id !== id)
  for (const t of document.transitions) {
    if (t.onDeadline !== id) continue
    delete t.deadline
    delete t.onDeadline
  }
  if (document.links !== undefined) document.links = document.links.filter((link) => link.triggers !== id)
}
