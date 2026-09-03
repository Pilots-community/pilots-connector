import { beforeEach, describe, expect, it } from 'vitest'

import { EMPTY_PAYLOAD_HASH, hashJson } from '../src/canonical.js'
import {
  filterEvent,
  foldEvents,
  genesisHash,
  headerHash,
  verifyChain,
} from '../src/engine/chain.js'
import { Problem } from '../src/problems.js'
import type { SignedEvent } from '../src/schemas/event.js'
import { shipped } from './helpers/definitions.js'
import { instanceGenesis } from '../src/schemas/instance.js'
import {
  ORG_A,
  ChainBuilder,
  DEFAULT_GENESIS,
  ORG_B,
  twoParties,
  type TwoParties,
} from './helpers/chain.js'

const weighing = shipped('container-weighing.json')
const INSTANCE = '01J0000000000000000000000A'
const participants = { shipper: ORG_A, weigher: ORG_B }

let parties: TwoParties
let events: SignedEvent[]

/** create → announceTruck → weigh, exactly as S1 runs it. */
async function weighingChain(): Promise<SignedEvent[]> {
  const chain = new ChainBuilder(parties, INSTANCE)
  await chain.append({
    participantId: 'org-a',
    actor: ORG_A,
    transition: 'create',
    from: null,
    to: 'ORDERED',
    at: '2026-08-24T09:00:00.000Z',
    payload: { containerNumber: 'MSCU1234567', terminal: '869' },
  })
  await chain.append({
    participantId: 'org-a',
    actor: ORG_A,
    transition: 'announceTruck',
    from: 'ORDERED',
    to: 'TRUCK_ANNOUNCED',
    at: '2026-08-24T09:10:00.000Z',
    payload: { truckPlate: '1-ABC-123' },
  })
  await chain.append({
    participantId: 'org-b',
    actor: ORG_B,
    transition: 'weigh',
    from: 'TRUCK_ANNOUNCED',
    to: 'WEIGHED',
    at: '2026-08-24T09:20:00.000Z',
    payload: { grossMass: { value: 24000, unit: 'kg', measuredAt: '2026-08-24T09:19:00.000Z' } },
  })
  return chain.events
}

beforeEach(async () => {
  parties = await twoParties()
  events = await weighingChain()
})

const options = () => ({
  resolver: parties.resolver,
  definition: weighing,
  participants,
  instanceId: INSTANCE,
})

describe('a well-formed chain', () => {
  it('verifies, and reports the state and data it folded', async () => {
    const result = await verifyChain(events, options())
    expect(result.failures).toEqual([])
    expect(result.ok).toBe(true)
    expect(result.state).toBe('WEIGHED')
    expect(result.seq).toBe(3)
    expect(result.redacted).toBe(false)
    expect(result.data).toEqual({
      containerNumber: 'MSCU1234567',
      terminal: '869',
      truckPlate: '1-ABC-123',
      grossMass: { value: 24000, unit: 'kg', measuredAt: '2026-08-24T09:19:00.000Z' },
    })
  })

  it('links each header to the canonical hash of the one before', () => {
    expect(events[0]!.header.prev).toBeNull()
    expect(events[1]!.header.prev).toBe(headerHash(events[0]!.header))
    expect(events[2]!.header.prev).toBe(headerHash(events[1]!.header))
  })

  it('commits to each payload by hash', () => {
    expect(events[2]!.header.payloadHash).toBe(hashJson(events[2]!.payload))
  })

  it('uses the empty-payload hash for a transition that carries none', async () => {
    const chain = new ChainBuilder(parties, INSTANCE)
    const event = await chain.append({
      participantId: 'org-a',
      actor: ORG_A,
      transition: 'create',
      from: null,
      to: 'ORDERED',
      at: '2026-08-24T09:00:00.000Z',
    })
    expect(event.header.payloadHash).toBe(EMPTY_PAYLOAD_HASH)
    expect(event.payload).toBeNull()
  })

  it('folds to the same result whether or not a definition was supplied', async () => {
    const withoutDefinition = await verifyChain(events, { resolver: parties.resolver })
    expect(withoutDefinition.ok).toBe(true)
    expect(withoutDefinition.state).toBe('WEIGHED')
  })
})

