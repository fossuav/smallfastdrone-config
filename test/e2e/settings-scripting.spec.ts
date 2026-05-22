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

  // Flip the switch on. Should land in the pending state.
  await page.getByRole('switch', { name: /Lua scripting/ }).click()
  await expect(page.getByText('Will turn on')).toBeVisible()

  // Apply — PARAM_SET goes out, echoes back, lands in needs-reboot.
  await page.getByRole('button', { name: 'Apply' }).click()
  await expect(page.getByText('Restart needed')).toBeVisible({ timeout: 10_000 })

  // Send the reboot. SITL exits + the wrapper restarts it; the bridge
  // drops the WS connection, session.connected goes false, and the
  // UI flips from "Restarting your drone…" to "Your drone is
  // restarting" (with the Reconnect button enabled).
  await page.getByRole('button', { name: 'Restart drone now' }).click()
  await expect(page.getByText('Your drone is restarting')).toBeVisible({ timeout: 15_000 })

  await expect(page.getByRole('button', { name: 'Reconnect' })).toBeEnabled({ timeout: 15_000 })

  // SITL takes a moment to relaunch after the reboot; the bridge's TCP
  // connect fails until 5760 is rebound, and an early reconnect (no
  // heartbeat yet) bounces the wizard back to the rebooting state with
  // the Reconnect button offered again. Poll: whenever Reconnect is
  // available, click it; succeed once the card reads "Currently on".
  await expect(async () => {
    if (await page.getByText('Currently on').isVisible())
      return
    const btn = page.getByRole('button', { name: 'Reconnect' })
    if (await btn.isVisible().catch(() => false) && await btn.isEnabled().catch(() => false))
      await btn.click()
    // Give the reconnect + heartbeat + param fetch a beat to land
    // before the next poll re-evaluates.
    expect(await page.getByText('Currently on').isVisible({ timeout: 4_000 }).catch(() => false)).toBe(true)
  }).toPass({ timeout: 90_000 })

  await expect(page.getByText('Currently on')).toBeVisible()
})
