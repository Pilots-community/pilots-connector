/**
 * Configuration posture: what this node reports about how it is set up.
 *
 * These settings used to **throw** under `NODE_ENV=production`, and the tests
 * here asserted the throw. That was a conflation worth recording: `NODE_ENV`
 * describes how the process was built and how it behaves — secure cookies, log
 * formatting, framework optimisations — not whether the audience is a customer.
 * A demo node deployed to a dev environment runs `NODE_ENV=production` *because
 * it is a deployment*, and refusing its configuration made it unstartable.
 *
 * So a supplied value is now used and reported. What these tests guard is that
 * the reporting is complete and that an unset environment is a safe one.
 */
import { describe, expect, it } from 'vitest'

import { loadConfig } from '../src/config/config.js'
import { postureOf } from '../src/config/posture.js'

const base = {
  PILOTS_PARTICIPANT_ID: 'org-a',
  PILOTS_PARTICIPANT_DID: 'did:web:org-a.example',
  PILOTS_BASE_URL: 'https://org-a.example',
  PILOTS_DEFINITIONS_DIR: '../../docs/definitions',
  NODE_ENV: 'production',
}

describe('an unset environment is a production-ready one', () => {
  it('defaults every affordance off, so nothing has to be remembered', () => {
    const config = loadConfig(base)

    expect(config.seedApiKey).toBeNull()
    expect(config.seedAdminToken).toBeNull()
    expect(config.devDidDirectory).toBe(false)
    expect(config.autoAccept).toEqual([])
    expect(postureOf(config)).toEqual({ productionReady: true, warnings: [] })
  })

  it('is production-ready under NODE_ENV=development too, because the two are unrelated', () => {
    // The point of the change: posture is about configuration, not build mode.
    expect(postureOf(loadConfig({ ...base, NODE_ENV: 'development' })).productionReady).toBe(true)
  })
})

describe('a supplied value is used, not refused', () => {
  it('starts with a seeded API key and says so', () => {
    const config = loadConfig({ ...base, PILOTS_SEED_API_KEY: 'ak_x.y' })
    expect(config.seedApiKey).toBe('ak_x.y')

    const posture = postureOf(config)
    expect(posture.productionReady).toBe(false)
    expect(posture.warnings.map((one) => one.setting)).toEqual(['PILOTS_SEED_API_KEY'])
  })

  it('starts with a seeded admin token and says so', () => {
    const posture = postureOf(loadConfig({ ...base, PILOTS_SEED_ADMIN_TOKEN: 'adm_x' }))
    expect(posture.warnings.map((one) => one.setting)).toEqual(['PILOTS_SEED_ADMIN_TOKEN'])
  })

  it('starts with the dev DID directory and says what it costs', () => {
    const posture = postureOf(loadConfig({ ...base, PILOTS_DEV_DID_DIRECTORY: 'true' }))
    expect(posture.warnings[0]?.setting).toBe('PILOTS_DEV_DID_DIRECTORY')
    // The warning has to name the property that is lost, or it is just noise.
    expect(posture.warnings[0]?.detail).toContain('domain-binding')
  })

  it('reports auto-accepted peers, because nobody decided about them', () => {
    const posture = postureOf(loadConfig({ ...base, PILOTS_AUTO_ACCEPT: 'did:web:org-b.example' }))
    expect(posture.warnings.map((one) => one.setting)).toEqual(['PILOTS_AUTO_ACCEPT'])
  })

  it('reports every weakening at once, not merely the first', () => {
    // A node configured like the demo. An operator needs the whole list, since
    // fixing one and re-alerting on the next is a slow way to learn.
    const posture = postureOf(
      loadConfig({
        ...base,
        PILOTS_SEED_API_KEY: 'ak_x.y',
        PILOTS_SEED_ADMIN_TOKEN: 'adm_x',
        PILOTS_DEV_DID_DIRECTORY: 'true',
      }),
    )
    expect(posture.productionReady).toBe(false)
    expect(posture.warnings.map((one) => one.setting).sort()).toEqual([
      'PILOTS_DEV_DID_DIRECTORY',
      'PILOTS_SEED_ADMIN_TOKEN',
      'PILOTS_SEED_API_KEY',
    ])
    // Every warning names its variable and explains the cost; a bare flag would
    // tell an operator that something is wrong and not what.
    for (const warning of posture.warnings) {
      expect(warning.setting).toMatch(/^PILOTS_/)
      expect(warning.detail.length).toBeGreaterThan(30)
    }
  })
})
