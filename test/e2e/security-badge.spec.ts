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

// The secured badge, from the side SITL can actually prove: an ordinary
// drone must not claim to be secured.
//
// SITL cannot show the positive case at all — SECURE_COMMAND handling
// compiles only into signed builds, so a simulated vehicle never answers
// the identity read and the posture stays `unsecured` by construction.
// That half is covered by unit tests over the posture logic and was
// verified on the bench (docs/SECURITY.md). A silent badge on SITL is
// therefore the assertion, not an absence of one: a false padlock is the
// failure that would actually matter.

import { expect, test } from '@playwright/test'

const SITL_URL = '/?transport=websocket&host=localhost:5761'

test('an ordinary drone shows no security badge', async ({ page }) => {
  test.setTimeout(120_000)
  await page.goto(SITL_URL)
  await page.getByRole('button', { name: 'Connect drone' }).click()
  await expect(page.getByText(/Connected to your \w+/)).toBeVisible({ timeout: 20_000 })

  // The probe is a round trip that an unsigned build never answers, so it
  // resolves on its timeout. Wait past that before concluding anything.
  await page.waitForTimeout(10_000)

  await expect(page.getByText('Secured', { exact: true })).toHaveCount(0)
  await expect(page.locator('[title*="secured firmware"]')).toHaveCount(0)
})