describe('S4b — tamper detection', () => {
  it('catches an edited payload at the payload hash', async () => {
    const tampered = structuredClone(events)
    ;(tampered[2]!.payload as { grossMass: { value: number } }).grossMass.value = 18000
    const result = await verifyChain(tampered, options())
    expect(result.ok).toBe(false)
    expect(result.failures.map((f) => f.error.type)).toEqual([Problem.payloadHashMismatch])
    expect(result.failures[0]?.seq).toBe(3)
  })

  it('catches an edited header at the signature', async () => {
    const tampered = structuredClone(events)
    tampered[2]!.header.to = 'PAID'
    const result = await verifyChain(tampered, options())
    expect(result.ok).toBe(false)
    expect(result.failures.map((f) => f.error.type)).toEqual([Problem.signatureInvalid])
  })

  it('catches a dropped event at the sequence', async () => {
    const result = await verifyChain([events[0]!, events[2]!], options())
    expect(result.ok).toBe(false)
    expect(result.failures.map((f) => f.error.type)).toEqual([Problem.chainBroken])
  })

  it('catches a rewritten history at the prev hash', async () => {
    // Re-sign event 2 with a different payload and a valid signature, but leave
    // event 3's `prev` pointing at the original. This is the host rewriting.
    const chain = new ChainBuilder(parties, INSTANCE)
    await chain.append({
      participantId: 'org-a',
      actor: ORG_A,
      transition: 'create',
      from: null,
      to: 'ORDERED',
      at: '2026-08-24T09:00:00.000Z',
      payload: { containerNumber: 'MSCU1234567', terminal: '869' },
    })
    await chain.append({
      participantId: 'org-a',
      actor: ORG_A,
      transition: 'announceTruck',
      from: 'ORDERED',
      to: 'TRUCK_ANNOUNCED',
      at: '2026-08-24T09:11:00.000Z',
      payload: { truckPlate: 'REWRITTEN' },
    })
    const rewritten = [...chain.events, events[2]!]
    const result = await verifyChain(rewritten, options())
    expect(result.ok).toBe(false)
    expect(result.failures.map((f) => f.error.type)).toEqual([Problem.chainBroken])
    expect(result.failures[0]?.error.detail).toMatch(/prev/i)
  })

  it('catches a state that does not follow from the event before it', async () => {
    const chain = new ChainBuilder(parties, INSTANCE)
    await chain.append({
      participantId: 'org-a',
      actor: ORG_A,
      transition: 'create',
      from: null,
      to: 'ORDERED',
      at: '2026-08-24T09:00:00.000Z',
    })
    await chain.append({
      participantId: 'org-b',
      actor: ORG_B,
      transition: 'weigh',
      from: 'TRUCK_ANNOUNCED', // never entered
      to: 'WEIGHED',
      at: '2026-08-24T09:20:00.000Z',
      payload: { grossMass: { value: 1, unit: 'kg', measuredAt: '2026-08-24T09:19:00.000Z' } },
    })
    const result = await verifyChain(chain.events, options())
    expect(result.ok).toBe(false)
    expect(result.failures.map((f) => f.error.type)).toEqual([Problem.chainBroken])
    expect(result.failures[0]?.error.detail).toMatch(/from/i)
  })

  it('catches a participant acting outside its role', async () => {
    const chain = new ChainBuilder(parties, INSTANCE)
    await chain.append({
      participantId: 'org-a',
      actor: ORG_A,
      transition: 'create',
      from: null,
      to: 'ORDERED',
      at: '2026-08-24T09:00:00.000Z',
    })
    await chain.append({
      participantId: 'org-a',
      actor: ORG_A,
      transition: 'announceTruck',
      from: 'ORDERED',
      to: 'TRUCK_ANNOUNCED',
      at: '2026-08-24T09:10:00.000Z',
      payload: { truckPlate: '1-ABC-123' },
    })
    // The shipper signs a weighing. The signature is genuine; the authority is not.
    await chain.append({
      participantId: 'org-a',
      actor: ORG_A,
      transition: 'weigh',
      from: 'TRUCK_ANNOUNCED',
      to: 'WEIGHED',
      at: '2026-08-24T09:20:00.000Z',
      payload: { grossMass: { value: 1, unit: 'kg', measuredAt: '2026-08-24T09:19:00.000Z' } },
    })
    const result = await verifyChain(chain.events, options())
    expect(result.ok).toBe(false)
    expect(result.failures.map((f) => f.error.type)).toEqual([Problem.roleNotPermitted])
  })

  it('refuses an actor whose DID does not resolve', async () => {
    const result = await verifyChain(events, {
      ...options(),
      resolver: { resolve: async () => null },
    })
    expect(result.ok).toBe(false)
    expect(result.failures[0]?.error.type).toBe(Problem.signatureInvalid)
    expect(result.failures[0]?.error.detail).toMatch(/resolve/i)
  })

  it('refuses events belonging to a different instance', async () => {
    const result = await verifyChain(events, {
      ...options(),
      instanceId: '01J0000000000000000000000B',
    })
    expect(result.ok).toBe(false)
    expect(result.failures[0]?.error.type).toBe(Problem.chainBroken)
  })

  it('stops at the first broken event rather than reporting noise after it', async () => {
    const tampered = structuredClone(events)
    tampered[1]!.header.to = 'PAID'
    const result = await verifyChain(tampered, options())
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0]?.seq).toBe(2)
  })
})

