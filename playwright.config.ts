import { defineConfig, devices } from '@playwright/test'

/**
 * End-to-end, and **deliberately small**.
 *
 * It proves wiring and UI: that the process UI's API key reaches the connector,
 * that the relay works over real HTTP, that the admin UI can mint a key and
 * accept a connection, and that a broken chain is loud and red on screen.
 *
 * It never carries the burden of proving protocol behaviour. If an e2e test is
 * the only thing covering a rule, that rule is missing a scenario test — and the
 * scenario tier runs in three seconds with no containers, so there is no excuse
 * for putting the rule here instead.
 *
 * It runs against `docker compose up`, because the thing being tested is four
 * containers wired together. Starting the processes some other way would test a
 * topology nobody ships.
 */
const acmeUi = process.env['PILOTS_E2E_ACME_UI'] ?? 'http://localhost:4000'

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,
  // A shared demo stack: two tests racing the same instance would fail on a
  // genuine `409`, which is correct behaviour and a useless test failure.
  workers: 1,
  reporter: process.env['CI'] ? 'github' : 'list',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: acmeUi,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
