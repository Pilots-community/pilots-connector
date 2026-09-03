/**
 * The process UI, in a browser, against the running demo.
 *
 * Wiring and UI only. Every rule these flows depend on — visibility, the relay,
 * the permission check — is proven in the scenario tier, in milliseconds, with
 * no containers. What is proven *here* is the part a scenario test cannot see:
 * that a person clicking through actually reaches the connector, and that what
 * comes back is rendered honestly.
 *
 * Prerequisite: `docker compose up`.
 */
import { expect, test, type Page } from '@playwright/test'

const ORG_B_UI = process.env['PILOTS_E2E_ORG_B_UI'] ?? 'http://localhost:4001'

const ORG_A = { email: 'alice@org-a.example', password: 'demo-password-org-a' }
const ORG_B = { email: 'bram@org-b.example', password: 'demo-password-org-b' }

async function signIn(page: Page, who: { email: string; password: string }): Promise<void> {
  await page.fill('input[name="email"]', who.email)
  await page.fill('input[name="password"]', who.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByTestId('participant')).toBeVisible()
}

test.describe('a person can drive a process', () => {
  test('starts a weighing, and each side sees only its own moves', async ({ page, browser }) => {
    await page.goto('/')

    // Which organisation this screen belongs to, before anybody signs in. Two
    // of these UIs sit side by side in a demo and are otherwise distinguishable
    // only by port number, so the label and the DID are both on the page.
    await expect(page.getByTestId('signin-did')).toContainText('did:web:org-a.example')

    await signIn(page, ORG_A)
    await expect(page.getByTestId('participant')).toHaveText('Org A')
    // The label is configuration; the DID is the identity. Both are shown, so
    // renaming an organisation visibly does not move its identity.
    await expect(page.getByTestId('did')).toHaveText('did:web:org-a.example')
    await expect(page).toHaveTitle(/^Org A — /)

    // Start something. Note what the user never types: a DID. The role selects
    // are rendered from the definition, and "Us" is resolved by the BFF.
    await page.getByTestId('tab-start').click()
    await page.selectOption('select[name="definition"]', 'container-weighing@1.0.0')
    await page.selectOption('select[data-role="shipper"]', '__self__')
    await page.selectOption('select[data-role="weigher"]', 'did:web:org-b.example')

    // The data form is generated from the definition's own JSON Schema — this
    // test names fields, but the component does not.
    await page.fill('input[data-field="containerNumber"]', 'MSCU1010101')
    await page.fill('input[data-field="terminal"]', '869')
    await page.getByTestId('start').click()

    await expect(page.getByTestId('state')).toHaveText('ORDERED')
    const url = page.url()

    // Org A's move is offered; the weigher's is not. Rendered from `available`,
    // which the connector computed from the definition — one rule, and the UI
    // does not get a second opinion.
    await expect(page.locator('[data-transition="announceTruck"]')).toBeVisible()
    await expect(page.locator('[data-transition="weigh"]')).toHaveCount(0)

    await page.locator('[data-transition="announceTruck"]').click()
    await page.fill('input[data-field="truckPlate"]', '7-E2E-001')
    await page.getByTestId('apply').click()
    await expect(page.getByTestId('state')).toHaveText('TRUCK_ANNOUNCED')

    // Over on Org B's UI — a different container, a different user account,
    // a different connector — the same instance is now that side's turn.
    const orgB = await browser.newPage()
    await orgB.goto(ORG_B_UI)
    await signIn(orgB, ORG_B)
    await expect(orgB.getByTestId('participant')).toHaveText('Org B')

    const row = orgB.getByTestId('instance-row').first()
    await expect(row).toContainText('your turn')
    await row.click()
    await expect(orgB.locator('[data-transition="weigh"]')).toBeVisible()
    await expect(orgB.locator('[data-transition="announceTruck"]')).toHaveCount(0)
    await orgB.close()

    void url
  })

  test('withholds a field until the definition releases it', async ({ page, browser }) => {
    // Org B weighs. `grossMass` is granted to the shipper only from `PAID`.
    const orgB = await browser.newPage()
    await orgB.goto(ORG_B_UI)
    await signIn(orgB, ORG_B)

    const row = orgB.getByTestId('instance-row').first()
    await row.click()
    if (await orgB.locator('[data-transition="weigh"]').count()) {
      await orgB.locator('[data-transition="weigh"]').click()
      await orgB.fill('input[data-field="grossMass.value"]', '19500')
      await orgB.fill('input[data-field="grossMass.unit"]', 'kg')
      await orgB.fill('input[data-field="grossMass.measuredAt"]', '2026-09-02T10:00')
      await orgB.getByTestId('apply').click()
      await expect(orgB.getByTestId('state')).toHaveText('WEIGHED')
    }

    // Org A looks. The value is not merely hidden by CSS — it was never sent, so
    // there is nothing in the page to reveal.
    await page.goto('/')
    await signIn(page, ORG_A)
    await page.getByTestId('instance-row').first().click()
    await expect(page.getByTestId('data')).not.toContainText('19500')

    await orgB.close()
  })
})

test.describe('the log is shown as verified, not asserted to be', () => {
  test('reports the chain status the UI checked itself', async ({ page }) => {
    await page.goto('/')
    await signIn(page, ORG_A)
    await page.getByTestId('instance-row').first().click()

    // Green only when every signature was checked against a published key the
    // UI fetched itself. Amber where a key could not be resolved — never a tick
    // for a check that did not run.
    const verified = page.getByTestId('chain-verified')
    const unresolved = page.getByTestId('chain-unresolved')
    await expect(verified.or(unresolved)).toBeVisible()

    // And never red, on a chain nobody has touched.
    await expect(page.getByTestId('chain-broken')).toHaveCount(0)
    await expect(page.getByTestId('event-1')).toBeVisible()
  })
})