describe('a redacted event is not a verification failure', () => {
  it('verifies a chain whose payload the reader was never allowed to see', async () => {
    // Exactly what the shipper receives while the instance is still in WEIGHED.
    const asShipper = events.map((event) => filterEvent(weighing, event, ['shipper'], 'WEIGHED'))
    expect(asShipper[2]!.redacted).toBe(true)
    // Withheld in full, so the payload is `null` rather than an empty object.
    // docs/PROTOCOL.md §7.3 leans on that: total withholding stays detectable
    // even by a verifier that ignores `redacted`, because `payloadHash` is then
    // not the hash of `{}`.
    expect(asShipper[2]!.payload).toBeNull()

    const result = await verifyChain(asShipper, options())
    expect(result.failures).toEqual([])
    expect(result.ok).toBe(true)
    // The header chain is exact even though the value is unknown.
    expect(result.state).toBe('WEIGHED')
    expect(result.seq).toBe(3)
    // …and the fold says plainly that it is incomplete.
    expect(result.redacted).toBe(true)
    expect(result.data).not.toHaveProperty('grossMass')
    expect(result.data.truckPlate).toBe('1-ABC-123')
  })

  it('leaves an event alone when the reader may see all of it', () => {
    const asWeigher = filterEvent(weighing, events[2]!, ['weigher'], 'WEIGHED')
    expect(asWeigher.redacted).toBe(false)
    expect(asWeigher.payload).toEqual(events[2]!.payload)
    expect(asWeigher.sig).toBe(events[2]!.sig)
    expect(asWeigher.header).toEqual(events[2]!.header)
  })

  it('never touches the header, so the signature still verifies', async () => {
    const asShipper = filterEvent(weighing, events[2]!, ['shipper'], 'WEIGHED')
    expect(asShipper.header).toEqual(events[2]!.header)
    expect(asShipper.sig).toBe(events[2]!.sig)
  })

  it('releases the same stored event once the state moves on', () => {
    const laterView = filterEvent(weighing, events[2]!, ['shipper'], 'PAID')
    expect(laterView.redacted).toBe(false)
    expect(laterView.payload).toEqual(events[2]!.payload)
  })

  it('still catches tampering inside a redacted chain', async () => {
    const asShipper = events.map((event) => filterEvent(weighing, event, ['shipper'], 'WEIGHED'))
    asShipper[1]!.header.to = 'PAID'
    const result = await verifyChain(asShipper, options())
    expect(result.ok).toBe(false)
    expect(result.failures[0]?.error.type).toBe(Problem.signatureInvalid)
  })
})

