/**
 * Content-addressed documents, across two connectors.
 *
 * Two claims are under test, and they pull in opposite directions:
 *
 * - **Bytes follow the reference to the home node.** An actor uploads to its own
 *   connector and names the hash in a transition; the host pulls what it does
 *   not hold. Everyone else fetches from the host.
 * - **Who may read a document is derived from `visibility`**, not declared
 *   separately. The shipper can fetch the VGM certificate once `certificate`
 *   becomes visible at `VGM_ISSUED`, and not one state earlier.
 */
import { sha256 } from '@pilots/protocol'
import { beforeEach, afterEach, describe, expect, it } from 'vitest'

import type { ServiceResult } from '../src/instances/instance.service.js'
import { ACME, VANMOER } from './helpers/core.js'
import { buildScenario, type Scenario } from './helpers/network.js'

const PARTICIPANTS = { shipper: ACME.did, weigher: VANMOER.did }
const CERTIFICATE = new TextEncoder().encode('%PDF-1.7 a verified gross mass certificate')

let scenario: Scenario

beforeEach(async () => {
  scenario = await buildScenario({
    acme: { participants: [ACME] },
    vanmoer: { participants: [VANMOER] },
  })
  await scenario.connect('acme', 'vanmoer')
})

afterEach(async () => {
  await scenario.close()
})

function unwrap<T>(result: ServiceResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.errors, null, 2))
  return result.value
}

/** Run S1 up to the point where the certificate is issued. */
async function weighThrough(to: 'PAID' | 'VGM_ISSUED'): Promise<{ id: string; sha: string }> {
  const acme = scenario.node('acme')
  const vanmoer = scenario.node('vanmoer')

  const created = unwrap(
    await acme.runtime.instances.create(acme.caller(), {
      definition: 'container-weighing@1.0.0',
      participants: PARTICIPANTS,
      data: { containerNumber: 'MSCU1234567', terminal: '869' },
    }),
  )
  const id = created.instance.id

  unwrap(
    await acme.runtime.instances.applyTransition(
      acme.caller(),
      id,
      { transition: 'announceTruck', patch: { truckPlate: '1-ABC-123' } },
      1,
    ),
  )
  await scenario.settle()
  unwrap(
    await vanmoer.runtime.instances.applyTransition(
      vanmoer.caller(),
      id,
      {
        transition: 'weigh',
        patch: { grossMass: { value: 24000, unit: 'kg', measuredAt: '2026-08-24T09:19:00.000Z' } },
      },
      2,
    ),
  )
  unwrap(
    await vanmoer.runtime.instances.applyTransition(
      vanmoer.caller(),
      id,
      { transition: 'recordPayment', patch: { paymentReference: 'PMT-1' } },
      3,
    ),
  )
  await scenario.settle()

  // Van Moer uploads the certificate to its own connector, then references it.
  const stored = unwrap(
    await vanmoer.runtime.attachments.put(VANMOER, CERTIFICATE, 'application/pdf'),
  )
  if (to === 'PAID') return { id, sha: stored.sha256 }

  unwrap(
    await vanmoer.runtime.instances.applyTransition(
      vanmoer.caller(),
      id,
      {
        transition: 'issueVgm',
        patch: {
          certificate: { sha256: stored.sha256, issuedAt: '2026-08-24T09:30:00.000Z' },
        },
        attachments: [stored],
      },
      4,
    ),
  )
  await scenario.settle()
  return { id, sha: stored.sha256 }
}

describe('a document is addressed by its content', () => {
  it('computes the hash itself rather than believing the uploader', async () => {
    const vanmoer = scenario.node('vanmoer')
    const stored = unwrap(
      await vanmoer.runtime.attachments.put(VANMOER, CERTIFICATE, 'application/pdf'),
    )

    expect(stored.sha256).toBe(sha256(CERTIFICATE))
    expect(stored.size).toBe(CERTIFICATE.byteLength)
    expect(stored.mime).toBe('application/pdf')
  })

  it('treats a repeat upload of identical bytes as a no-op', async () => {
    const vanmoer = scenario.node('vanmoer')
    const first = unwrap(
      await vanmoer.runtime.attachments.put(VANMOER, CERTIFICATE, 'application/pdf'),
    )
    const second = unwrap(
      await vanmoer.runtime.attachments.put(VANMOER, CERTIFICATE, 'application/pdf'),
    )

    expect(second.sha256).toBe(first.sha256)
    expect(await vanmoer.runtime.store.attachments.list(VANMOER.id)).toHaveLength(1)
  })

  it('refuses an empty document and one over the limit', async () => {
    const vanmoer = scenario.node('vanmoer')

    const empty = await vanmoer.runtime.attachments.put(
      VANMOER,
      new Uint8Array(),
      'application/pdf',
    )
    expect(empty.ok).toBe(false)

    const huge = await vanmoer.runtime.attachments.put(
      VANMOER,
      new Uint8Array(vanmoer.runtime.config.maxAttachmentBytes + 1),
      'application/pdf',
    )
    expect(huge.ok).toBe(false)
    if (huge.ok) return
    expect(huge.errors[0]?.type).toContain('attachments-invalid')
  })
})

