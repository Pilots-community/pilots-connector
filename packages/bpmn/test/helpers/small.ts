import type { DefinitionDocument } from '../../src/document.js'

/** Two roles, three states, one ordinary task and one wildcard. Neutral names on purpose. */
export function small(): DefinitionDocument {
  return {
    '@context': 'https://pilots.example/process/v1',
    id: 'small',
    version: '1.0.0',
    kind: 'service',
    title: 'Small',
    roles: [
      { id: 'alpha', title: 'Alpha' },
      { id: 'beta', title: 'Beta' },
    ],
    hostedBy: 'beta',
    initialState: 'OPEN',
    states: [
      { id: 'OPEN', title: 'Open' },
      { id: 'DONE', title: 'Done', outcome: 'fulfilled' },
      { id: 'DROPPED', title: 'Dropped', outcome: 'abandoned' },
    ],
    data: { type: 'object', properties: { note: { type: 'string' } } },
    transitions: [
      { id: 'finish', title: 'Finish', from: ['OPEN'], to: 'DONE', by: ['beta'] },
      { id: 'drop', title: 'Drop', from: ['*'], to: 'DROPPED', by: ['alpha', 'beta'] },
    ],
    visibility: [],
    links: [],
  }
}
