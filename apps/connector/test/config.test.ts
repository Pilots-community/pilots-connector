/**
 * The three settings that exist only because they are convenient for a demo,
 * and are refused the moment `NODE_ENV=production` says this is not one.
 *
 * None of these were pinned down before: each is a `throw` a reviewer can read
 * and trust, but a config typo that flips the guard's condition (`===`
 * inverted, the wrong flag checked) would ship silently. `PILOTS_SEED_ADMIN_TOKEN`
 * joins the other two here rather than starting its own convention.
 */
import { describe, expect, it } from 'vitest'

import { ConfigError, loadConfig } from '../src/config/config.js'

const base = {
  PILOTS_PARTICIPANT_ID: 'org-a',
  PILOTS_PARTICIPANT_DID: 'did:web:org-a.example',
  PILOTS_BASE_URL: 'https://org-a.example',
  PILOTS_DEFINITIONS_DIR: '../../docs/definitions',
  NODE_ENV: 'production',
}

describe('development-only settings, refused under production', () => {
  it('refuses PILOTS_SEED_API_KEY', () => {
    expect(() => loadConfig({ ...base, PILOTS_SEED_API_KEY: 'ak_x.y' })).toThrow(ConfigError)
    expect(() => loadConfig({ ...base, PILOTS_SEED_API_KEY: 'ak_x.y' })).toThrow(
      /PILOTS_SEED_API_KEY/,
    )
  })

  it('refuses PILOTS_SEED_ADMIN_TOKEN', () => {
    expect(() => loadConfig({ ...base, PILOTS_SEED_ADMIN_TOKEN: 'adm_x' })).toThrow(ConfigError)
    expect(() => loadConfig({ ...base, PILOTS_SEED_ADMIN_TOKEN: 'adm_x' })).toThrow(
      /PILOTS_SEED_ADMIN_TOKEN/,
    )
  })

  it('refuses PILOTS_DEV_DID_DIRECTORY', () => {
    expect(() => loadConfig({ ...base, PILOTS_DEV_DID_DIRECTORY: 'true' })).toThrow(ConfigError)
    expect(() => loadConfig({ ...base, PILOTS_DEV_DID_DIRECTORY: 'true' })).toThrow(
      /PILOTS_DEV_DID_DIRECTORY/,
    )
  })

  it('allows all three outside production, and none of them by default', () => {
    expect(() =>
      loadConfig({
        ...base,
        NODE_ENV: 'development',
        PILOTS_SEED_API_KEY: 'ak_x.y',
        PILOTS_SEED_ADMIN_TOKEN: 'adm_x',
        PILOTS_DEV_DID_DIRECTORY: 'true',
      }),
    ).not.toThrow()

    const config = loadConfig({ ...base, NODE_ENV: 'development' })
    expect(config.seedApiKey).toBeNull()
    expect(config.seedAdminToken).toBeNull()
    expect(config.devDidDirectory).toBe(false)
  })
})
