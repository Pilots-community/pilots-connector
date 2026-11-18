/**
 * A process drawn in the editor runs on an unmodified connector.
 *
 * The definition here is never written by hand: it is built gesture by gesture
 * from `@pilots/bpmn` commands — add a lane, add states, draw tasks, drag one to
 * another lane, put a deadline on it — then published by Org A, adopted by
 * Org B, and run to a fulfilled ending across both connectors. If the editor
 * could produce something the connector cannot run, this is where it shows.
 */
import { applyCommand, setField, type Command, type DefinitionDocument } from '@pilots/bpmn'
import { lintDefinition, Problem } from '@pilots/protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { ParticipantConfig } from '../src/config/config.js'
import { buildScenario, type Scenario, type ScenarioNode } from './helpers/network.js'

const ORG_A: ParticipantConfig = {
  id: 'org-a',
  did: 'did:web:org-a.example',
  displayName: 'Org A',
  baseUrl: 'https://org-a.example',
}
const ORG_B: ParticipantConfig = {
  id: 'org-b',
  did: 'did:web:org-b.example',
  displayName: 'Org B',
  baseUrl: 'https://org-b.example',
}

/** What a fresh canvas holds before the first gesture: one lane, one state, one step. */
const CANVAS: DefinitionDocument = {
  '@context': 'https://pilots.example/process/v1',
  id: 'drawn',
  version: '1.0.0',
  kind: 'service',
  title: 'Drawn in the editor',
  roles: [{ id: 'client', title: 'Client' }],
  hostedBy: 'client',
  initialState: 'OPEN',
  states: [{ id: 'OPEN', title: 'Open' }],
  data: { type: 'object' },
  transitions: [{ id: 'note', title: 'Add a note', from: ['OPEN'], by: ['client'] }],
  visibility: [],
  links: [],
}

function draw(): DefinitionDocument {
  const field = setField(CANVAS.data, ['reference'], { type: 'text', required: true })
  if (!field.ok) throw new Error(field.message)
  const gestures: Command[] = [
    { type: 'addRole', role: { id: 'supplier', title: 'Supplier' } },
    { type: 'setProcess', patch: { hostedBy: 'supplier', data: field.schema as DefinitionDocument['data'] } },
    { type: 'addState', state: { id: 'CONFIRMED', title: 'Confirmed' } },
    { type: 'addState', state: { id: 'DONE', title: 'Done', outcome: 'fulfilled' } },
    { type: 'addState', state: { id: 'STOPPED', title: 'Stopped', outcome: 'abandoned' } },
    // Drawn in the wrong lane first, then dragged — the gesture B3 maps to `by`.
    { type: 'addTransition', transition: { id: 'confirm', title: 'Confirm', from: ['OPEN'], to: 'CONFIRMED', by: ['client'] } },
    { type: 'moveTask', transition: 'confirm', fromRole: 'client', toRole: 'supplier' },
    { type: 'addTransition', transition: { id: 'finish', title: 'Finish', from: ['CONFIRMED'], to: 'DONE', by: ['client'] } },
    { type: 'addTransition', transition: { id: 'stop', title: 'Stop', from: ['*'], to: 'STOPPED', by: ['client', 'supplier'] } },
    { type: 'setDeadline', transition: 'confirm', deadline: 'P7D', onDeadline: 'stop' },
    { type: 'remove', kind: 'transition', id: 'note' },
  ]
  return gestures.reduce((document, command) => {
    const result = applyCommand(document, command)
    if (!result.ok) throw new Error(`${command.type}: ${result.error.message}`)
    return result.document
  }, CANVAS)
}

let scenario: Scenario
let a: ScenarioNode
let b: ScenarioNode

beforeEach(async () => {
  scenario = await buildScenario({ a: { participants: [ORG_A] }, b: { participants: [ORG_B] } })
  a = scenario.node('a')
  b = scenario.node('b')
  await scenario.connect('a', 'b')
})

afterEach(async () => {
  await scenario.close()
})

describe('a process drawn in the editor', () => {
  it('lints clean', () => {
    expect(lintDefinition(draw()).diagnostics.filter((d) => d.severity === 'error')).toEqual([])
  })

  it('is published, adopted by a peer who has never seen it, and run to a fulfilled ending', async () => {
    const published = await a.runtime.definitions.publish('org-a', draw())
    if (!published.ok) throw new Error(JSON.stringify(published.errors))

    const start = () =>
      a.runtime.instances.create(a.caller(), {
        definition: 'drawn@1.0.0',
        participants: { client: ORG_A.did, supplier: ORG_B.did },
        data: { reference: 'R-1' },
      })

    // B hosts and has never seen it: the first attempt is what makes B fetch it.
    const first = await start()
    expect(first.ok).toBe(false)
    if (!first.ok) expect(first.errors[0]?.type).toBe(Problem.definitionPending)
    await b.runtime.definitions.decide('org-b', 'drawn@1.0.0', 'accepted', 'operator')

    const created = await start()
    if (!created.ok) throw new Error(JSON.stringify(created.errors))
    await scenario.settle()
    const id = created.value.instance.id

    const confirmed = await b.runtime.instances.applyTransition(b.caller(), id, { transition: 'confirm' }, 1)
    if (!confirmed.ok) throw new Error(JSON.stringify(confirmed.errors))
    await scenario.settle()

    const finished = await a.runtime.instances.applyTransition(a.caller(), id, { transition: 'finish' }, 2)
    if (!finished.ok) throw new Error(JSON.stringify(finished.errors))
    await scenario.settle()

    expect((await b.runtime.store.instances.get('org-b', id))?.state).toBe('DONE')
    expect((await a.runtime.store.instances.get('org-a', id))?.state).toBe('DONE')
  })
})
