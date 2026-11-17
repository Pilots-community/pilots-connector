/**
 * Every edit the editor can make, as data.
 *
 * A patch key set to `undefined` removes that key. `rename` and `remove` cascade
 * through every reference so a draft never holds a dangling one; `setFragment`
 * is the Advanced tab's escape hatch and is judged by the linter, not here.
 */
import type { JsonValue } from '@pilots/protocol'

import type {
  DefinitionDocument,
  LinkDocument,
  RoleDocument,
  StateDocument,
  TransitionDocument,
} from '../document.js'

export type ElementKind = 'role' | 'state' | 'transition'

export type ProcessPatch = Partial<Omit<DefinitionDocument, 'roles' | 'states' | 'transitions' | 'links'>>

export type Command =
  | { type: 'setProcess'; patch: ProcessPatch }
  | { type: 'addRole'; role: RoleDocument }
  | { type: 'updateRole'; id: string; patch: Partial<Omit<RoleDocument, 'id'>> }
  | { type: 'addState'; state: StateDocument }
  | { type: 'updateState'; id: string; patch: Partial<Omit<StateDocument, 'id'>> }
  | { type: 'addTransition'; transition: TransitionDocument }
  | { type: 'updateTransition'; id: string; patch: Partial<Omit<TransitionDocument, 'id'>> }
  | { type: 'moveTask'; transition: string; fromRole: string; toRole: string }
  | { type: 'setDeadline'; transition: string; deadline: string; onDeadline: string }
  | { type: 'clearDeadline'; transition: string }
  | { type: 'addLink'; link: LinkDocument }
  | { type: 'removeLink'; index: number }
  | { type: 'rename'; kind: ElementKind; from: string; to: string }
  | { type: 'remove'; kind: ElementKind; id: string; cascade?: boolean }
  | { type: 'setFragment'; pointer: string; value: JsonValue | undefined }

export type CommandErrorCode =
  | 'invalid-id'
  | 'reserved-id'
  | 'duplicate-id'
  | 'unknown-reference'
  | 'has-dependents'
  | 'not-allowed'
  | 'invalid-pointer'

export interface CommandError {
  code: CommandErrorCode
  message: string
  /** For `has-dependents`: what still refers to the element, in words. */
  dependents?: string[]
}

export type CommandResult =
  | { ok: true; document: DefinitionDocument }
  | { ok: false; error: CommandError }
