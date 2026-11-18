/**
 * Drafts live in the browser, never in the connector — it holds published
 * definitions only (the F-series "no drafts" decision). Every access is
 * guarded: a private window or blocked site data must cost the author their
 * draft on reload, not the editor.
 */
import { isDrawable, type DiagramLayout } from '@pilots/bpmn'

import type { Snapshot } from './draft.js'

type Store = Pick<Storage, 'getItem' | 'setItem'>

const DRAFT = 'pilots.modeler.draft'
const layoutKey = (ref: string): string => `pilots.modeler.layout:${ref}`

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** `null` when the browser will not let us store anything. */
export function browserStorage(): Storage | null {
  try {
    const store = globalThis.localStorage
    store.setItem('pilots.modeler.probe', '1')
    store.removeItem('pilots.modeler.probe')
    return store
  } catch {
    return null
  }
}

export function loadDraft(store: Store | null): Snapshot | null {
  if (store === null) return null
  try {
    const raw = store.getItem(DRAFT)
    if (raw === null) return null
    const value: unknown = JSON.parse(raw)
    // A draft the canvas cannot draw would blank the page on load: start over instead.
    if (!isRecord(value) || !isDrawable(value['document'])) return null
    return {
      document: value['document'],
      layout: isRecord(value['layout']) ? (value['layout'] as DiagramLayout) : {},
    }
  } catch {
    return null
  }
}

export function saveDraft(store: Store, snapshot: Snapshot): boolean {
  try {
    store.setItem(DRAFT, JSON.stringify(snapshot))
    return true
  } catch {
    return false
  }
}

/** The author's layout for a published definition, so reopening it here shows their drawing. */
export function loadLayout(store: Store, ref: string): DiagramLayout {
  try {
    const raw = store.getItem(layoutKey(ref))
    const value: unknown = raw === null ? null : JSON.parse(raw)
    return isRecord(value) ? (value as DiagramLayout) : {}
  } catch {
    return {}
  }
}

export function saveLayout(store: Store, ref: string, layout: DiagramLayout): boolean {
  try {
    store.setItem(layoutKey(ref), JSON.stringify(layout))
    return true
  } catch {
    return false
  }
}
