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

// End-to-end test for the port probe against SITL. scripts/sitl-start.sh
// puts a simulated ELRS / Crossfire receiver on SERIAL5, and SITL's spare
// ports (SERIAL5-8) have no role, so the probe listens on all four: it
// hands them to the applet, restarts, finds the receiver on SERIAL5 and
// nothing on the rest, then sets SERIAL5 up as the receiver port, puts the
// others back, and restarts again. Leaves SERIAL5 as a receiver port -
// harmless to the specs after it, which read SERIAL3 and want one unused
// port, and SITL is started fresh each run.
//
// Skips itself under BENCH=1: on a real board it reassigns ports and
// restarts the board twice.

import { expect, test } from '@playwright/test'

const SITL_URL = '/?transport=websocket&host=localhost:5761'
const CARD = /Open the Find what's plugged in recipe/

test('The port probe finds the simulated receiver on SITL and sets its port up', async ({ page }) => {
  // Two restarts and a listen at up to eight baud rates a port.
  test.setTimeout(300_000)
  test.skip(Boolean(process.env.BENCH), 'reassigns a real board\'s ports and restarts it twice')

  await page.goto(SITL_URL)
  await page.getByRole('button', { name: 'Connect drone' }).click()
  await expect(page.getByText(/Connected to your \w+/)).toBeVisible({ timeout: 15_000 })

  // Expert-only until it's proven on hardware.
  await page.getByRole('link', { name: 'Recipes', exact: true }).click()
  await expect(page.getByRole('link', { name: /Open the Set up motors recipe/ })).toBeVisible()
  await expect(page.getByRole('link', { name: CARD })).toHaveCount(0)
  await page.getByText('Expert', { exact: true }).click()
  await page.getByRole('link', { name: CARD }).click()
  await expect(page.getByRole('heading', { name: 'Find what\'s plugged in' })).toBeVisible()

  // It says which ports it will listen on before touching any.
  await expect(page.getByText('Port 5', { exact: true })).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText(/Left alone: USB/)).toBeVisible()

  await page.getByRole('button', { name: 'Find what\'s plugged in' }).click()

  // Restart, listen, and the receiver turns up on SERIAL5.
  await expect(page.getByText('ELRS / Crossfire receiver')).toBeVisible({ timeout: 180_000 })
  await expect(page.getByRole('button', { name: 'Set these up' })).toBeVisible({ timeout: 60_000 })
  await expect(page.getByText('Set up as your radio receiver')).toBeVisible()
  await expect(page.getByText('Nothing heard').first()).toBeVisible()

  // Set it up: one more restart, and the summary says what each port became.
  await page.getByRole('button', { name: 'Set these up' }).click()
  await expect(page.getByText('Connections set up')).toBeVisible({ timeout: 120_000 })
  await expect(page.getByText('Port 5: Set up as your radio receiver')).toBeVisible()
})
