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

// End-to-end test for the IMU noise check wizard — the tool's first
// Lua-engine wizard. Exercises the *scripting-not-enabled* fallback
// path because SITL boots with SCR_ENABLE=0 by default and there's
// no reliable way to flip it on for tests yet (see docs/TESTING.md
// "Lua wizards in SITL"). What this test validates:
//
//   - Wizard appears in the library
//   - Runner mounts, capability check completes, "scripting isn't
//     enabled" alert is shown with the operator-actionable
//     instructions
//   - Back-to-library affordance works
//
// The live-script path (upload → control param → NVF progress → result
// → cleanup) is validated on real hardware until SITL Lua testing is
// sorted out.

import { expect, test } from '@playwright/test'

const SITL_QUERY = '?transport=websocket&host=localhost:5761'
const SITL_URL = `/${SITL_QUERY}`

test('IMU noise wizard shows the scripting-off prompt against a stock SITL', async ({ page }) => {
  await page.goto(SITL_URL)
  await page.getByRole('button', { name: 'Connect drone' }).click()
  await expect(page.getByText(/Connected to your \w+/)).toBeVisible({ timeout: 15_000 })

  // Bringup → ribbon → "All wizards" → library → wizard card. (Sensor
  // noise isn't a ribbon tab; it lives in the library until it gets a
  // proper home — see PROGRESS.)
  await page.getByRole('link', { name: 'Bringup' }).click()
  await page.getByRole('link', { name: 'All wizards' }).click()
  await page.getByRole('link', { name: /Open the Check sensor noise wizard/ }).click()
  await expect(page.getByRole('heading', { name: 'Check sensor noise' })).toBeVisible()

  // checkScripting() loads params, sees SCR_ENABLE=0, shows the
  // "scripting isn't turned on" alert. Allow time for the full param
  // fetch.
  await expect(page.getByText(/Scripting isn't turned on/)).toBeVisible({ timeout: 30_000 })
  // Operator-actionable instructions point at Drone settings (no
  // parameter names / expert-mode jargon). Text is split across
  // <strong>/text nodes; check distinctive fragments.
  await expect(page.getByText(/needs Lua scripting turned on/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Open Drone settings' })).toBeVisible()

  // Back-to-library returns to the wizard library; no completion
  // recorded for this aborted run.
  await page.getByRole('button', { name: 'Back to library' }).click()
  await expect(page.getByRole('heading', { name: 'Bringup wizards' })).toBeVisible()
  const card = page.getByRole('link', { name: /Open the Check sensor noise wizard/ })
  await expect(card.getByText('Done')).not.toBeVisible()
})
