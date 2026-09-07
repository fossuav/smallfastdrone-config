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

// Getting flight recordings off the drone, against SITL.
//
// SITL logs while disarmed (a defaults overlay in sitl-start.sh) so
// there is something to list without arming anything. Its recordings are
// in the clear — the encryption only exists in a signed build with an
// owner key, which SITL is not and has not — so this covers listing,
// downloading and handing back a log that needed no key. The scrambled
// path is bench-verified and additionally exercised here from a file,
// which needs no drone at all.
//
// Assertions are operator-facing per docs/TESTING.md: what the page says,
// not which opcode carried it.

import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'

const SITL_QUERY = '?transport=websocket&host=localhost:5761'

// Produced by the firmware's own monocypher; see test/unit/sfx.spec.ts.
const SCRAMBLED = fileURLToPath(new URL('../unit/fixtures/outbound-firmware-vector.sfx', import.meta.url))

async function connectAndOpenLogs(page: import('@playwright/test').Page): Promise<void> {
  await page.goto(`/${SITL_QUERY}`)
  await page.getByRole('button', { name: 'Connect drone' }).click()
  await expect(page.getByText(/Connected to your \w+/)).toBeVisible({ timeout: 20_000 })
  // In-app navigation: a fresh page load drops the connection.
  await page.getByRole('link', { name: 'Logs' }).click()
  await expect(page.getByRole('heading', { name: 'Flight logs' })).toBeVisible()
}

test('Logs: lists what the drone recorded, and hands one back', async ({ page }) => {
  test.setTimeout(120_000)
  await connectAndOpenLogs(page)

  // SITL keeps its logs in /logs where a board uses /APM/LOGS, and
  // nothing on the wire says which — so this also covers the search.
  //
  // A freshly booted drone has not opened a recording yet: SITL takes
  // the better part of a minute to start one. "Nothing recorded yet" is
  // the right answer until then, so this does what an operator does and
  // asks again, rather than the page being wrong for a while.
  const row = page.locator('li', { hasText: /\d+\.BIN/ }).first()
  await expect(async () => {
    await page.getByRole('button', { name: /Look again/ }).click()
    await expect(row).toBeVisible({ timeout: 4000 })
  }).toPass({ timeout: 90_000 })

  await row.getByRole('button').click()

  // An unscrambled recording needs no key, and must not ask for one.
  await expect(page.getByText('That\'s your flight log')).toBeVisible({ timeout: 60_000 })
  await expect(page.getByText(/isn't scrambled/).first()).toBeVisible()

  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Save the flight log' }).click()
  expect((await download).suggestedFilename()).toMatch(/\.bin$/)
})

test('Logs: a scrambled recording says what it needs rather than failing', async ({ page }) => {
  test.setTimeout(60_000)
  await connectAndOpenLogs(page)

  // No key and no identity loaded — the operator should be told which
  // two things to find, not that something went wrong.
  await page.locator('input[type=file]').last().setInputFiles(SCRAMBLED)

  await expect(page.getByText('Couldn\'t open it')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText(/Load your key and the drone's identity file/)).toBeVisible()
})
