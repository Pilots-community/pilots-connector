import { LANE_HEIGHT, toDiagram, withLayout, type DefinitionDocument } from '@pilots/bpmn'
import { describe, expect, it } from 'vitest'

import { laneChange, refOfKey, stateOfKey, toFlow } from '../src/web/modeler/flow.js'

const document: DefinitionDocument = {
  id: 'p',
  version: '1.0.0',
  kind: 'service',
  title: 'P',
  roles: [
    { id: 'alpha', title: 'Alpha' },
    { id: 'beta', title: 'Beta' },
  ],
  hostedBy: 'alpha',
  initialState: 'OPEN',
  states: [
    { id: 'OPEN', title: 'Open' },
    { id: 'DONE', title: 'Done', outcome: 'fulfilled' },
  ],
  data: { type: 'object' },
  transitions: [{ id: 'finish', title: 'Finish', from: ['OPEN'], to: 'DONE', by: ['alpha'] }],
}
const model = toDiagram(document)

describe('toFlow', () => {
  it('draws lanes behind the nodes, and flags what the linter named', () => {
    const flow = toFlow(model, withLayout(model), { flagged: new Set(['state:DONE']), readOnly: false })
    expect(flow.nodes.slice(0, 2).map((n) => n.id)).toEqual(['lane:alpha', 'lane:beta'])
    expect(flow.nodes.find((n) => n.id === 'lane:beta')?.position).toEqual({ x: 0, y: LANE_HEIGHT })
    expect(flow.nodes.find((n) => n.id === 'state:DONE')?.data).toMatchObject({ flagged: true })
  })

  it('locks every node of a read-only definition', () => {
    const flow = toFlow(model, withLayout(model), { flagged: new Set(), readOnly: true })
    expect(flow.nodes.every((n) => n.draggable === false)).toBe(true)
  })
})

describe('laneChange', () => {
  it('turns a task dropped in another lane into a change of role', () => {
    const task = model.nodes.find((n) => n.key === 'task:finish@alpha')!
    expect(laneChange(task, LANE_HEIGHT + 20, model)).toEqual({ transition: 'finish', fromRole: 'alpha', toRole: 'beta' })
    expect(laneChange(task, 20, model)).toBeNull()
    expect(laneChange(model.nodes.find((n) => n.key === 'state:OPEN')!, LANE_HEIGHT + 20, model)).toBeNull()
  })
})

describe('keys', () => {
  it('reads the state behind a state or gateway key, and the element behind any key', () => {
    expect(stateOfKey('state:OPEN')).toBe('OPEN')
    expect(stateOfKey('gateway:OPEN')).toBe('OPEN')
    expect(stateOfKey('task:finish@alpha')).toBeNull()
    expect(refOfKey(model, 'lane:beta')).toEqual({ kind: 'role', id: 'beta' })
    expect(refOfKey(model, 'task:finish@alpha')).toEqual({ kind: 'transition', id: 'finish' })
    expect(refOfKey(model, 'nothing')).toBeNull()
  })
})