describe('foldEvents', () => {
  it('rebuilds the instance state and data from headers and payloads', () => {
    const folded = foldEvents(events)
    expect(folded.state).toBe('WEIGHED')
    expect(folded.seq).toBe(3)
    expect(folded.data.truckPlate).toBe('1-ABC-123')
    expect(folded.redacted).toBe(false)
  })

  it('reports the fold as incomplete when a payload was withheld entirely', () => {
    const withheld = structuredClone(events)
    withheld[2]!.payload = null
    expect(foldEvents(withheld).redacted).toBe(true)
  })
})

describe('a partially redacted payload', () => {
  // The three-party definition withholds `driverName` from the shipper until
  // PICKED_UP and `driverPhone` from it always, while `vehiclePlate` and
  // `plannedPickupAt` stay visible. So `assign` filters to a *partial* payload
  // rather than an absent one.
  const threeParty = shipped('container-transport-with-terminal.json')
  const threeWay = {
    shipper: ORG_A,
    transporter: ORG_B,
    terminal: 'did:web:terminal869.example',
  }

  async function assignChain(): Promise<SignedEvent[]> {
    const chain = new ChainBuilder(parties, INSTANCE)
    await chain.append({
      participantId: 'org-a',
      actor: ORG_A,
      transition: 'create',
      from: null,
      to: 'PENDING_CONTRACT',
      at: '2026-08-24T09:00:00.000Z',
      payload: { containerType: '40HC' },
    })
    await chain.append({
      participantId: 'org-b',
      actor: ORG_B,
      transition: 'startExecution',
      from: 'PENDING_CONTRACT',
      to: 'CONTRACTED',
      at: '2026-08-24T09:05:00.000Z',
    })
    await chain.append({
      participantId: 'org-b',
      actor: ORG_B,
      transition: 'assign',
      from: 'CONTRACTED',
      to: 'ASSIGNED',
      at: '2026-08-24T09:10:00.000Z',
      payload: {
        vehiclePlate: '1-ABC-123',
        driverName: 'Jan',
        driverPhone: '+32...',
        plannedPickupAt: '2026-08-25T08:00:00.000Z',
      },
    })
    return chain.events
  }

  it('keeps the fields the reader may see and drops only the rest', async () => {
    const chain = await assignChain()
    const asShipper = chain.map((e) => filterEvent(threeParty, e, ['shipper'], 'ASSIGNED'))
    const assign = asShipper[2]!
    expect(assign.redacted).toBe(true)
    expect(assign.payload).toEqual({
      vehiclePlate: '1-ABC-123',
      plannedPickupAt: '2026-08-25T08:00:00.000Z',
    })
  })

  it('folds the visible half into the replica’s data, and says the fold is partial', async () => {
    const chain = await assignChain()
    const asShipper = chain.map((e) => filterEvent(threeParty, e, ['shipper'], 'ASSIGNED'))

    const folded = foldEvents(asShipper)
    expect(folded.redacted).toBe(true)
    expect(folded.state).toBe('ASSIGNED')
    // Visible fields survive the fold — a replica must not lose data it is
    // entitled to just because the same event carried something it is not.
    expect(folded.data.vehiclePlate).toBe('1-ABC-123')
    expect(folded.data.plannedPickupAt).toBe('2026-08-25T08:00:00.000Z')
    expect(folded.data.containerType).toBe('40HC')
    expect(folded.data).not.toHaveProperty('driverName')
    expect(folded.data).not.toHaveProperty('driverPhone')
  })

  it('verifies, and its fold matches — without ever checking the payload hash', async () => {
    const chain = await assignChain()
    const asShipper = chain.map((e) => filterEvent(threeParty, e, ['shipper'], 'ASSIGNED'))

    const result = await verifyChain(asShipper, {
      resolver: parties.resolver,
      definition: threeParty,
      participants: threeWay,
      instanceId: INSTANCE,
    })
    expect(result.failures).toEqual([])
    expect(result.ok).toBe(true)
    expect(result.redacted).toBe(true)
    expect(result.state).toBe('ASSIGNED')
    expect(result.data.vehiclePlate).toBe('1-ABC-123')
    expect(result.data).not.toHaveProperty('driverName')
  })
})

