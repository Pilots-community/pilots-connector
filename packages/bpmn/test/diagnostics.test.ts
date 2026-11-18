/**
 * The linter puts a JSON Pointer on every diagnostic (M6.5 designed it so); this
 * turns one into the thing on the canvas to outline. Tested against the real
 * linter, so a change to its pointers cannot silently stop the outlining.
 */
import { lintDefinition } from '@pilots/protocol'
import { describe, expect, it } from 'vitest'

import { targetOf } from '../src/diagnostics.js'
import { toDiagram } from '../src/project.js'
import { small } from './helpers/small.js'

describe('targetOf', () => {
  it('points at a state the linter names', () => {
    const document = small()
    document.states.push({ id: 'ISLAND', title: 'Island' })
    const model = toDiagram(document)
    const unreachable = lintDefinition(document).diagnostics.find((d) => d.path === '/states/3')
    expect(unreachable).toBeDefined()
    expect(targetOf(document, model, unreachable?.path)).toEqual({ kind: 'node', key: 'state:ISLAND' })
  })

  it('points at the first drawing of a transition, a lane for a role, a message for a link', () => {
    const document = small()
    document.links = [{ onEvent: 'quotation:AGREED', triggers: 'finish' }]
    const model = toDiagram(document)
    expect(targetOf(document, model, '/transitions/0/to')).toEqual({ kind: 'node', key: 'task:finish@beta' })
    expect(targetOf(document, model, '/roles/1')).toEqual({ kind: 'lane', key: 'lane:beta' })
    expect(targetOf(document, model, '/links/0/triggers')).toEqual({ kind: 'node', key: 'message:finish#0' })
  })

  it('falls back to the process for anything else', () => {
    const model = toDiagram(small())
    expect(targetOf(small(), model, '/hostedBy')).toEqual({ kind: 'process' })
    expect(targetOf(small(), model, undefined)).toEqual({ kind: 'process' })
    expect(targetOf(small(), model, '/states/99')).toEqual({ kind: 'process' })
  })
})
