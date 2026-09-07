/**
 * An instance that could never succeed is refused when it is created.
 *
 * This is the check the milestone exists for. Driving the demo by hand
 * dead-ended in `PENDING_CONTRACT`, where the only action offered to either
 * party was *cancel* — because the one transition out of it is fired by a link
 * from a quotation, and the instance had been created without one.
 *
 * The definition was not at fault: it declares the link, and it is coherent.
 * The **instance** was, and since the relation lives in the immutable genesis it
 * could never have been supplied afterwards. So this is a refusal, not a
 * warning, and it is expressed as pure graph reachability — no definition is
 * named in the code, and a definition nobody here has seen gets the same
 * treatment.
 */
import { Problem } from '@pilots/protocol'
import { beforeEach, describe, expect, it } from 'vitest'

import { ORG_A, ORG_B, buildCore, type TestCore } from './helpers/core.js'

const PARTICIPANTS = { shipper: ORG_A.did, transporter: ORG_B.did }

let core: TestCore

beforeEach(async () => {
  core = await buildCore()
})

/** A quotation for the transport service to be anchored to. */
async function agreedQuotation(): Promise<string> {
  const created = await core.instances.create(core.caller('org-a'), {
    definition: 'container-transport-quotation@1.0.0',
    participants: PARTICIPANTS,
    data: {
      pickup: { location: 'A' },
      dropoff: { location: 'B' },
      containerType: '40HC',
    },
  })
  if (!created.ok) throw new Error(JSON.stringify(created.errors))
  return created.value.instance.id
}

describe('creating an instance that can never reach a fulfilled state', () => {
  it('is refused, naming the relation that would unlock it', async () => {
    const result = await core.instances.create(core.caller('org-a'), {
      definition: 'container-transport@1.0.0',
      participants: PARTICIPANTS,
      data: { containerType: '40HC' },
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors[0]?.type).toBe(Problem.instanceUnfulfillable)
    // Naming what would unlock it is the difference between a refusal a caller
    // can act on and one they can only be annoyed by.
    expect(result.errors[0]?.detail).toContain('quotation')
  })

  it('is allowed once that relation is anchored', async () => {
    const result = await core.instances.create(core.caller('org-a'), {
      definition: 'container-transport@1.0.0',
      participants: PARTICIPANTS,
      data: { containerType: '40HC' },
      quotationId: await agreedQuotation(),
    })

    expect(result.ok).toBe(true)
  })

  it('leaves a definition that needs no relation alone', async () => {
    const result = await core.instances.create(core.caller('org-a'), {
      definition: 'container-weighing@1.0.0',
      participants: { shipper: ORG_A.did, weigher: ORG_B.did },
      data: { containerNumber: 'MSCU1234567', terminal: '869' },
    })

    expect(result.ok).toBe(true)
  })

  it('leaves a quotation whose first transition is auto alone', async () => {
    const result = await core.instances.create(core.caller('org-a'), {
      definition: 'container-weighing-quotation@1.0.0',
      participants: { shipper: ORG_A.did, weigher: ORG_B.did },
      data: {
        offering: 'urn:offering:org-b:weighing',
        price: { value: 45, currency: 'EUR' },
        conditions: { terminal: '869' },
      },
    })

    expect(result.ok).toBe(true)
  })

  it('refuses the three-party variant for the same reason, with no extra code', async () => {
    const result = await core.instances.create(core.caller('org-a'), {
      definition: 'container-transport-with-terminal@1.0.0',
      participants: { ...PARTICIPANTS, terminal: ORG_B.did },
      data: { containerType: '40HC' },
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    // Asserting the *reason*, not merely the failure: a three-role definition
    // has other ways to be refused, and a test that accepts any of them would
    // pass whether or not this check exists.
    expect(result.errors[0]?.type).toBe(Problem.instanceUnfulfillable)
  })
})
