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

// End-to-end test for the drone-settings scripting toggle. Exercises
// the full feature-toggle pattern: switch flip → Apply → needs-reboot
// → Restart → transport drop → Reconnect → applied state with the
// new value. Relies on SITL's restart-on-exit wrapper
// (scripts/sitl-start.sh) so PREFLIGHT_REBOOT_SHUTDOWN doesn't end
// the SITL session for the rest of the test suite.

import { expect, test } from '@playwright/test'

const SITL_QUERY = '?transport=websocket&host=localhost:5761'
const SITL_URL = `/${SITL_QUERY}`

test('Drone settings: toggle scripting on, reboot, reconnect, see it applied', async ({ page }) => {
  await page.goto(SITL_URL)
  await page.getByRole('button', { name: 'Connect drone' }).click()
  // Vehicle type may be Quadcopter or Hexacopter depending on what
  // earlier specs left in flash.
  await expect(page.getByText(/Connected to your \w+/)).toBeVisible({ timeout: 15_000 })

  await page.getByRole('link', { name: 'Settings' }).click()
  await expect(page.getByRole('heading', { name: 'Drone settings' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Lua scripting' })).toBeVisible()

  // checkScripting loads the full param set; give it room.
  await expect(page.getByText('Currently off')).toBeVisible({ timeout: 30_000 })

  // Flip the switch on → pending (reboot-required toggle).
  await page.getByRole('switch', { name: /Lua scripting/ }).click()
  await expect(page.getByText('Will turn on')).toBeVisible()

  // Apply does the whole sequence with no further clicks: PARAM_SET +
  // echo → settle → reboot → automatic reconnect (retrying through the
  // FC's restart window) → params reload → applied. We see the
  // restarting state in passing, then "Currently on" once it lands.
  await page.getByRole('button', { name: 'Apply' }).click()
  await expect(page.getByText('Restarting your drone…')).toBeVisible({ timeout: 15_000 })

  // Auto-reconnect budget is 60s; give it headroom.
  await expect(page.getByText('Currently on')).toBeVisible({ timeout: 75_000 })
})
