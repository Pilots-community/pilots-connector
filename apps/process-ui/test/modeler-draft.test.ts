/**
 * The draft: one document shared by the Diagram and JSON tabs, an undo stack,
 * and the rule that a lint result for an older revision is dropped — so a slow
 * linter never paints old errors over a newer drawing.
 */
import type { DefinitionDocument } from '@pilots/bpmn'
import { describe, expect, it } from 'vitest'

import { draftReducer, initialDraft, type DraftState } from '../src/web/modeler/draft.js'

const document: DefinitionDocument = {
  id: 'p',
  version: '1.0.0',
  kind: 'service',
  title: 'P',
  roles: [{ id: 'alpha', title: 'Alpha' }],
  hostedBy: 'alpha',
  initialState: 'OPEN',
  states: [
    { id: 'OPEN', title: 'Open' },
    { id: 'DONE', title: 'Done', outcome: 'fulfilled' },
  ],
  data: { type: 'object' },
  transitions: [{ id: 'finish', title: 'Finish', from: ['OPEN'], to: 'DONE', by: ['alpha'] }],
}

const fresh = (): DraftState => initialDraft({ document, layout: {} })
const rename: Parameters<typeof draftReducer>[1] = {
  type: 'command',
  command: { type: 'rename', kind: 'state', from: 'OPEN', to: 'READY' },
}

describe('draftReducer', () => {
  it('applies a command, bumps the revision and makes it undoable', () => {
    const after = draftReducer(fresh(), rename)
    expect(after.document.initialState).toBe('READY')
    expect(after.revision).toBe(1)
    expect(after.origin).toBe('diagram')
    const undone = draftReducer(after, { type: 'undo' })
    expect(undone.document.initialState).toBe('OPEN')
    expect(draftReducer(undone, { type: 'redo' }).document.initialState).toBe('READY')
  })

  it('carries the author’s positions through a rename', () => {
    const placed = draftReducer(fresh(), { type: 'move', key: 'state:OPEN', x: 5, y: 6 })
    expect(draftReducer(placed, rename).layout).toEqual({ 'state:READY': { x: 5, y: 6 } })
  })

  it('keeps a refused command’s error and leaves the document alone', () => {
    const after = draftReducer(fresh(), { type: 'command', command: { type: 'remove', kind: 'state', id: 'OPEN' } })
    expect(after.document).toBe(document)
    expect(after.failure?.error.code).toBe('not-allowed')
    expect(draftReducer(after, { type: 'dismiss' }).failure).toBeNull()
  })

  it('drops a lint result for a revision that is no longer on screen', () => {
    const after = draftReducer(fresh(), rename)
    const stale = draftReducer(after, { type: 'linted', revision: 0, diagnostics: [{ severity: 'error', code: 'x', message: 'old' }] })
    expect(stale.diagnostics.items).toEqual([])
    const current = draftReducer(after, { type: 'linted', revision: 1, diagnostics: [] })
    expect(current.diagnostics.revision).toBe(1)
  })

  it('refuses commands on a published definition until a new version is started', () => {
    const opened = draftReducer(fresh(), { type: 'replace', document, readOnly: true, origin: 'open' })
    expect(draftReducer(opened, rename).failure?.error.code).toBe('not-allowed')
    const next = draftReducer(opened, { type: 'newVersion' })
    expect(next.readOnly).toBe(false)
    expect(next.document.version).toBe('1.0.1')
  })

  it('does not put JSON-tab edits on the undo stack — the text box has its own', () => {
    const typed = draftReducer(fresh(), { type: 'replace', document: { ...document, title: 'Typed' }, origin: 'json' })
    expect(typed.past).toEqual([])
    expect(typed.origin).toBe('json')
  })
})
