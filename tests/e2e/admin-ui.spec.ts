/**
 * The admin UI, in a browser.
 *
 * The operator's side of the split: this is where a key is minted, a connection
 * is accepted and the audit log is read. It is a different app, on a different
 * surface, with a different credential — and it deliberately cannot start a
 * process, which is the thing worth checking.
 *
 * Prerequisite: `docker compose up`. The admin token is printed once on first
 * boot, so the test reads it from the container's log the same way an operator
 * would.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import { expect, test, type Page } from '@playwright/test'

const ADMIN_UI = process.env['PILOTS_E2E_ORG_A_ADMIN'] ?? 'http://localhost:3000/admin/'
const REPO = resolve(dirname(__filename), '..', '..')
const ORG_B_UI = process.env['PILOTS_E2E_ORG_B_UI'] ?? 'http://localhost:4001'

/**
 * The admin token, the way an operator would get it.
 *
 * `.env` first, because `PILOTS_SEED_ADMIN_TOKEN` makes that the source of
 * truth for the demo. The log is the fallback, for a connector that generated
 * its own token instead.
 *
 * Reading the log *first* was boot-history-dependent and therefore flaky: a
 * seeded token is logged only on the boot that adopts it, so a fresh
 * `down -v && up` printed one and an ordinary restart did not.
 */
