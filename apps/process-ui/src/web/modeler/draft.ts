/**
 * The draft both tabs edit.
 *
 * One document, so switching between Diagram and JSON can never lose anything.
 * Commands go through `applyCommand` and onto the undo stack; a JSON-tab edit
 * replaces the document without one, because the text box already has undo.
 * `revision` is what a lint result is matched against: an answer for an older
 * revision is dropped (B6).
 */
import {
  applyCommand,
  bumpVersion,
  renameLayoutKeys,
  type Command,
  type CommandError,
  type DefinitionDocument,
  type DiagramLayout,
} from '@pilots/bpmn'

import type { DefinitionDiagnostic } from '../api.js'

export interface Snapshot {
  document: DefinitionDocument
  layout: DiagramLayout
}

export interface DraftState extends Snapshot {
  revision: number
  /** What made the last change — the JSON tab rewrites its text only when it was not itself. */
  origin: 'diagram' | 'json' | 'open'
  readOnly: boolean
  past: Snapshot[]
  future: Snapshot[]
  failure: { command: Command; error: CommandError } | null
  diagnostics: { revision: number; items: DefinitionDiagnostic[] }
}

export type DraftAction =
  | { type: 'command'; command: Command }
  | { type: 'move'; key: string; x: number; y: number }
  | {
      type: 'replace'
      document: DefinitionDocument
      origin: 'json' | 'open'
      readOnly?: boolean
      layout?: DiagramLayout
    }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'newVersion' }
  | { type: 'linted'; revision: number; diagnostics: DefinitionDiagnostic[] }
  | { type: 'dismiss' }

const HISTORY = 100

const READ_ONLY: CommandError = {
  code: 'not-allowed',
  message: 'This definition is published and never changes. Start a new version to edit it.',
}

export function initialDraft(snapshot: Snapshot): DraftState {
  return {
    ...snapshot,
    revision: 0,
    origin: 'open',
    readOnly: false,
    past: [],
    future: [],
    failure: null,
    diagnostics: { revision: -1, items: [] },
  }
}

const snap = (state: DraftState): Snapshot => ({ document: state.document, layout: state.layout })

export function draftReducer(state: DraftState, action: DraftAction): DraftState {
  switch (action.type) {
    case 'command': {
      if (state.readOnly) return { ...state, failure: { command: action.command, error: READ_ONLY } }
      const result = applyCommand(state.document, action.command)
      if (!result.ok) return { ...state, failure: { command: action.command, error: result.error } }
      const command = action.command
      const layout =
        command.type === 'rename'
          ? renameLayoutKeys(state.layout, command.kind, command.from, command.to)
          : state.layout
      return {
        ...state,
        document: result.document,
        layout,
        revision: state.revision + 1,
        origin: 'diagram',
        past: [...state.past, snap(state)].slice(-HISTORY),
        future: [],
        failure: null,
      }
    }
    // Positions only: not a change to the process, so no revision, no lint, no undo entry.
    case 'move':
      return { ...state, layout: { ...state.layout, [action.key]: { x: action.x, y: action.y } } }
    case 'replace': {
      const opening = action.origin === 'open'
      return {
        ...state,
        document: action.document,
        layout: action.layout ?? state.layout,
        readOnly: action.readOnly ?? false,
        origin: action.origin,
        revision: state.revision + 1,
        past: opening ? [] : state.past,
        future: opening ? [] : state.future,
        failure: null,
      }
    }
    case 'undo': {
      const previous = state.past.at(-1)
      if (previous === undefined || state.readOnly) return state
      return {
        ...state,
        ...previous,
        revision: state.revision + 1,
        origin: 'diagram',
        past: state.past.slice(0, -1),
        future: [snap(state), ...state.future],
        failure: null,
      }
    }
    case 'redo': {
      const next = state.future[0]
      if (next === undefined || state.readOnly) return state
      return {
        ...state,
        ...next,
        revision: state.revision + 1,
        origin: 'diagram',
        past: [...state.past, snap(state)],
        future: state.future.slice(1),
        failure: null,
      }
    }
    case 'newVersion': {
      if (!state.readOnly) return state
      const result = applyCommand(state.document, {
        type: 'setProcess',
        patch: { version: bumpVersion(state.document.version) },
      })
      if (!result.ok) return state
      return {
        ...state,
        document: result.document,
        readOnly: false,
        revision: state.revision + 1,
        origin: 'diagram',
        past: [],
        future: [],
        failure: null,
      }
    }
    case 'linted':
      return action.revision === state.revision
        ? { ...state, diagnostics: { revision: action.revision, items: action.diagnostics } }
        : state
    case 'dismiss':
      return { ...state, failure: null }
  }
}
