import type { DefinitionDocument } from '../document.js'
import { IDENTIFIER, RESERVED_TRANSITION } from './ids.js'
import type { CommandError, CommandResult, ElementKind } from './types.js'

export const done = (document: DefinitionDocument): CommandResult => ({ ok: true, document })
export const fail = (error: CommandError): CommandResult => ({ ok: false, error })
export const unknown = (kind: string, id: string): CommandError => ({
  code: 'unknown-reference',
  message: `there is no ${kind} called ${id}`,
})

export function idsOf(document: DefinitionDocument, kind: ElementKind): string[] {
  switch (kind) {
    case 'role':
      return document.roles.map((one) => one.id)
    case 'state':
      return document.states.map((one) => one.id)
    case 'transition':
      return document.transitions.map((one) => one.id)
  }
}

export function checkNewId(document: DefinitionDocument, kind: ElementKind, id: string): CommandError | null {
  if (!IDENTIFIER.test(id)) {
    return { code: 'invalid-id', message: `${JSON.stringify(id)} is not an identifier: a letter, then letters, digits, - or _` }
  }
  if (kind === 'transition' && id === RESERVED_TRANSITION) {
    return { code: 'reserved-id', message: '`create` is reserved: it is the event that starts every instance' }
  }
  if (idsOf(document, kind).includes(id)) {
    return { code: 'duplicate-id', message: `there is already a ${kind} called ${id}` }
  }
  return null
}

/** Copy a patch onto an element. A key set to `undefined` is removed, never written. */
export function assign(target: object, patch: object): void {
  const record = target as Record<string, unknown>
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete record[key]
    else record[key] = structuredClone(value)
  }
}
