import { describe, expect, it, beforeEach } from 'vitest'

import { hasScope } from '@pilots/protocol'
import { FakeClock, deterministicIdGenerator } from '@pilots/protocol/testing'

import { ApiKeyService } from '../src/auth/api-key.service.js'
import { MemoryStore } from '../src/store/memory/memory-store.js'
import type { Store } from '../src/store/store.js'

const PEPPER = 'a-server-side-pepper-that-is-not-in-the-store'

let store: Store
let clock: FakeClock
let keys: ApiKeyService

beforeEach(() => {
  store = new MemoryStore()
  clock = new FakeClock('2026-08-24T09:00:00.000Z')
  const ids = deterministicIdGenerator(1, clock)
  keys = new ApiKeyService(
    store,
    PEPPER,
    () => clock.instant(),
    () => ids.next(),
  )
})

async function mint(overrides: Partial<Parameters<ApiKeyService['mint']>[0]> = {}) {
  return keys.mint({
    participantId: 'org-a',
    label: 'backoffice-prod',
    scopes: ['instances:read', 'instances:write'],
    createdBy: 'admin-session-1',
    ...overrides,
  })
}

describe('minting', () => {
  it('returns the secret exactly once and stores only a hash of it', async () => {
    const { record, secret } = await mint()

    expect(secret.startsWith(`${record.id}.`)).toBe(true)
    expect(record.secretHash).toMatch(/^[0-9a-f]{64}$/)

    const stored = await store.apiKeys.get('org-a', record.id)
    expect(JSON.stringify(stored)).not.toContain(secret.split('.')[1]!)
  })

  it('never returns the hash on the API projection', () => {
    const redacted = ApiKeyService.redact({
      id: 'ak_x',
      participantId: 'org-a',
      label: 'l',
      secretHash: 'f'.repeat(64),
      scopes: ['instances:read'],
      createdBy: 'admin',
      createdAt: '2026-08-24T09:00:00.000Z',
      lastUsedAt: null,
      revokedAt: null,
      expiresAt: null,
    })
    expect(redacted).not.toHaveProperty('secretHash')
  })

  it('gives every key a different secret', async () => {
    const first = await mint()
    const second = await mint()
    expect(first.secret).not.toBe(second.secret)
    expect(first.record.id).not.toBe(second.record.id)
  })
})

describe('verifying', () => {
  it('accepts the key it minted', async () => {
    const { record, secret } = await mint()
    const result = await keys.verify(secret)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.key.id).toBe(record.id)
      expect(result.key.participantId).toBe('org-a')
      expect(hasScope(result.key, 'transitions.apply')).toBe(true)
      expect(hasScope(result.key, 'attachments.write')).toBe(false)
    }
  })

  it('rejects a wrong secret under a real key id', async () => {
    const { record } = await mint()
    const result = await keys.verify(`${record.id}.not-the-secret`)
    expect(result).toEqual({ ok: false, reason: 'mismatch', keyId: record.id })
  })

  it('rejects an unknown key id', async () => {
    const result = await keys.verify('ak_01J0000000000000000000000A.whatever')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('unknown')
  })

  it.each([
    ['', 'empty'],
    ['no-separator', 'no separator'],
    ['.secret-only', 'no key id'],
    ['ak_only.', 'no secret'],
  ])('rejects a malformed presentation: %s (%s)', async (presented) => {
    const result = await keys.verify(presented)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('malformed')
  })

  it('rejects a missing header without throwing', async () => {
    expect((await keys.verify(undefined)).ok).toBe(false)
  })

  it('rejects a revoked key', async () => {
    const { record, secret } = await mint()
    expect(await keys.revoke('org-a', record.id)).toBe(true)

    const result = await keys.verify(secret)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('revoked')

    // Revoking twice is not an error, but it is not a second revocation either.
    expect(await keys.revoke('org-a', record.id)).toBe(false)
  })

  it('rejects an expired key once the clock passes it', async () => {
    const { secret } = await mint({ expiresAt: '2026-08-25T09:00:00.000Z' })
    expect((await keys.verify(secret)).ok).toBe(true)

    clock.advance('P1D')
    const result = await keys.verify(secret)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('expired')
  })

  it('is useless against a store dump, because the pepper is not in the store', async () => {
    const { secret } = await mint()
    const dumped = await store.apiKeys.find('org-a')

    // An attacker with the store but not the pepper cannot verify anything.
    const withoutPepper = new ApiKeyService(
      store,
      'wrong-pepper',
      () => clock.instant(),
      () => 'x',
    )
    expect((await withoutPepper.verify(secret)).ok).toBe(false)
    expect(dumped[0]?.secretHash).toBeDefined()
  })
})

describe('bookkeeping', () => {
  it('records when a key was last used', async () => {
    const { record, secret } = await mint()
    expect(record.lastUsedAt).toBeNull()

    clock.advance('PT1H')
    const result = await keys.verify(secret)
    if (result.ok) await keys.touch(result.key)

    expect((await store.apiKeys.get('org-a', record.id))?.lastUsedAt).toBe(
      '2026-08-24T10:00:00.000Z',
    )
  })

  it('lists a participant’s keys and nobody else’s', async () => {
    await mint()
    await mint({ participantId: 'org-b' })
    expect(await keys.list('org-a')).toHaveLength(1)
    expect(await keys.list('org-b')).toHaveLength(1)
  })
})