describe('every event commits to the instance it belongs to', () => {
  const THIRD = 'did:web:interloper.example'

  it('accepts a chain whose genesis matches the metadata it was handed', async () => {
    const verified = await verifyChain(events, {
      resolver: parties.resolver,
      definition: weighing,
      participants,
      genesis: DEFAULT_GENESIS,
    })
    expect(verified.ok).toBe(true)
  })

  /**
   * The attack this exists to stop: a home node hands a replica a perfectly
   * signed, perfectly chained log, together with a participants map naming
   * somebody who was never in the instance. Before `genesis`, the replica had
   * nothing to check that map against — authority was judged against whatever
   * the sender said.
   */
  it('refuses a genuine chain presented with a rewritten participants map', async () => {
    const swapped = await verifyChain(events, {
      resolver: parties.resolver,
      definition: weighing,
      participants: { shipper: THIRD, weigher: ORG_B },
      genesis: instanceGenesis({
        kind: 'service',
        definition: 'container-weighing@1.0.0',
        participants: { shipper: THIRD, weigher: ORG_B },
      }),
    })

    expect(swapped.ok).toBe(false)
    expect(swapped.failures[0]?.error.type).toBe(Problem.chainBroken)
    expect(swapped.failures[0]?.error.detail).toMatch(/does not match the genesis/)
  })

  it('refuses a chain presented as running a different definition', async () => {
    const relabelled = await verifyChain(events, {
      resolver: parties.resolver,
      definition: weighing,
      participants,
      genesis: instanceGenesis({
        kind: 'service',
        definition: 'container-transport@1.0.0',
        participants,
      }),
    })
    expect(relabelled.ok).toBe(false)
    expect(relabelled.failures[0]?.error.type).toBe(Problem.chainBroken)
  })

  it('catches two instances spliced into one log even with no metadata to compare', async () => {
    const other = new ChainBuilder(
      parties,
      INSTANCE,
      instanceGenesis({
        kind: 'service',
        definition: 'container-weighing@1.0.0',
        participants: { shipper: THIRD, weigher: ORG_B },
      }),
    )
    await other.append({
      participantId: 'org-a',
      actor: ORG_A,
      transition: 'create',
      from: null,
      to: 'ORDERED',
      at: '2026-08-24T09:00:00.000Z',
    })

    // Caller supplies no genesis at all: the chain still has to be internally
    // consistent about which instance it is.
    const spliced = await verifyChain(
      [
        events[0]!,
        {
          ...other.events[0]!,
          header: { ...other.events[0]!.header, seq: 2, prev: headerHash(events[0]!.header) },
        },
      ],
      {
        resolver: parties.resolver,
      },
    )
    expect(spliced.ok).toBe(false)
    expect(spliced.failures[0]?.error.detail).toMatch(/genesis changed|signature/)
  })

  it('hashes genesis independently of key order', () => {
    expect(
      genesisHash(
        instanceGenesis({ kind: 'service', definition: 'container-weighing@1.0.0', participants }),
      ),
    ).toBe(
      genesisHash(
        instanceGenesis({
          participants: { weigher: ORG_B, shipper: ORG_A },
          definition: 'container-weighing@1.0.0',
          kind: 'service',
        }),
      ),
    )
  })
})
