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

// The exit ceremony's guard rails, which are the part worth automating.
//
// The ceremony itself cannot be driven here or anywhere else automatic: it
// mass-erases a real chip, needs a human holding a BOOT button, and ends
// with a drone that has to be physically replugged. Its *ordering* is
// covered by unit tests over runExitCeremony (test/unit/sfd-recover.spec.ts),
// which is where the "nothing destructive before the backup is saved"
// guarantee actually lives.
//
// What is left for an E2E is what the operator sees before committing:
// that the cost is stated plainly, and that the wizard cannot be started
// into a state that would leave a wiped drone with nothing to install.

import { expect, test } from '@playwright/test'

const SITL_QUERY = '?transport=websocket&host=localhost:5761'

test('exit ceremony states the cost and refuses to start unarmed', async ({ page }) => {
  test.setTimeout(120_000)
  await page.goto(`/${SITL_QUERY}`)
  await page.getByRole('button', { name: 'Connect drone' }).click()
  await expect(page.getByText(/Connected to your \w+/)).toBeVisible({ timeout: 20_000 })

  await page.getByRole('link', { name: 'Bringup' }).click()
  await page.getByRole('link', { name: 'All wizards' }).click()
  await page.getByRole('link', { name: /Open the Remove your drone's security wizard/ }).click()
  await expect(page.getByRole('heading', { name: 'Remove your drone\'s security' })).toBeVisible({ timeout: 15_000 })

  // The cost, before it is avoidable — including the part an operator
  // would not guess: the identity does not come back.
  await expect(page.getByText('This wipes your drone completely')).toBeVisible()
  await expect(page.getByText(/won't be the same one/)).toBeVisible()

  // A wiped drone with no image to install is a drone that will not boot,
  // so Start stays disabled until one is chosen.
  await expect(page.getByRole('button', { name: 'Start', exact: true })).toBeDisabled()

  // And it must not have started anything by merely being opened.
  await expect(page.getByText(/Wiping your drone/)).toHaveCount(0)
  await expect(page.getByText('I have the file — continue')).toHaveCount(0)
})
