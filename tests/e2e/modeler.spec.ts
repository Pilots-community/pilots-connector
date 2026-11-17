/**
 * The modeler, in a browser, against the running demo.
 *
 * Wiring and UI only: that gestures on the canvas become a definition the
 * connector accepts, and that the JSON tab shows the same document the diagram
 * edits. That an editor-made process *runs* is proven in the scenario tier
 * (`apps/connector/test/drawn-process.test.ts`), in milliseconds.
 *
 * Prerequisite: `docker compose up`.
 */
import { expect, test, type Page } from '@playwright/test'

const ORG_A = { email: 'alice@org-a.example', password: 'OrgA_123' }

async function signIn(page: Page): Promise<void> {
  await page.goto('/')
  await page.fill('input[name="email"]', ORG_A.email)
  await page.fill('input[name="password"]', ORG_A.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByTestId('participant')).toBeVisible()
  await page.getByTestId('tab-authoring').click()
}

async function addTask(page: Page, title: string, lane: string, from: string, to: string): Promise<void> {
  await page.getByTestId('palette-task').click()
  await page.fill('[data-testid="new-task-title"]', title)
  await page.selectOption('[data-testid="new-task-lane"]', lane)
  await page.selectOption('[data-testid="new-task-from"]', from)
  await page.selectOption('[data-testid="new-task-to"]', to)
  await page.getByTestId('new-element-submit').click()
}

test('a two-lane process is drawn from a blank canvas and published', async ({ page }) => {
  await signIn(page)
  await page.getByTestId('authoring-tab-diagram').click()
  await page.getByTestId('new-process').click()

  await page.getByTestId('palette-lane').click() // role
  await page.getByTestId('palette-lane').click() // role2
  await page.getByTestId('palette-state').click() // STATE
  await page.getByTestId('palette-state').click() // STATE2
  await page.getByTestId('palette-end-fulfilled').click() // DONE

  const id = `e2e-drawn-${Date.now()}`
  await page.fill('[data-testid="process-id"]', id)
  await page.press('[data-testid="process-id"]', 'Tab')
  await page.selectOption('[data-testid="process-initialState"]', 'STATE')
  await page.selectOption('[data-testid="process-hostedBy"]', 'role')

  await addTask(page, 'Begin', 'role', 'STATE', 'STATE2')
  await addTask(page, 'Finish', 'role2', 'STATE2', 'DONE')

  await page.getByTestId('palette-timer').click()
  await page.selectOption('[data-testid="new-timer-arming"]', 'begin')
  await page.fill('[data-testid="new-timer-duration"]', 'PT1H')
  await page.selectOption('[data-testid="new-timer-target"]', 'finish')
  await page.getByTestId('new-element-submit').click()

  await expect(page.locator('[data-node="timer:begin"]')).toBeVisible()
  // Enabled means linted, current and free of errors. Not "No problems": a
  // warning would hide that line without making the process unpublishable.
  await expect(page.getByTestId('publish')).toBeEnabled()
  await page.getByTestId('publish').click()
  await expect(page.getByTestId('published')).toContainText(`${id}@1.0.0`)
})

test('an example opens read-only, the JSON tab shows the same document, and an edit shows in both', async ({ page }) => {
  await signIn(page)
  const ref = 'container-weighing@1.0.0'
  await page.selectOption('[data-testid="open-ref"]', ref)
  await page.getByTestId('open-definition').click()
  await expect(page.getByTestId('read-only')).toBeVisible()

  await page.getByTestId('authoring-tab-json').click()
  const shown: unknown = JSON.parse(await page.getByTestId('definition-source').inputValue())
  const served = (await (await page.request.get(`/api/ui/definitions/${encodeURIComponent(ref)}`)).json()) as {
    definition: unknown
  }
  expect(shown).toEqual(served.definition)

  await page.getByTestId('authoring-tab-diagram').click()
  await page.getByTestId('new-version').click()
  await page.locator('[data-node="state:ORDERED"]').click()
  await page.fill('[data-testid="state-title"]', 'Ordered — edited')
  await page.press('[data-testid="state-title"]', 'Tab')

  await page.getByTestId('authoring-tab-json').click()
  const edited = JSON.parse(await page.getByTestId('definition-source').inputValue()) as {
    version: string
    states: { id: string; title: string }[]
  }
  expect(edited.version).toBe('1.0.1')
  expect(edited.states.find((s) => s.id === 'ORDERED')?.title).toBe('Ordered — edited')
})
