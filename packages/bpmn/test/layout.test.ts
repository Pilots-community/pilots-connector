import { describe, expect, it } from 'vitest'

import { LANE_HEIGHT, autoLayout, laneAt, renameLayoutKeys, withLayout } from '../src/layout.js'
import { toDiagram } from '../src/project.js'
import { examples } from './helpers/examples.js'
import { small } from './helpers/small.js'

describe('autoLayout', () => {
  it.each(examples())('places every node of $name', ({ document }) => {
    const model = toDiagram(document)
    const layout = autoLayout(model)
    for (const node of model.nodes) expect(layout[node.key], node.key).toBeDefined()
  })

  it('puts a task inside its own lane', () => {
    const model = toDiagram(small())
    const layout = autoLayout(model)
    const beta = model.lanes.findIndex((lane) => lane.roleId === 'beta')
    const y = layout['task:finish@beta']!.y
    expect(y).toBeGreaterThanOrEqual(beta * LANE_HEIGHT)
    expect(y).toBeLessThan((beta + 1) * LANE_HEIGHT)
  })

  it('starts on the left and moves right along the flow', () => {
    const layout = autoLayout(toDiagram(small()))
    expect(layout['state:OPEN']!.x).toBeLessThan(layout['task:finish@beta']!.x)
    expect(layout['task:finish@beta']!.x).toBeLessThan(layout['state:DONE']!.x)
  })
})

describe('withLayout', () => {
  it('keeps what the author placed and fills in the rest', () => {
    const model = toDiagram(small())
    const layout = withLayout(model, { 'state:OPEN': { x: 7, y: 9 }, 'state:GONE': { x: 1, y: 1 } })
    expect(layout['state:OPEN']).toEqual({ x: 7, y: 9 })
    expect(layout['state:GONE']).toBeUndefined()
    expect(layout['state:DONE']).toEqual(autoLayout(model)['state:DONE'])
  })
})

describe('laneAt', () => {
  it('names the role whose lane a height falls in, or nothing below the last', () => {
    const model = toDiagram(small())
    expect(laneAt(model, 10)).toBe('alpha')
    expect(laneAt(model, LANE_HEIGHT + 10)).toBe('beta')
    expect(laneAt(model, 5 * LANE_HEIGHT)).toBeNull()
  })
})

describe('renameLayoutKeys', () => {
  const layout = {
    'lane:beta': { x: 0, y: 0 },
    'task:finish@beta': { x: 1, y: 1 },
    'state:OPEN': { x: 2, y: 2 },
    'gateway:OPEN': { x: 3, y: 3 },
    'timer:finish': { x: 4, y: 4 },
    'message:finish#0': { x: 5, y: 5 },
    'task:finishing@alpha': { x: 6, y: 6 },
  }

  it('follows a role', () => {
    const next = renameLayoutKeys(layout, 'role', 'beta', 'gamma')
    expect(next['lane:gamma']).toEqual({ x: 0, y: 0 })
    expect(next['task:finish@gamma']).toEqual({ x: 1, y: 1 })
  })

  it('follows a state and its gateway', () => {
    const next = renameLayoutKeys(layout, 'state', 'OPEN', 'READY')
    expect(next['state:READY']).toEqual({ x: 2, y: 2 })
    expect(next['gateway:READY']).toEqual({ x: 3, y: 3 })
  })

  it('follows a transition and leaves one that merely starts with the same letters', () => {
    const next = renameLayoutKeys(layout, 'transition', 'finish', 'close')
    expect(next['task:close@beta']).toEqual({ x: 1, y: 1 })
    expect(next['timer:close']).toEqual({ x: 4, y: 4 })
    expect(next['message:close#0']).toEqual({ x: 5, y: 5 })
    expect(next['task:finishing@alpha']).toEqual({ x: 6, y: 6 })
  })
})
