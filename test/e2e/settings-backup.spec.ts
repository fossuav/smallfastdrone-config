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

// End-to-end test for the settings backup. Drives the operator path —
// connect, open Settings, press Save — and then reads the file the
// browser actually wrote, because the only thing that matters about a
// backup is whether the bytes on disk are a faithful copy of the drone.
// Asserting the on-screen success banner alone would pass with an empty
// file.
//
// The interesting behaviour is the filtering: the backup holds only what
// the drone reports as changed from its own factory defaults (fetched as
// @PARAM/param.pck?withdefaults=1 over MAVLink-FTP), minus read-only
// parameters. Earlier specs in the suite leave different parameters
// changed, so the assertions below pin the *shape* of the result — small
// delta, no read-only entries — rather than an exact parameter list.
//
// Read-only against the FC (no param writes, no reboot), so this spec is
// safe to run in any order relative to the state-mutating specs.

import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'

const SITL_QUERY = '?transport=websocket&host=localhost:5761'
const SITL_URL = `/${SITL_QUERY}`

test('Drone settings: save a settings backup and check the file holds the real param set', async ({ page }) => {
  await page.goto(SITL_URL)
  await page.getByRole('button', { name: 'Connect drone' }).click()
  await expect(page.getByText(/Connected to your \w+/)).toBeVisible({ timeout: 15_000 })

  await page.getByRole('link', { name: 'Settings' }).click()
  await expect(page.getByRole('heading', { name: 'Your drone\'s settings' })).toBeVisible()

  // The view loads the full param set on mount; Save stays disabled
  // until that lands, which is the behaviour we want to see.
  const saveButton = page.getByRole('button', { name: 'Save to my computer' })
  await expect(saveButton).toBeEnabled({ timeout: 30_000 })

  const downloadPromise = page.waitForEvent('download')
  await saveButton.click()
  const download = await downloadPromise

  expect(download.suggestedFilename()).toMatch(/^smallfastdrone-settings-\d{4}-\d{2}-\d{2}-\d{4}\.json$/)

  const path = await download.path()
  const backup = JSON.parse(await readFile(path, 'utf8'))

  expect(backup.schema).toBe('sfd-param-backup/1')
  expect(backup.vehicle.sysid).toBe(1)
  expect(backup.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)

  // SITL exposes ~1400 parameters but only a few dozen differ from
  // factory. A backup that captured everything — or nothing — would still
  // be valid JSON, so pin the scale in both directions.
  const names = Object.keys(backup.params)
  expect(names.length).toBeGreaterThan(0)
  expect(names.length).toBeLessThan(300)

  // Read-only parameters are never saved: sensor device ids and ground
  // pressure references belong to the hardware that was detected, and the
  // boot counter is the drone's own bookkeeping. Writing any of them back
  // would be meaningless at best.
  for (const readOnly of ['COMPASS_DEV_ID', 'BARO1_GND_PRESS', 'STAT_BOOTCNT'])
    expect(names).not.toContain(readOnly)

  // Values and types survive the round trip as numbers, not strings.
  const first = backup.params[names[0]]
  expect(typeof first.value).toBe('number')
  expect(typeof first.type).toBe('number')

  // Sorted on the way out, so two backups of the same drone diff cleanly.
  expect(names).toEqual([...names].sort())

  // The operator sees what was saved and where it went.
  await expect(page.getByText(`Saved ${names.length} settings`)).toBeVisible()
  await expect(page.getByText(download.suggestedFilename())).toBeVisible()
})
