import { describe, expect, it } from 'vitest'

import { auditEntryHash, chainAuditEntry, verifyAuditChain } from '../src/engine/audit-chain.js'
import { Problem } from '../src/problems.js'
import type { AuditEntry } from '../src/schemas/audit.js'

const PARTICIPANT = 'acme'

function draft(overrides: Partial<Parameters<typeof chainAuditEntry>[0]> = {}) {
  return {
    at: '2026-08-24T09:14:02.000Z',
    participantId: PARTICIPANT,
    category: 'local' as const,
    action: 'transition.apply',
    actor: { kind: 'apiKey' as const, id: 'ak_1', actorRef: 'alice@acme.example' },
    outcome: 'ok' as const,
    problem: null,
    detail: null,
    request: null,
    ...overrides,
  }
}

function chainOf(...drafts: Array<Parameters<typeof chainAuditEntry>[0]>): AuditEntry[] {
  const entries: AuditEntry[] = []
  for (const d of drafts) {
    entries.push(chainAuditEntry(d, entries.at(-1) ?? null))
  }
  return entries
}

describe('the audit chain', () => {
  it('numbers from 1 and links each entry to the one before', () => {
    const entries = chainOf(
      draft(),
      draft({ action: 'apiKey.create' }),
      draft({ action: 'connection.accept' }),
    )
    expect(entries.map((e) => e.seq)).toEqual([1, 2, 3])
    expect(entries[0]!.prev).toBeNull()
    expect(entries[1]!.prev).toBe(auditEntryHash(entries[0]!))
    expect(entries[2]!.prev).toBe(auditEntryHash(entries[1]!))
    expect(verifyAuditChain(entries).ok).toBe(true)
  })

  it('records what was refused, which is the reason it exists', () => {
    const entries = chainOf(
      draft(),
      draft({
        action: 'transition.apply',
        outcome: 'denied',
        problem: Problem.roleNotPermitted,
        subject: { instance: '01J0000000000000000000000A' },
      }),
    )
    expect(entries[1]!.outcome).toBe('denied')
    expect(entries[1]!.problem).toBe(Problem.roleNotPermitted)
    expect(entries[1]!.subject.instance).toBe('01J0000000000000000000000A')
    // Unset subject slots are explicit nulls, so every entry hashes comparably.
    expect(entries[1]!.subject.connection).toBeNull()
  })

  it('detects an edited entry', () => {
    const entries = chainOf(draft(), draft({ action: 'apiKey.create' }), draft())
    entries[1]!.outcome = 'ok'
    entries[1]!.action = 'apiKey.revoke'
    const result = verifyAuditChain(entries)
    expect(result.ok).toBe(false)
    expect(result.failures[0]?.seq).toBe(3)
    expect(result.failures[0]?.error.type).toBe(Problem.chainBroken)
  })

  it('detects a removed entry', () => {
    const entries = chainOf(draft(), draft({ action: 'a' }), draft({ action: 'b' }))
    const result = verifyAuditChain([entries[0]!, entries[2]!])
    expect(result.ok).toBe(false)
    expect(result.failures[0]?.error.type).toBe(Problem.chainBroken)
  })

  it('detects a reordered chain', () => {
    const entries = chainOf(draft({ action: 'a' }), draft({ action: 'b' }))
    const result = verifyAuditChain([entries[1]!, entries[0]!])
    expect(result.ok).toBe(false)
  })

  it('is empty-safe', () => {
    expect(verifyAuditChain([]).ok).toBe(true)
  })
})
