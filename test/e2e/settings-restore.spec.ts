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

// End-to-end test for restoring a settings backup. Feeds the file picker
// a hand-built backup rather than one saved from the drone, so the test
// controls exactly which parameter changes and by how much — a backup
// saved from SITL holds whatever earlier specs happened to leave behind.
//
// Drives the full path: pick a file → plan → confirm → PARAM_SET +
// PREFLIGHT_STORAGE → reboot → auto-reconnect → reload, then re-feeds the
// same file to prove the drone now matches it.
//
// **Leaves FC state changed:** sets RTL_ALT_M to 25 (default 15). No
// other spec reads it, and nothing in the suite arms or flies, so this is
// inert — but it is a deliberate mutation, not an accident.
// Relies on the SITL restart-on-exit wrapper (scripts/sitl-start.sh) so
// the reboot doesn't end SITL for the rest of the suite.

import { Buffer } from 'node:buffer'
import { expect, test } from '@playwright/test'

const SITL_QUERY = '?transport=websocket&host=localhost:5761'
const SITL_URL = `/${SITL_QUERY}`

// Return altitude in metres — MAV_PARAM_TYPE_REAL32 (9). ArduCopter 4.7
// renamed the older centimetre RTL_ALT to RTL_ALT_M. The type recorded
// here is only history: a restore writes using the type the FC reports.
const TARGET = { name: 'RTL_ALT_M', value: 25, type: 9 }

function backupFile(): { name: string, mimeType: string, buffer: Buffer } {
  const doc = {
    schema: 'sfd-param-backup/1',
    createdAt: '2026-08-28T12:00:00.000Z',
    vehicle: { sysid: 1, firmwareVersion: null, frameLabel: null, uid: null },
    params: { [TARGET.name]: { value: TARGET.value, type: TARGET.type } },
  }
  return {
    name: 'smallfastdrone-settings-2026-08-28-1200.json',
    mimeType: 'application/json',
    buffer: Buffer.from(`${JSON.stringify(doc, null, 2)}\n`),
  }
}

test('Drone settings: restore a backup, watch the plan, write it, and see the drone match', async ({ page }) => {
  // Well past Playwright's 30s default: this spec loads the full param
  // set, writes, saves to flash, reboots the FC and waits for the
  // auto-reconnect, then reloads. The reconnect budget alone is 60s.
  test.setTimeout(180_000)

  await page.goto(SITL_URL)
  await page.getByRole('button', { name: 'Connect drone' }).click()
  await expect(page.getByText(/Connected to your \w+/)).toBeVisible({ timeout: 15_000 })

  await page.getByRole('link', { name: 'Settings' }).click()
  await expect(page.getByRole('heading', { name: 'Your drone\'s settings' })).toBeVisible()

  // The card loads the full param set on mount; the restore button is
  // gated on the same readiness as Save.
  await expect(page.getByRole('button', { name: 'Load a backup file' })).toBeEnabled({ timeout: 30_000 })

  const picker = page.locator('input[type="file"]')
  await picker.setInputFiles(backupFile())

  // Plan first — nothing is written until the operator confirms, and the
  // confirmation says what will happen rather than just "are you sure".
  await expect(page.getByText('1 setting will change')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText(/restarts it/)).toBeVisible()

  await page.getByRole('button', { name: 'Put these settings back' }).click()

  // Write → save → reboot → auto-reconnect, no further clicks. The
  // reconnect budget is 60s; give it headroom.
  await expect(page.getByText('1 setting put back')).toBeVisible({ timeout: 90_000 })

  // Feeding the same backup again must now find nothing to do — which is
  // only true if the value actually landed and survived the restart.
  await picker.setInputFiles(backupFile())
  await expect(page.getByText('Nothing to change')).toBeVisible({ timeout: 30_000 })
})
