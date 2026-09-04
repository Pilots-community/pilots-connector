/**
 * The picture is derived from the definition, so a new process needs no UI
 * work. These tests are the guard on that claim.
 *
 * Two rules carry their own history. The lane a state is drawn in is
 * **declared** by its `outcome`, after an earlier draft tried to infer it from
 * the graph's shape and got the quotation definition wrong. And a wildcard
 * transition is one edge, not one per source state.
 */
import { readFile, readdir } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

import type { ProcessDefinition, SignedEvent } from '../src/web/api.js'
import { ANY_STATE_NODE, toGraph } from '../src/web/graph/to-graph.js'

const WEIGHING: ProcessDefinition = {
  id: 'container-weighing',
  version: '1.0.0',
  kind: 'service',
  title: 'Container weighing',
  roles: [
    { id: 'shipper', title: 'Shipper' },
    { id: 'weigher', title: 'Weighing company' },
  ],
  hostedBy: 'weigher',
  initialState: 'ORDERED',
  states: [
    { id: 'ORDERED', title: 'Ordered' },
    { id: 'TRUCK_ANNOUNCED', title: 'Truck announced' },
    { id: 'WEIGHED', title: 'Weighed' },
    { id: 'PAID', title: 'Paid' },
    { id: 'VGM_ISSUED', title: 'VGM issued', outcome: 'fulfilled' },
    { id: 'CANCELLED', title: 'Cancelled', outcome: 'abandoned' },
  ],
  data: {},
  transitions: [
    {
      id: 'announceTruck',
      title: 'Announce truck',
      from: ['ORDERED'],
      to: 'TRUCK_ANNOUNCED',
      by: ['shipper'],
    },
    { id: 'weigh', title: 'Weigh', from: ['TRUCK_ANNOUNCED'], to: 'WEIGHED', by: ['weigher'] },
    {
      id: 'recordPayment',
      title: 'Record payment',
      from: ['WEIGHED'],
      to: 'PAID',
      by: ['weigher'],
    },
    { id: 'issueVgm', title: 'Issue VGM', from: ['PAID'], to: 'VGM_ISSUED', by: ['weigher'] },
    {
      id: 'cancel',
      title: 'Cancel',
      from: ['*'],
      to: 'CANCELLED',
      by: ['shipper', 'weigher'],
    },
  ],
}

function event(seq: number, transition: string, from: string | null, to: string): SignedEvent {
  return {
    header: {
      instance: '01J',
      seq,
      transition,
      actor: 'did:web:org-a.example',
      from,
      to,
      at: '2026-08-24T09:00:00.000Z',
      prev: null,
      payloadHash: '',
      genesis: '',
      cause: null,
      attachments: [],
    },
    payload: null,
    redacted: false,
    sig: '',
  }
}

describe('layering', () => {
  it('lays the happy path out left to right from the initial state', () => {
    const { nodes } = toGraph(WEIGHING)
    const layer = (id: string): number | undefined => nodes.find((n) => n.id === id)?.layer

    expect(layer('ORDERED')).toBe(0)
    expect(layer('TRUCK_ANNOUNCED')).toBe(1)
    expect(layer('WEIGHED')).toBe(2)
    expect(layer('PAID')).toBe(3)
    expect(layer('VGM_ISSUED')).toBe(4)
  })

  it('does not let a wildcard drag an abort state into the middle of the path', () => {
    // `cancel` reaches CANCELLED from everywhere. If layering followed it,
    // CANCELLED would land at layer 1 and sit in the middle of the happy path.
    const { nodes } = toGraph(WEIGHING)
    expect(nodes.find((n) => n.id === 'CANCELLED')?.layer).toBeGreaterThan(1)
  })
})

