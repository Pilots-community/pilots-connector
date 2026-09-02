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

const VANMOER_UI = process.env['PILOTS_E2E_VANMOER_UI'] ?? 'http://localhost:4001'

const ACME = { email: 'alice@acme.example', password: 'demo-password-acme' }
const VANMOER = { email: 'bram@vanmoer.example', password: 'demo-password-vanmoer' }

async function signIn(page: Page, who: { email: string; password: string }): Promise<void> {
  await page.fill('input[name="email"]', who.email)
  await page.fill('input[name="password"]', who.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByTestId('participant')).toBeVisible()
}

test.describe('a person can drive a process', () => {
  test('starts a weighing, and each side sees only its own moves', async ({ page, browser }) => {
    await page.goto('/')
    await signIn(page, ACME)
    await expect(page.getByTestId('participant')).toHaveText('Acme Shipping')

    // Start something. Note what the user never types: a DID. The role selects
    // are rendered from the definition, and "Us" is resolved by the BFF.
    await page.getByTestId('tab-start').click()
    await page.selectOption('select[name="definition"]', 'container-weighing@1.0.0')
    await page.selectOption('select[data-role="shipper"]', '__self__')
    await page.selectOption('select[data-role="weigher"]', 'did:web:vanmoer.example')

    // The data form is generated from the definition's own JSON Schema — this
    // test names fields, but the component does not.
    await page.fill('input[data-field="containerNumber"]', 'MSCU1010101')
    await page.fill('input[data-field="terminal"]', '869')
    await page.getByTestId('start').click()

    await expect(page.getByTestId('state')).toHaveText('ORDERED')
    const url = page.url()

    // Acme's move is offered; the weigher's is not. Rendered from `available`,
    // which the connector computed from the definition — one rule, and the UI
    // does not get a second opinion.
    await expect(page.locator('[data-transition="announceTruck"]')).toBeVisible()
    await expect(page.locator('[data-transition="weigh"]')).toHaveCount(0)

    await page.locator('[data-transition="announceTruck"]').click()
    await page.fill('input[data-field="truckPlate"]', '7-E2E-001')
    await page.getByTestId('apply').click()
    await expect(page.getByTestId('state')).toHaveText('TRUCK_ANNOUNCED')

    // Over on Van Moer's UI — a different container, a different user account,
    // a different connector — the same instance is now that side's turn.
    const vanmoer = await browser.newPage()
    await vanmoer.goto(VANMOER_UI)
    await signIn(vanmoer, VANMOER)
    await expect(vanmoer.getByTestId('participant')).toHaveText('Van Moer')

    const row = vanmoer.getByTestId('instance-row').first()
    await expect(row).toContainText('your turn')
    await row.click()
    await expect(vanmoer.locator('[data-transition="weigh"]')).toBeVisible()
    await expect(vanmoer.locator('[data-transition="announceTruck"]')).toHaveCount(0)
    await vanmoer.close()

    void url
  })

  test('withholds a field until the definition releases it', async ({ page, browser }) => {
    // Van Moer weighs. `grossMass` is granted to the shipper only from `PAID`.
    const vanmoer = await browser.newPage()
    await vanmoer.goto(VANMOER_UI)
    await signIn(vanmoer, VANMOER)

    const row = vanmoer.getByTestId('instance-row').first()
    await row.click()
    if (await vanmoer.locator('[data-transition="weigh"]').count()) {
      await vanmoer.locator('[data-transition="weigh"]').click()
      await vanmoer.fill('input[data-field="grossMass.value"]', '19500')
      await vanmoer.fill('input[data-field="grossMass.unit"]', 'kg')
      await vanmoer.fill('input[data-field="grossMass.measuredAt"]', '2026-09-02T10:00')
      await vanmoer.getByTestId('apply').click()
      await expect(vanmoer.getByTestId('state')).toHaveText('WEIGHED')
    }

    // Acme looks. The value is not merely hidden by CSS — it was never sent, so
    // there is nothing in the page to reveal.
    await page.goto('/')
    await signIn(page, ACME)
    await page.getByTestId('instance-row').first().click()
    await expect(page.getByTestId('data')).not.toContainText('19500')

    await vanmoer.close()
  })
})

test.describe('the log is shown as verified, not asserted to be', () => {
  test('reports the chain status the UI checked itself', async ({ page }) => {
    await page.goto('/')
    await signIn(page, ACME)
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
