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
import { dirname, resolve } from 'node:path'

import { expect, test, type Page } from '@playwright/test'

const ADMIN_UI = process.env['PILOTS_E2E_ACME_ADMIN'] ?? 'http://localhost:3000/admin/'

/** The token, from the log line that showed it once. */
function adminToken(service = 'acme'): string {
  const logs = execFileSync('docker', ['compose', 'logs', service], {
    // Playwright compiles these to CJS, so `__dirname` is what is available.
    cwd: resolve(dirname(__filename), '..', '..'),
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
  for (const line of logs.split('\n')) {
    if (!line.includes('adminToken')) continue
    const json = line.slice(line.indexOf('| ') + 2)
    const parsed = JSON.parse(json) as { adminToken?: string }
    if (parsed.adminToken) return parsed.adminToken
  }
  throw new Error(`no admin token in ${service}'s log`)
}

async function signIn(page: Page): Promise<void> {
  await page.goto(ADMIN_UI)
  await page.fill('input[type="password"]', adminToken())
  await page.getByRole('button', { name: /sign in/i }).click()
  await expect(page.getByRole('button', { name: 'API keys' })).toBeVisible()
}

test.describe('the operator surface', () => {
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

    await expect(page.getByText('did:web:vanmoer.example').first()).toBeVisible()
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
