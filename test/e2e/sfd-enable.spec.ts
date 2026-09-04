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

// The SFD enable wizard, from the side SITL can prove.
//
// A simulated vehicle can never hold an identity: SECURE_COMMAND handling
// compiles only into signed builds, so SITL never answers the identity
// read and the posture settles on `unsecured`. That is the case worth
// pinning here, because it is the one where the wizard must refuse
// clearly rather than offer a button that could not work. The states that
// need a real secured drone were verified on the bench - see
// docs/SECURITY.md and the BENCH=1 table in docs/TESTING.md.

import { expect, test } from '@playwright/test'

const SITL_QUERY = '?transport=websocket&host=localhost:5761'

test('SFD enable refuses clearly on a drone that cannot hold an identity', async ({ page }) => {
  test.setTimeout(120_000)
  await page.goto(`/${SITL_QUERY}`)
  await page.getByRole('button', { name: 'Connect drone' }).click()
  await expect(page.getByText(/Connected to your \w+/)).toBeVisible({ timeout: 20_000 })

  // Navigate inside the app rather than reloading: a fresh page load
  // drops the connection, and this wizard is entirely about what the
  // connected drone can do.
  await page.getByRole('link', { name: 'Bringup' }).click()
  await page.getByRole('link', { name: 'All wizards' }).click()
  await page.getByRole('link', { name: /Open the Secure your drone wizard/ }).click()
  await expect(page.getByRole('heading', { name: 'Secure your drone' })).toBeVisible({ timeout: 15_000 })

  // The identity read is a round trip an unsigned build never answers, so
  // it resolves on its timeout; wait past that before judging.
  await expect(page.getByText('This drone can\'t have an identity yet')).toBeVisible({ timeout: 30_000 })

  // It must not offer the action it cannot perform...
  await expect(page.getByRole('button', { name: /Give this drone its identity/ })).toHaveCount(0)
  // ...and must send the operator somewhere useful instead.
  await expect(page.getByRole('link', { name: /Go to firmware/ })).toBeVisible()

  // Sealing is one-way and the firmware refuses it without a verified
  // identity, so a drone that has none must never be shown the option.
  await expect(page.getByText(/Seal this drone/)).toHaveCount(0)
  await expect(page.getByText(/This drone is sealed/)).toHaveCount(0)
})