describe('the off-path lane', () => {
  it('puts an abandoned ending below and leaves the fulfilled one on the main line', () => {
    const { nodes } = toGraph(WEIGHING)
    const lane = (id: string): string | undefined => nodes.find((n) => n.id === id)?.lane

    // Both are endings; only one is a good one, and the definition says which.
    expect(lane('CANCELLED')).toBe('off-path')
    expect(lane('VGM_ISSUED')).toBe('main')
    expect(nodes.find((n) => n.id === 'VGM_ISSUED')?.terminal).toBe(true)
    expect(nodes.find((n) => n.id === 'ORDERED')?.terminal).toBe(false)
  })
})

describe('wildcard transitions', () => {
  it('draws one edge from an any-state marker rather than one per source', () => {
    const { nodes, edges } = toGraph(WEIGHING)
    const cancels = edges.filter((e) => e.transition === 'cancel')

    // Expanded, `cancel` would be four edges here — every non-terminal state.
    expect(cancels).toHaveLength(1)
    expect(cancels[0]?.source).toBe(ANY_STATE_NODE)
    expect(cancels[0]?.wildcard).toBe(true)
    expect(nodes.find((n) => n.id === ANY_STATE_NODE)?.kind).toBe('any-state')
  })

  it('omits the any-state marker when a definition has no wildcard transition', () => {
    const linear: ProcessDefinition = {
      ...WEIGHING,
      states: WEIGHING.states.filter((s) => s.id !== 'CANCELLED'),
      transitions: WEIGHING.transitions.filter((t) => t.id !== 'cancel'),
    }
    expect(toGraph(linear).nodes.some((n) => n.kind === 'any-state')).toBe(false)
  })
})

describe('the path taken', () => {
  it('marks the states reached, the edges traversed and where you are now', () => {
    const history = [
      event(1, 'create', null, 'ORDERED'),
      event(2, 'announceTruck', 'ORDERED', 'TRUCK_ANNOUNCED'),
      event(3, 'weigh', 'TRUCK_ANNOUNCED', 'WEIGHED'),
    ]
    const { nodes, edges } = toGraph(WEIGHING, { history, current: 'WEIGHED' })

    expect(nodes.find((n) => n.id === 'ORDERED')?.reached).toBe(true)
    expect(nodes.find((n) => n.id === 'WEIGHED')?.current).toBe(true)
    expect(nodes.find((n) => n.id === 'PAID')?.reached).toBe(false)

    expect(edges.find((e) => e.transition === 'weigh')?.taken).toBe(true)
    expect(edges.find((e) => e.transition === 'issueVgm')?.taken).toBe(false)
  })

  it('is a map with nothing walked when there is no history', () => {
    const { nodes, edges } = toGraph(WEIGHING)
    expect(nodes.every((n) => !n.reached)).toBe(true)
    expect(edges.every((e) => !e.taken)).toBe(true)
  })
})

describe('roles', () => {
  it('carries who may fire each transition, so the picture can say whose turn it is', () => {
    const { edges } = toGraph(WEIGHING)
    expect(edges.find((e) => e.transition === 'weigh')?.by).toEqual(['weigher'])
  })
})

describe('every committed definition', () => {
  it('produces a graph with no orphan edges and exactly one initial state', async () => {
    const dir = new URL('../../../docs/definitions/', import.meta.url)
    for (const file of await readdir(dir)) {
      if (!file.endsWith('.json')) continue
      const definition = JSON.parse(await readFile(new URL(file, dir), 'utf8')) as ProcessDefinition
      const { nodes, edges } = toGraph(definition)
      const ids = new Set(nodes.map((n) => n.id))

      for (const edge of edges) {
        expect(ids, `${file}: ${edge.id} source`).toContain(edge.source)
        expect(ids, `${file}: ${edge.id} target`).toContain(edge.target)
      }
      expect(
        nodes.filter((n) => n.kind === 'state' && n.layer === 0),
        file,
      ).toHaveLength(1)
      // Every definition ends somewhere, and says how.
      expect(
        nodes.some((n) => n.terminal),
        file,
      ).toBe(true)
    }
  })
})
