/**
 * What the genesis commits to.
 *
 * `InstanceGenesis` exists so a home node cannot hand a replica a chain that
 * verifies perfectly while quietly claiming a different definition or a
 * different counterparty. Pinning `definition` as `id@version` made that true
 * only at the granularity of a *name*: two connectors could hold different
 * documents under one ref and each believe the other agreed.
 *
 * It was masked while every connector mounted the same definitions directory.
 * Once definitions are authored at runtime and fetched from a peer, it is live.
 */
import { describe, expect, it } from 'vitest'

import { genesisHash } from '../src/engine/chain.js'
import { InstanceGenesis, instanceGenesis } from '../src/schemas/instance.js'

const base = {
  kind: 'service' as const,
  definition: 'p@1.0.0',
  participants: { a: 'did:web:a.example' },
  quotationId: null,
  offering: null,
}

describe('the genesis commits to the definition’s bytes, not only its name', () => {
  it('changes when the definition hash changes, at the same ref', () => {
    const one = instanceGenesis({ ...base, definitionHash: `sha256:${'1'.repeat(64)}` })
    const two = instanceGenesis({ ...base, definitionHash: `sha256:${'2'.repeat(64)}` })

    // Same ref, different bytes: the genesis must not be able to say they agree.
    expect(genesisHash(one)).not.toEqual(genesisHash(two))
  })

  it('is stable for the same definition', () => {
    const hash = `sha256:${'a'.repeat(64)}`
    expect(genesisHash(instanceGenesis({ ...base, definitionHash: hash }))).toEqual(
      genesisHash(instanceGenesis({ ...base, definitionHash: hash })),
    )
  })

  it('refuses a genesis with no definition hash', () => {
    expect(() => InstanceGenesis.parse(base)).toThrow()
  })
})
