import { expect, test } from '@playwright/test'

// First end-to-end test: drive the browser through the connect flow
// against a real SITL instance via the bridge. Validates the full stack:
// transport (WebSocket) → MAVLink parser → session store → ConnectView.
//
// Per docs/TESTING.md: assertions are operator-facing ("Connected to your
// Quadcopter"), not implementation-facing — the test enforces the
// microcopy contract from docs/UX.md.

const SITL_URL = '/?transport=websocket&host=localhost:5761'

test('Connect view talks to SITL, decodes heartbeat + AUTOPILOT_VERSION', async ({ page }) => {
  await page.goto(SITL_URL)

  // Initial splash card is up
  await expect(page.getByRole('button', { name: 'Connect drone' })).toBeVisible()

  // Connect
  await page.getByRole('button', { name: 'Connect drone' }).click()

  // Heartbeat-driven vehicle line appears within a few seconds
  await expect(page.getByText('Connected to your Quadcopter')).toBeVisible({ timeout: 15_000 })

  // AUTOPILOT_VERSION arrives and the firmware string is rendered.
  // Loose-match on the version number + git hash so submodule bumps
  // don't break the test — what matters is the shape, not the exact
  // bytes pinned this week.
  await expect(
    page.getByText(/ArduPilot 4\.\d+\.\d+(?:-alpha|-beta|-rc|-dev)? \([0-9a-f]{6,}\)/),
  ).toBeVisible({ timeout: 10_000 })

  // Sysid 1 is the SITL default
  await expect(page.getByText('System ID:')).toBeVisible()

  // Disconnect works without throwing
  await page.getByRole('button', { name: 'Disconnect' }).click()
  await expect(page.getByRole('button', { name: 'Connect drone' })).toBeVisible()
})
