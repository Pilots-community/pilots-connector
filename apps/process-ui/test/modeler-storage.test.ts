import { describe, expect, it } from 'vitest'

import { loadDraft, loadLayout, saveDraft, saveLayout } from '../src/web/modeler/storage.js'

function memory(): Pick<Storage, 'getItem' | 'setItem'> {
  const map = new Map<string, string>()
  return { getItem: (key) => map.get(key) ?? null, setItem: (key, value) => void map.set(key, value) }
}

const broken: Pick<Storage, 'getItem' | 'setItem'> = {
  getItem: () => {
    throw new Error('blocked')
  },
  setItem: () => {
    throw new Error('blocked')
  },
}

describe('draft storage', () => {
  it('round-trips a draft and a layout per definition', () => {
    const store = memory()
    const document = { id: 'p', roles: [], states: [], transitions: [] } as never
    const snapshot = { document, layout: { 'state:A': { x: 1, y: 2 } } }
    expect(saveDraft(store, snapshot)).toBe(true)
    expect(loadDraft(store)).toEqual(snapshot)
    expect(saveLayout(store, 'p@1.0.0', snapshot.layout)).toBe(true)
    expect(loadLayout(store, 'p@1.0.0')).toEqual(snapshot.layout)
  })

  it('degrades to nothing, never to an exception, when storage is blocked or garbage', () => {
    expect(loadDraft(broken)).toBeNull()
    expect(saveDraft(broken, { document: {} as never, layout: {} })).toBe(false)
    expect(loadLayout(broken, 'p@1.0.0')).toEqual({})
    const store = memory()
    store.setItem('pilots.modeler.draft', '{not json')
    expect(loadDraft(store)).toBeNull()
    expect(loadDraft(null)).toBeNull()
  })

  it('drops a stored draft the canvas cannot draw, so the editor starts from the starter', () => {
    const store = memory()
    store.setItem('pilots.modeler.draft', JSON.stringify({ document: {}, layout: {} }))
    expect(loadDraft(store)).toBeNull()
    const halfTyped = { id: 'p', roles: [], states: [], transitions: [{ id: 't', title: 'T', by: [] }] }
    store.setItem('pilots.modeler.draft', JSON.stringify({ document: halfTyped, layout: {} }))
    expect(loadDraft(store)).toBeNull()
    store.setItem('pilots.modeler.draft', JSON.stringify({ document: { ...halfTyped, roles: {} }, layout: {} }))
    expect(loadDraft(store)).toBeNull()
  })
})
