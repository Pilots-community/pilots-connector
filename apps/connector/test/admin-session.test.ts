/**
 * The admin bootstrap token: generated, stored, and — the part worth pinning
 * down — optionally fixed from configuration.
 *
 * `PILOTS_SEED_ADMIN_TOKEN` is deliberately not a password: it exists because
 * `/api/admin/v1` is meant to sit behind network-level access control rather
 * than be its own perimeter (docs/ARCHITECTURE.md §4), so a value an operator
 * already has in a gitignored `.env` costs a demo nothing to fix in place.
 * What has to hold regardless: it is peppered the same way a generated token
 * is, it is idempotent across restarts (no repeated "new" reports for an
 * unchanged value), and a value that *changes* is treated as a real rotation —
 * persisted and reported, not silently ignored.
 */
import { describe, expect, it } from 'vitest'

import { AdminSessionService } from '../src/auth/admin-session.service.js'

const PEPPER = 'pepper-for-tests'
const now = () => '2026-08-24T09:00:00.000Z'

describe('a generated token, the default', () => {
  it('generates one when nothing is stored and nothing is seeded', () => {
    const { service, tokenHash } = AdminSessionService.create({
      storedHash: undefined,
      pepper: PEPPER,
      now,
    })
    expect(service.bootstrap.generated).toBe(true)
    expect(service.bootstrap.seeded).toBe(false)
    expect(service.bootstrap.token).toMatch(/^adm_/)
    // The session it mints has to accept the very token it just generated.
    expect(service.signIn(service.bootstrap.token)?.id).toMatch(/^sess_/)
    void tokenHash
  })

  it('reports nothing new on a restart with a stored hash and no seed', () => {
    const first = AdminSessionService.create({ storedHash: undefined, pepper: PEPPER, now })
    const { service } = AdminSessionService.create({
      storedHash: first.tokenHash,
      pepper: PEPPER,
      now,
    })
    expect(service.bootstrap.generated).toBe(false)
    expect(service.bootstrap.seeded).toBe(false)
    expect(service.bootstrap.token).toBeUndefined()
  })
})

describe('a seeded token, from PILOTS_SEED_ADMIN_TOKEN', () => {
  it('accepts the seed value with no stored hash yet — the first boot', () => {
    const { service, tokenHash } = AdminSessionService.create({
      storedHash: undefined,
      pepper: PEPPER,
      now,
      seedToken: 'adm_operator-chosen-value',
    })
    expect(service.bootstrap.seeded).toBe(true)
    expect(service.bootstrap.generated).toBe(false)
    // New this boot, so the caller has something to persist and log.
    expect(service.bootstrap.token).toBe('adm_operator-chosen-value')
    expect(service.signIn('adm_operator-chosen-value')?.id).toMatch(/^sess_/)
    void tokenHash
  })

  it('is idempotent: an unchanged seed across a restart reports nothing new', () => {
    const first = AdminSessionService.create({
      storedHash: undefined,
      pepper: PEPPER,
      now,
      seedToken: 'adm_operator-chosen-value',
    })
    const { service } = AdminSessionService.create({
      storedHash: first.tokenHash,
      pepper: PEPPER,
      now,
      seedToken: 'adm_operator-chosen-value',
    })
    // Nothing to persist and nothing to log a second time — the same value in
    // `.env` on every boot must not print itself, or restart noise, forever.
    expect(service.bootstrap.token).toBeUndefined()
    expect(service.bootstrap.seeded).toBe(true)
    // But it still signs a session in, from the stored hash.
    expect(service.signIn('adm_operator-chosen-value')?.id).toMatch(/^sess_/)
  })

  it('adopts a changed seed value, reporting it as new and rejecting the old one', () => {
    const first = AdminSessionService.create({
      storedHash: undefined,
      pepper: PEPPER,
      now,
      seedToken: 'adm_first-value',
    })
    const { service, tokenHash } = AdminSessionService.create({
      storedHash: first.tokenHash,
      pepper: PEPPER,
      now,
      seedToken: 'adm_second-value',
    })
    expect(service.bootstrap.token).toBe('adm_second-value')
    expect(service.bootstrap.seeded).toBe(true)
    expect(tokenHash).not.toBe(first.tokenHash)
    expect(service.signIn('adm_second-value')?.id).toMatch(/^sess_/)
    expect(service.signIn('adm_first-value')).toBeUndefined()
  })

  it('takes precedence over a stored hash from a previously generated token', () => {
    // A connector that generated its own token, then an operator later set
    // PILOTS_SEED_ADMIN_TOKEN. The seed value must win, or the printed token
    // in .env would silently stop working.
    const generated = AdminSessionService.create({ storedHash: undefined, pepper: PEPPER, now })
    const { service } = AdminSessionService.create({
      storedHash: generated.tokenHash,
      pepper: PEPPER,
      now,
      seedToken: 'adm_operator-chosen-value',
    })
    expect(service.signIn('adm_operator-chosen-value')?.id).toMatch(/^sess_/)
    expect(service.signIn(generated.service.bootstrap.token)).toBeUndefined()
  })
})
