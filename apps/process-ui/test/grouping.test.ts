/**
 * Where a row goes, from what the connector already computed.
 *
 * `available` answers "is it my turn" and `outcome` answers "is it over" — both
 * worked out from the definition by the connector. The UI gets no second
 * opinion about either; it only decides which heading the row sits under.
 */
import { describe, expect, it } from 'vitest'

import type { InstanceView } from '../src/web/api.js'
import { groupInstances } from '../src/web/views/grouping.js'

function instance(over: Partial<InstanceView>): InstanceView {
  return {
    id: '01J',
    kind: 'service',
    definition: 'container-weighing@1.0.0',
    participants: {},
    quotationId: null,
    offering: null,
    state: 'ORDERED',
    seq: 1,
    data: {},
    createdAt: '2026-08-24T09:00:00.000Z',
    updatedAt: '2026-08-24T09:00:00.000Z',
    home: false,
    available: [],
    redacted: false,
    outcome: 'running',
    ...over,
  }
}

describe('grouping a process list', () => {
  it('puts an instance with an available transition under "your turn"', () => {
    const one = instance({ available: [{ transition: 'announceTruck', role: 'shipper' }] })
    expect(groupInstances([one]).yours).toEqual([one])
  })

  it('puts a live instance with nothing to do under "waiting"', () => {
    const one = instance({ state: 'TRUCK_ANNOUNCED' })
    expect(groupInstances([one]).waiting).toEqual([one])
  })

  it('puts a finished instance under "done", however it finished', () => {
    // Both endings belong in the same bucket, and neither needs a state name:
    // the connector already said whether the process is over.
    const good = instance({ id: 'a', state: 'VGM_ISSUED', outcome: 'fulfilled' })
    const bad = instance({ id: 'b', state: 'CANCELLED', outcome: 'abandoned' })

    const done = groupInstances([good, bad]).done.map((one) => one.id)
    expect(done.sort()).toEqual(['a', 'b'])
  })

  it('counts a finished instance as done even if a transition is somehow offered', () => {
    // Being over wins. A stale `available` must never resurrect a row into
    // "your turn" and invite somebody to act on a closed process.
    const one = instance({
      state: 'VGM_ISSUED',
      outcome: 'fulfilled',
      available: [{ transition: 'cancel', role: 'shipper' }],
    })
    expect(groupInstances([one]).done).toEqual([one])
    expect(groupInstances([one]).yours).toEqual([])
  })

  it('orders each group by most recently updated first', () => {
    const older = instance({ id: 'a', updatedAt: '2026-08-24T09:00:00.000Z' })
    const newer = instance({ id: 'b', updatedAt: '2026-08-24T10:00:00.000Z' })
    expect(groupInstances([older, newer]).waiting.map((one) => one.id)).toEqual(['b', 'a'])
  })

  it('separates quotations from the services they authorise', () => {
    // A quotation is an instance like any other, and reads as clutter beside
    // the transport it is negotiating. Splitting them is presentation, not a
    // second notion of what an instance is.
    const quotation = instance({ id: 'q', kind: 'quotation' })
    const service = instance({ id: 's', kind: 'service' })
    const grouped = groupInstances([quotation, service])

    expect(grouped.quotations.map((one) => one.id)).toEqual(['q'])
    expect(grouped.waiting.map((one) => one.id)).toEqual(['s'])
  })
})