function adminToken(service = 'org-a'): string {
  const variable = `ORG_${service === 'org-a' ? 'A' : 'B'}_ADMIN_TOKEN`
  try {
    const env = readFileSync(resolve(REPO, '.env'), 'utf8')
    const match = new RegExp(`^${variable}="?([^"\\n]+)"?$`, 'm').exec(env)
    if (match?.[1]) return match[1]
  } catch {
    // No .env — fall through to the log.
  }

  const logs = execFileSync('docker', ['compose', 'logs', service], {
    // Playwright compiles these to CJS, so `__dirname` is what is available.
    cwd: REPO,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
  for (const line of logs.split('\n')) {
    if (!line.includes('adminToken')) continue
    const json = line.slice(line.indexOf('| ') + 2)
    const parsed = JSON.parse(json) as { adminToken?: string }
    if (parsed.adminToken) return parsed.adminToken
  }
  throw new Error(`no ${variable} in .env and no admin token in ${service}'s log`)
}

async function signIn(page: Page): Promise<void> {
  await page.goto(ADMIN_UI)
  await page.fill('input[type="password"]', adminToken())
  await page.getByRole('button', { name: /sign in/i }).click()
  await expect(page.getByRole('button', { name: 'API keys' })).toBeVisible()
}

test.describe('the operator surface', () => {
  test('says whose connector it is, by label and by identity', async ({ page }) => {
    await signIn(page)

    // A demo has several of these open at once. The label comes from
    // configuration and the DID does not, so both are shown — renaming an
    // organisation must not look like a different connector.
    await expect(page.getByTestId('admin-participant')).toContainText('Org A')
    await expect(page.locator('header').first()).toContainText('did:web:org-a.example')
    await expect(page).toHaveTitle(/^Org A — /)
  })

  test('mints an API key and shows the secret exactly once', async ({ page }) => {
    await signIn(page)
    await page.getByRole('button', { name: 'API keys' }).click()

    const label = `e2e-${Date.now()}`
    await page.locator('input').first().fill(label)
    await page.getByRole('button', { name: 'Create key' }).click()

    // Shown once, stored only as an HMAC.
    await expect(page.getByText(/Copy this now/)).toBeVisible()
    const secret = await page.locator('code').first().innerText()
    expect(secret).toMatch(/^ak_[0-9A-Z]{26}\..+/)

    // Reload: the key is still listed, and the secret is gone for good. A UI
    // that could show it again would mean the connector had kept it. (The
    // session survives the reload — it is in localStorage — so there is nothing
    // to sign in to again.)
    await page.reload()
    await page.getByRole('button', { name: 'API keys' }).click()
    await expect(page.getByText(label)).toBeVisible()
    await expect(page.getByText(secret)).toHaveCount(0)
  })

  test('shows the connection to the peer as live', async ({ page }) => {
    await signIn(page)
    await page.getByRole('button', { name: 'Connections' }).click()

    await expect(page.getByText('did:web:org-b.example').first()).toBeVisible()
    await expect(page.getByText('ACTIVE').first()).toBeVisible()
  })

  test('shows the audit log, including what was refused', async ({ page }) => {
    await signIn(page)
    await page.getByRole('button', { name: 'Audit log' }).click()

    // Every administrative act is here, including the key this demo minted at
    // boot. The event log is silent about all of it, by design — which is
    // exactly why this exists.
    await expect(page.getByText('chain intact')).toBeVisible()
    await expect(page.getByText('apiKey.create').first()).toBeVisible()
  })

  test('cannot start a process, because that is not its surface', async ({ page }) => {
    await signIn(page)
    const tabs = await page.getByRole('button').allInnerTexts()

    // Starting processes and applying transitions are the local API's job.
    // Routing them through here would create the privileged path the whole
    // design forbids.
    expect(tabs.join(' ').toLowerCase()).not.toContain('start')
    expect(tabs.join(' ').toLowerCase()).not.toContain('transition')
  })
})

test.describe('adopting a process a peer wrote', () => {
  const ORG_A_UI = process.env['PILOTS_E2E_ORG_A_UI'] ?? 'http://localhost:4000'
  const ORG_B_ADMIN = process.env['PILOTS_E2E_ORG_B_ADMIN'] ?? 'http://localhost:3001/admin/'

  /**
   * Org A writes a process and starts it, so Org B has something to decide
   * about. Self-contained rather than depending on another spec having run:
   * a test that needs its neighbour to go first is a test that fails alone.
   */
  async function orgAAuthorsAndStarts(page: Page, id: string): Promise<void> {
    await page.goto(ORG_A_UI)
    await page.fill('input[name="email"]', 'alice@org-a.example')
    await page.fill('input[name="password"]', 'OrgA_123')
    await page.getByRole('button', { name: 'Sign in' }).click()
    await expect(page.getByTestId('participant')).toBeVisible()

    await page.getByTestId('tab-authoring').click()
    await page.fill(
      '[data-testid="definition-source"]',
      JSON.stringify(
        {
          '@context': 'https://pilots.example/process/v1',
          id,
          version: '1.0.0',
          kind: 'service',
          title: `Authored ${id}`,
          roles: [
            { id: 'buyer', title: 'Buyer', cardinality: 1, protocolRole: 'requester' },
            { id: 'seller', title: 'Seller', cardinality: 1, protocolRole: 'provider' },
          ],
          // Hosted by the author, so the create succeeds here and it is the
          // *delivery* to the peer that waits for their decision.
          hostedBy: 'buyer',
          initialState: 'OPEN',
          states: [
            { id: 'OPEN', title: 'Open' },
            { id: 'SETTLED', title: 'Settled', outcome: 'fulfilled' },
            { id: 'DROPPED', title: 'Dropped', outcome: 'abandoned' },
          ],
          defaultVisibility: 'all',
          data: {
            type: 'object',
            required: ['reference'],
            properties: { reference: { type: 'string' } },
          },
          transitions: [
            { id: 'settle', title: 'Settle it', from: ['OPEN'], to: 'SETTLED', by: ['buyer'] },
            { id: 'drop', title: 'Drop it', from: ['*'], to: 'DROPPED', by: ['buyer', 'seller'] },
          ],
          visibility: [],
          links: [],
        },
        null,
        2,
      ),
    )
    await expect(page.getByTestId('diagnostics')).toContainText('No problems')
    await page.getByTestId('publish').click()
    await expect(page.getByTestId('published')).toContainText(`${id}@1.0.0`)

    await page.getByTestId('tab-start').click()
    await page.selectOption('select[name="definition"]', `${id}@1.0.0`)
    await page.selectOption('select[data-role="buyer"]', '__self__')
    await page.selectOption('select[data-role="seller"]', 'did:web:org-b.example')
    await page.fill('input[data-field="reference"]', 'ADOPT-1')
    await page.getByTestId('start').click()
    await expect(page.getByTestId('state')).toHaveText('OPEN')
  }

  test('shows it as pending, with the document, and runs it once accepted', async ({ page }) => {
    const id = `adopt-${Date.now()}`
    await orgAAuthorsAndStarts(page, id)

    // Org B's operator, on their own connector's admin surface.
    await page.goto(ORG_B_ADMIN)
    await page.fill('input[type="password"]', adminToken('org-b'))
    await page.getByRole('button', { name: /sign in/i }).click()
    await page.getByRole('button', { name: 'Processes' }).click()

    const pending = page.getByTestId('pending-definition').filter({ hasText: id })
    await expect(pending).toBeVisible({ timeout: 15_000 })
    // Who sent it, so the decision is not made blind.
    await expect(pending).toContainText('did:web:org-a.example')

    // The document itself is readable before agreeing to run it.
    await pending.getByRole('button', { name: /read the document/i }).click()
    await expect(pending).toContainText('"hostedBy": "buyer"')

    await pending.getByTestId('accept').click()
    await expect(page.getByTestId('pending-definition').filter({ hasText: id })).toHaveCount(0)

    // And the replica that was waiting arrives. Matched on *this run's*
    // definition rather than on the reference, which earlier runs also used.
    await page.goto(ORG_B_UI)
    await page.fill('input[name="email"]', 'bob@org-b.example')
    await page.fill('input[name="password"]', 'OrgB_123')
    await page.getByRole('button', { name: 'Sign in' }).click()
    await expect(page.getByText(`Authored ${id}`, { exact: true })).toBeVisible({
      timeout: 20_000,
    })
  })
})
