import { describe, expect, it } from 'vitest'

import { canReadPath, filterData, filterInstance, filterPayload } from '../src/engine/visibility.js'
import { ProcessDefinition } from '../src/schemas/definition.js'
import type { Instance } from '../src/schemas/instance.js'
import { shipped } from './helpers/definitions.js'

const weighing = shipped('container-weighing.json')
const AT = '2026-08-24T09:14:02.000Z'

const fullData = {
  containerNumber: 'MSCU1234567',
  terminal: '869',
  truckPlate: '1-ABC-123',
  grossMass: { value: 24000, unit: 'kg', measuredAt: AT },
  paymentReference: 'PAY-1',
  certificate: { sha256: `sha256:${'a'.repeat(64)}`, issuedAt: AT },
}

function weighingInstance(state: string): Instance {
  return {
    id: '01J0000000000000000000000A',
    kind: 'service',
    definition: 'container-weighing@1.0.0',
    participants: { shipper: 'did:web:org-a.example', weigher: 'did:web:org-b.example' },
    quotationId: null,
    offering: null,
    state,
    seq: 4,
    data: fullData,
    createdAt: AT,
    updatedAt: AT,
  }
}

describe('the withheld gross mass — the rule S1 exists to demonstrate', () => {
  it('hides grossMass from the shipper before payment', () => {
    const seen = filterData(weighing, fullData, ['shipper'], 'WEIGHED')
    expect(seen.value).not.toHaveProperty('grossMass')
    expect(seen.redacted).toBe(true)
    // The rest of the document is untouched: this is field-level, not all-or-nothing.
    expect(seen.value.containerNumber).toBe('MSCU1234567')
    expect(seen.value.truckPlate).toBe('1-ABC-123')
  })

  it('releases grossMass to the shipper once payment is recorded', () => {
    const seen = filterData(weighing, fullData, ['shipper'], 'PAID')
    expect(seen.value.grossMass).toEqual(fullData.grossMass)
  })

  it('keeps it visible in VGM_ISSUED too, because the grant lists both states', () => {
    expect(filterData(weighing, fullData, ['shipper'], 'VGM_ISSUED').value.grossMass).toBeDefined()
  })

  it('shows grossMass to the weigher in every state', () => {
    for (const state of ['TRUCK_ANNOUNCED', 'WEIGHED', 'PAID', 'VGM_ISSUED']) {
      expect(filterData(weighing, fullData, ['weigher'], state).value.grossMass).toBeDefined()
    }
  })

  it('never shows the payment reference to the shipper', () => {
    for (const state of ['WEIGHED', 'PAID', 'VGM_ISSUED']) {
      expect(filterData(weighing, fullData, ['shipper'], state).value).not.toHaveProperty(
        'paymentReference',
      )
    }
  })

  it('withholds the certificate from the shipper until it is issued', () => {
    expect(filterData(weighing, fullData, ['shipper'], 'PAID').value).not.toHaveProperty(
      'certificate',
    )
    expect(
      filterData(weighing, fullData, ['shipper'], 'VGM_ISSUED').value.certificate,
    ).toBeDefined()
  })

  it('leaves ungranted paths readable, because defaultVisibility is "all"', () => {
    const seen = filterData(weighing, fullData, ['shipper'], 'ORDERED')
    expect(seen.value.containerNumber).toBe('MSCU1234567')
    expect(seen.value.terminal).toBe('869')
  })

  it('reports nothing redacted when the viewer may see everything', () => {
    expect(filterData(weighing, fullData, ['weigher'], 'VGM_ISSUED').redacted).toBe(false)
  })
})

describe('canReadPath', () => {
  it('answers the same question the filter answers', () => {
    expect(canReadPath(weighing, 'grossMass', ['shipper'], 'WEIGHED')).toBe(false)
    expect(canReadPath(weighing, 'grossMass', ['shipper'], 'PAID')).toBe(true)
    expect(canReadPath(weighing, 'grossMass', ['weigher'], 'WEIGHED')).toBe(true)
    expect(canReadPath(weighing, 'containerNumber', ['shipper'], 'ORDERED')).toBe(true)
  })

  it('covers the whole subtree beneath a granted path', () => {
    expect(canReadPath(weighing, 'grossMass.value', ['shipper'], 'WEIGHED')).toBe(false)
    expect(canReadPath(weighing, 'grossMass.value', ['shipper'], 'PAID')).toBe(true)
  })
})

