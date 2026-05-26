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

// End-to-end test for the IMU noise wizard's LIVE Lua path against SITL —
// the real operator flow, no mocks:
//
//   enable scripting (Drone settings: write + reboot + auto-reconnect)
//   → run the wizard → applet uploaded via MAVLink FTP → scripting
//   restarted so the FC loads it → control param appears → sample armed
//   → progress → verdict.
//
// This is reachable because scripts/sitl-start.sh symlinks ./scripts ->
// APM/scripts, so an FTP upload to APM/scripts/ lands where SITL scripting
// scans (see docs/TESTING.md "Lua wizards in SITL"). The wizard never
// reboots — MAV_CMD_SCRIPTING STOP_AND_RESTART reloads the applet — so the
// only restart here is the one-time scripting-enable that Drone settings
// owns.
//
// Ordering note: the shared SITL instance carries scripting state across
// specs. This spec is named to sort AFTER the two specs that assert
// scripting is *off* (imu-noise-wizard, settings-scripting), and it
// tolerates scripting being already on, so it's robust either way.

import { expect, test } from '@playwright/test'

const SITL_QUERY = '?transport=websocket&host=localhost:5761'
const SITL_URL = `/${SITL_QUERY}`

test('IMU noise wizard runs end-to-end with live scripting against SITL', async ({ page }) => {
  await page.goto(SITL_URL)
  await page.getByRole('button', { name: 'Connect drone' }).click()
  await expect(page.getByText(/Connected to your \w+/)).toBeVisible({ timeout: 15_000 })

  // --- Ensure scripting is on (Drone settings owns the reboot) ---
  await page.getByRole('link', { name: 'Settings' }).click()
  await expect(page.getByRole('heading', { name: 'Lua scripting' })).toBeVisible()

  const scriptingOff = page.getByText('Currently off')
  const scriptingOn = page.getByText('Currently on')
  // checkScripting loads the full param set; give it room to settle to
  // a definite on/off state.
  await expect(scriptingOff.or(scriptingOn)).toBeVisible({ timeout: 30_000 })

  if (await scriptingOff.isVisible()) {
    await page.getByRole('switch', { name: /Lua scripting/ }).click()
    await expect(page.getByText('Will turn on')).toBeVisible()
    await page.getByRole('button', { name: 'Apply' }).click()
    // Apply does write → reboot → auto-reconnect → reload with no further
    // clicks. Auto-reconnect budget is 60s; give it headroom.
    await expect(scriptingOn).toBeVisible({ timeout: 75_000 })
  }

  // --- Run the wizard's live path ---
  // Bringup nav → ribbon → "All wizards" → library → wizard card.
  await page.getByRole('link', { name: 'Bringup' }).click()
  await page.getByRole('link', { name: 'All wizards' }).click()
  await page.getByRole('link', { name: /Open the Check sensor noise wizard/ }).click()
  await expect(page.getByRole('heading', { name: 'Check sensor noise' })).toBeVisible()

  // Scripting is on → wizard lands in the "ready" state with a Start
  // affordance (param load may take a moment).
  const startButton = page.getByRole('button', { name: 'Start sampling' })
  await expect(startButton).toBeVisible({ timeout: 30_000 })
  await startButton.click()

  // start() uploads the applet, restarts scripting, waits for the control
  // param, then arms a 5s sample. Allow generous time for the upload +
  // restart + rescan + sample.
  await expect(page.getByRole('heading', { name: 'Sample complete' })).toBeVisible({ timeout: 60_000 })
  // A verdict with the raw rad/s reading proves the wn_max result NVF
  // round-tripped from the applet (e.g. "Quiet (0.0013 rad/s) …").
  await expect(page.getByText(/rad\/s/)).toBeVisible()

  // The wizard records completion — back in the library the card shows a
  // Done badge with the verdict.
  await page.getByRole('button', { name: 'Back to library' }).click()
  await expect(page.getByRole('heading', { name: 'Bringup wizards' })).toBeVisible()
  const card = page.getByRole('link', { name: /Open the Check sensor noise wizard/ })
  await expect(card.getByText('Done')).toBeVisible()
})