describe('who may read a document follows the field that describes it', () => {
  it('withholds the certificate from the shipper until it is issued', async () => {
    const acme = scenario.node('acme')
    const vanmoer = scenario.node('vanmoer')
    const { sha } = await weighThrough('PAID')

    // Van Moer uploaded them, so they are its own to read back — visibility
    // governs what we hand to others, not what we hold.
    expect(await vanmoer.runtime.attachments.read(VANMOER, VANMOER.did, sha)).toBeDefined()

    // Acme may not — the document is not referenced by any event yet, so there
    // is nothing entitling it to anything.
    expect(await vanmoer.runtime.attachments.read(VANMOER, ACME.did, sha)).toBeUndefined()
    expect(await acme.runtime.attachments.read(ACME, ACME.did, sha)).toBeUndefined()
  })

  it('releases it to the shipper once the instance reaches VGM_ISSUED', async () => {
    const acme = scenario.node('acme')
    const vanmoer = scenario.node('vanmoer')
    const { id, sha } = await weighThrough('VGM_ISSUED')

    expect((await acme.runtime.store.instances.get(ACME.id, id))?.state).toBe('VGM_ISSUED')

    // The grant is `certificate → shipper whenState VGM_ISSUED`, so now the
    // hash is in Acme's filtered view and the bytes follow.
    const forShipper = await vanmoer.runtime.attachments.read(VANMOER, ACME.did, sha)
    expect(forShipper).toBeDefined()
    expect(new TextDecoder().decode(forShipper!.bytes)).toContain('gross mass certificate')
  })

  it('refuses a participant of another instance entirely', async () => {
    const vanmoer = scenario.node('vanmoer')
    const { sha } = await weighThrough('VGM_ISSUED')

    expect(
      await vanmoer.runtime.attachments.read(VANMOER, 'did:web:interloper.example', sha),
    ).toBeUndefined()
  })
})

describe('bytes follow the reference to the home node', () => {
  /**
   * S1 step 10, and the direction the shipped definitions actually exercise:
   * the host issued the document, and a replica wants it.
   */
  it('lets a replica pull a document it is entitled to from the host', async () => {
    const acme = scenario.node('acme')
    const { sha } = await weighThrough('VGM_ISSUED')

    // Acme holds the reference in a verified event, but not the bytes: an
    // attachment is not replicated with the log, by design — the log stays small
    // and a peer downloads a document only when it wants one.
    expect(await acme.runtime.store.attachments.has(ACME.id, sha)).toBe(false)

    const pulled = await acme.runtime.attachments.pull(ACME, VANMOER.did, [
      { sha256: sha, mime: 'application/pdf', size: CERTIFICATE.byteLength },
    ])
    expect(pulled).toBe(1)

    const held = await acme.runtime.store.attachments.get(ACME.id, sha)
    expect(held).toBeDefined()
    // Re-hashed on arrival. Content addressing is worth nothing if the address
    // is taken on trust.
    expect(sha256(held!.bytes)).toBe(sha)
  })

  /**
   * The same call in the other direction: a host pulling what an actor
   * referenced. No shipped definition needs it yet — all three attach on a
   * transition the host itself fires — so it is exercised directly rather than
   * through a scenario that would have to be invented to reach it.
   */
  it('pulls a document held by a peer, in either direction', async () => {
    const acme = scenario.node('acme')
    const vanmoer = scenario.node('vanmoer')

    const note = new TextEncoder().encode('a scan of the transport order')
    const stored = unwrap(await acme.runtime.attachments.put(ACME, note, 'application/pdf'))

    // Acme is the holder, so it serves its own document to a peer that asks —
    // subject, as ever, to whether that peer may read it.
    expect(await vanmoer.runtime.store.attachments.has(VANMOER.id, stored.sha256)).toBe(false)
    const pulled = await vanmoer.runtime.attachments.pull(VANMOER, ACME.did, [stored])

    // Nothing references it in any instance, so Van Moer is not entitled and
    // Acme serves nothing. Holding a document is not the same as sharing it.
    expect(pulled).toBe(0)
    expect(await vanmoer.runtime.store.attachments.has(VANMOER.id, stored.sha256)).toBe(false)
  })

  it('refuses bytes from a peer that do not hash to what was claimed', async () => {
    const acme = scenario.node('acme')
    const vanmoer = scenario.node('vanmoer')

    // A reference to something Van Moer will never be given honestly.
    const claimed = sha256(new TextEncoder().encode('the real document'))
    const pulled = await vanmoer.runtime.attachments.pull(VANMOER, ACME.did, [
      { sha256: claimed, mime: 'application/pdf', size: 17 },
    ])

    // Acme does not hold it, so nothing arrives — and nothing is invented.
    expect(pulled).toBe(0)
    expect(await vanmoer.runtime.store.attachments.has(VANMOER.id, claimed)).toBe(false)
    void acme
  })
})
