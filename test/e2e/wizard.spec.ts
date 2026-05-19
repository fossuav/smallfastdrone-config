/*
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <http://www.gnu.org/licenses/>.
 */

// End-to-end coverage of the wizard library + the frame-select wizard:
// library renders unlocked + locked wizards, frame-select walks from
// pick → confirm → apply → done against SITL, and the locked Pro stub
// shows the gating affordance but doesn't start.

import { expect, test } from '@playwright/test'

const SITL_URL = '/?transport=websocket&host=localhost:5761'
const SITL_QUERY = '?transport=websocket&host=localhost:5761'

test('Wizard library shows unlocked + locked cards, and frame-select writes FRAME_CLASS+TYPE to SITL', async ({ page }) => {
  await page.goto(SITL_URL)
  await page.getByRole('button', { name: 'Connect drone' }).click()
  await expect(page.getByText('Connected to your Quadcopter')).toBeVisible({ timeout: 15_000 })

  // Open the library via the nav.
  await page.getByRole('link', { name: 'Bringup' }).click()
  await expect(page.getByRole('heading', { name: 'Bringup wizards' })).toBeVisible()

  // Unlocked card for frame-select is present.
  await expect(page.getByRole('link', { name: /Open the Pick your frame wizard/ })).toBeVisible()

  // Locked Pro card is present with the "Coming soon" affordance.
  await expect(page.getByText('Pro wizards — coming soon')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Coming soon' })).toBeDisabled()

  // Open frame-select.
  await page.getByRole('link', { name: /Open the Pick your frame wizard/ }).click()
  await expect(page.getByRole('heading', { name: 'Pick your frame' })).toBeVisible()

  // The wizard loads params on entry; wait until the picker is visible
  // (the loading state is brief but real against SITL).
  await expect(page.getByRole('button', { name: /Quad X/, pressed: false })).toBeVisible({ timeout: 30_000 })

  // Pick Hex X (deliberately different from SITL's default to force a
  // write) and confirm.
  await page.getByRole('button', { name: /Hex X/, pressed: false }).click()
  await expect(page.getByText('Set your drone up as a Hex X?')).toBeVisible()
  await page.getByRole('button', { name: 'Apply' }).click()

  // Success state.
  await expect(page.getByText('Done — your drone knows its motor layout.')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText('Set as a Hex X.')).toBeVisible()

  // Returning to the library shows the completion badge + the wizard's
  // dynamic outcome instead of the manifest's prospective outcome.
  await page.getByRole('button', { name: 'Back to the wizard library' }).click()
  await expect(page.getByRole('heading', { name: 'Bringup wizards' })).toBeVisible()
  const frameCard = page.getByRole('link', { name: /Open the Pick your frame wizard/ })
  await expect(frameCard.getByText('Done')).toBeVisible()
  await expect(frameCard.getByText('Set as a Hex X')).toBeVisible()

  // Cross-check via the param browser: FRAME_CLASS should now read 2.
  await page.getByRole('switch', { name: 'Expert' }).click()
  await page.getByRole('link', { name: 'Parameters' }).click()
  await expect(page.getByRole('heading', { name: 'Parameters' })).toBeVisible({ timeout: 5_000 })
  await page.getByRole('textbox', { name: /Filter by name/ }).fill('FRAME_')
  await expect(page.getByRole('row', { name: /FRAME_CLASS/ })).toContainText('2')
  await expect(page.getByRole('row', { name: /FRAME_TYPE/ })).toContainText('1')
})

test('Wizard runner refuses an unknown wizard id gracefully', async ({ page }) => {
  // No connection needed — the not-found card renders for any id that
  // isn't in the registry, regardless of session state.
  await page.goto(`/wizard/does-not-exist${SITL_QUERY}`)
  await expect(page.getByRole('heading', { name: 'Wizard not found' })).toBeVisible()
})

test('Locked Pro wizard accessed by URL renders the gating page, not the runner', async ({ page }) => {
  // No connection needed — locked wizards short-circuit prereq + engine
  // resolution and render the gating card unconditionally.
  await page.goto(`/wizard/pid-autotune-pro${SITL_QUERY}`)
  await expect(page.getByRole('heading', { name: 'Pro PID tune' })).toBeVisible()
  await expect(page.getByText('Coming soon — a paid Pro wizard')).toBeVisible()
})
