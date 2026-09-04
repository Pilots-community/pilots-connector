/**
 * Whether this node is configured the way a production node should be.
 *
 * These settings used to be **refused** under `NODE_ENV=production`, and that
 * was a conflation. `NODE_ENV` says how the code was built and how it behaves —
 * secure cookies, error verbosity, framework optimisations — not whether the
 * audience is a customer. A deployed demo node runs `NODE_ENV=production`
 * *because it is a deployment*, and refusing its configuration made it
 * undeployable.
 *
 * So the rule is now: **a value supplied by configuration is used, and said out
 * loud.** Every weakening is reported here, logged at boot, and surfaced for
 * monitoring — so "this node is not configured for production" is something an
 * operator can alert on rather than something that stops a demo from starting.
 *
 * Feature flags are a separate matter and are not listed unless set: each has
 * its own environment variable and each defaults to the production-ready value,
 * so an unset environment is a safe environment.
 */
import type { ConnectorConfig } from './config.js'

export interface PostureWarning {
  /** The environment variable responsible, so the fix is obvious. */
  setting: string
  /** What it costs, in one sentence. */
  detail: string
}

export interface Posture {
  /** True when nothing below is set. What an alert should watch. */
  productionReady: boolean
  warnings: PostureWarning[]
}

export function postureOf(config: ConnectorConfig): Posture {
  const warnings: PostureWarning[] = []

  if (config.seedApiKey !== null) {
    warnings.push({
      setting: 'PILOTS_SEED_API_KEY',
      detail:
        'an API key whose value was decided outside this connector is registered at boot; a production node mints keys in the admin UI so that no credential exists before it is issued',
    })
  }

  if (config.seedAdminToken !== null) {
    warnings.push({
      setting: 'PILOTS_SEED_ADMIN_TOKEN',
      detail:
        'the admin bootstrap token comes from configuration rather than being generated and shown once, so anything that can read the environment can sign in to /api/admin/v1',
    })
  }

  if (config.devDidDirectory) {
    warnings.push({
      setting: 'PILOTS_DEV_DID_DIRECTORY',
      detail:
        'peer DIDs are resolved through the base URL configured for them instead of the URL the DID implies, which reduces the domain-binding check to "an operator wrote this address down" — the one property did:web was chosen for',
    })
  }

  if (config.autoAccept.length > 0) {
    warnings.push({
      setting: 'PILOTS_AUTO_ACCEPT',
      detail: `${config.autoAccept.length} peer(s) have their connection requests accepted without an operator deciding`,
    })
  }

  return { productionReady: warnings.length === 0, warnings }
}