describe('defaultVisibility: "none"', () => {
  const secretive = ProcessDefinition.parse({
    id: 'secretive',
    version: '1.0.0',
    kind: 'service',
    title: 'Withholding is the norm here',
    roles: [
      { id: 'a', title: 'A' },
      { id: 'b', title: 'B' },
    ],
    hostedBy: 'a',
    initialState: 'OPEN',
    states: [
      { id: 'OPEN', title: 'Open' },
      { id: 'DONE', title: 'Done', outcome: 'fulfilled' },
    ],
    defaultVisibility: 'none',
    data: { type: 'object' },
    transitions: [{ id: 'finish', title: 'Finish', from: ['OPEN'], to: 'DONE', by: ['a'] }],
    visibility: [
      { path: 'shared', roles: ['a', 'b'] },
      { path: 'deep.granted', roles: ['b'] },
    ],
  })

  const data = {
    shared: 'yes',
    private: 'no',
    deep: { granted: 'yes', withheld: 'no' },
  }

  it('withholds everything without a grant', () => {
    const seen = filterData(secretive, data, ['b'], 'OPEN').value
    expect(seen).toEqual({ shared: 'yes', deep: { granted: 'yes' } })
  })

  it('reaches a granted leaf through an ungranted container', () => {
    expect(filterData(secretive, data, ['b'], 'OPEN').value.deep).toEqual({ granted: 'yes' })
  })

  it('drops the container entirely when nothing beneath it is granted', () => {
    expect(filterData(secretive, data, ['a'], 'OPEN').value).toEqual({ shared: 'yes' })
  })
})

describe('nested grants below a visible container', () => {
  const nested = ProcessDefinition.parse({
    id: 'nested',
    version: '1.0.0',
    kind: 'service',
    title: 'Nested',
    roles: [
      { id: 'a', title: 'A' },
      { id: 'b', title: 'B' },
    ],
    hostedBy: 'a',
    initialState: 'OPEN',
    states: [
      { id: 'OPEN', title: 'Open' },
      { id: 'DONE', title: 'Done', outcome: 'fulfilled' },
    ],
    data: { type: 'object' },
    transitions: [{ id: 'finish', title: 'Finish', from: ['OPEN'], to: 'DONE', by: ['a'] }],
    visibility: [{ path: 'offer.margin', roles: ['a'] }],
  })

  it('keeps the container and removes only the granted-away leaf', () => {
    const data = { offer: { price: 100, margin: 12 }, other: true }
    expect(filterData(nested, data, ['b'], 'OPEN').value).toEqual({
      offer: { price: 100 },
      other: true,
    })
    expect(filterData(nested, data, ['a'], 'OPEN').value).toEqual(data)
  })

  it('treats an array as one value and never indexes into it', () => {
    const data = { offer: [{ margin: 1 }], other: true }
    expect(filterData(nested, data, ['b'], 'OPEN').value).toEqual(data)
  })
})

describe('filterInstance', () => {
  it('filters the data document and leaves the envelope alone', () => {
    const instance = weighingInstance('WEIGHED')
    const filtered = filterInstance(weighing, instance, ['shipper'])
    expect(filtered.instance.data).not.toHaveProperty('grossMass')
    expect(filtered.instance.seq).toBe(4)
    expect(filtered.instance.state).toBe('WEIGHED')
    expect(filtered.instance.participants).toEqual(instance.participants)
    expect(filtered.redacted).toBe(true)
  })

  it('does not mutate the instance it was given', () => {
    const instance = weighingInstance('WEIGHED')
    filterInstance(weighing, instance, ['shipper'])
    expect(instance.data).toEqual(fullData)
  })
})

describe('filterPayload — the same rule applied to an event', () => {
  const weighPayload = { grossMass: { value: 24000, unit: 'kg', measuredAt: AT } }

  it('withholds a field the reader could not have read from the instance', () => {
    const filtered = filterPayload(weighing, weighPayload, ['shipper'], 'WEIGHED')
    // Withheld in full, so `null` rather than `{}`. That is what keeps total
    // withholding detectable from the header alone: `payloadHash` is not the
    // hash of the empty object. See docs/PROTOCOL.md §7.3.
    expect(filtered.value).toBeNull()
    expect(filtered.redacted).toBe(true)
  })

  it('releases the same stored payload later, filtered against the newer state', () => {
    const filtered = filterPayload(weighing, weighPayload, ['shipper'], 'PAID')
    expect(filtered.value).toEqual(weighPayload)
    expect(filtered.redacted).toBe(false)
  })

  it('passes a null payload through untouched', () => {
    expect(filterPayload(weighing, null, ['shipper'], 'WEIGHED')).toEqual({
      value: null,
      redacted: false,
    })
  })
})
