/** RFC 6901 JSON Pointers — how the linter names a place, and how the Advanced tab edits one. */
import type { JsonValue } from '@pilots/protocol'

import type { DefinitionDocument } from '../document.js'
import type { ElementRef } from '../model.js'
import { done, fail } from './checks.js'
import type { CommandResult } from './types.js'

export function parsePointer(pointer: string): string[] | null {
  if (pointer === '') return []
  if (!pointer.startsWith('/')) return null
  return pointer
    .slice(1)
    .split('/')
    .map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'))
}

function step(value: unknown, segment: string): unknown {
  if (Array.isArray(value)) return value[Number(segment)]
  if (value !== null && typeof value === 'object') return (value as Record<string, unknown>)[segment]
  return undefined
}

export function getPointer(document: unknown, pointer: string): unknown {
  const segments = parsePointer(pointer)
  if (segments === null) return undefined
  return segments.reduce(step, document)
}

/** Set (or, with `undefined`, remove) the value at a pointer. Mutates `document`: callers pass a clone. */
export function setPointer(
  document: DefinitionDocument,
  pointer: string,
  value: JsonValue | undefined,
): CommandResult {
  const invalid = fail({ code: 'invalid-pointer', message: `${pointer} does not point inside the document` })
  const segments = parsePointer(pointer)
  if (segments === null || segments.length === 0) return invalid
  const last = segments[segments.length - 1]!
  const parent = segments.slice(0, -1).reduce<unknown>(step, document)

  if (Array.isArray(parent)) {
    const index = last === '-' ? parent.length : Number(last)
    if (!Number.isInteger(index) || index < 0 || index > parent.length) return invalid
    if (value === undefined) parent.splice(index, 1)
    else parent[index] = structuredClone(value)
    return done(document)
  }
  if (parent !== null && typeof parent === 'object') {
    const record = parent as Record<string, unknown>
    if (value === undefined) delete record[last]
    else record[last] = structuredClone(value)
    return done(document)
  }
  return invalid
}

/** Where an element lives in the document — what the Advanced tab edits. */
export function pointerOf(document: DefinitionDocument, ref: ElementRef): string | null {
  switch (ref.kind) {
    case 'role': {
      const index = document.roles.findIndex((one) => one.id === ref.id)
      return index < 0 ? null : `/roles/${index}`
    }
    case 'state': {
      const index = document.states.findIndex((one) => one.id === ref.id)
      return index < 0 ? null : `/states/${index}`
    }
    case 'transition': {
      const index = document.transitions.findIndex((one) => one.id === ref.id)
      return index < 0 ? null : `/transitions/${index}`
    }
    case 'link':
      return ref.index < (document.links ?? []).length ? `/links/${ref.index}` : null
  }
}
