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

// End-to-end test of the connect flow against a real SITL instance via
// the bridge. Validates the full stack: transport (WebSocket) → MAVLink
// parser → session store → ConnectView.
//
// Per docs/TESTING.md: assertions are operator-facing ("Connected to
// your Quadcopter"), not implementation-facing — the test enforces the
// microcopy contract from docs/UX.md.

import { expect, test } from '@playwright/test'

const SITL_URL = '/?transport=websocket&host=localhost:5761'

test('Connect view talks to SITL, decodes heartbeat + AUTOPILOT_VERSION', async ({ page }) => {
  await page.goto(SITL_URL)

  // Initial splash card is up
  await expect(page.getByRole('button', { name: 'Connect drone' })).toBeVisible()

  // Connect
  await page.getByRole('button', { name: 'Connect drone' }).click()

  // Heartbeat-driven vehicle line appears within a few seconds
  await expect(page.getByText('Connected to your Quadcopter')).toBeVisible({ timeout: 15_000 })

  // AUTOPILOT_VERSION arrives and the firmware string is rendered, plus
  // the boot banner (requested via DO_SEND_BANNER) flips the autopilot
  // label from "ArduPilot" to "SmallFastDrone" via the SFD detector.
  // Loose-match the version number so submodule bumps don't break the test.
  await expect(
    page.getByText(/SmallFastDrone 4\.\d+\.\d+(?:-alpha|-beta|-rc|-dev)?/),
  ).toBeVisible({ timeout: 10_000 })

  // Operator-first by default (docs/UX.md): developer detail — System ID,
  // raw link bytes, and the firmware git hash — is gated behind expert mode,
  // so none of it shows on the default Connect card.
  await expect(page.getByText('System ID:')).toHaveCount(0)
  await expect(
    page.getByText(/SmallFastDrone 4\.\d+\.\d+(?:-alpha|-beta|-rc|-dev)? \([0-9a-f]{6,}\)/),
  ).toHaveCount(0)

  // System status panel: SYS_STATUS arrives within a heartbeat or two.
  // SITL on a fresh boot reports the IMU bits healthy; we just check
  // that *some* subsystem reads OK to confirm the panel is wired.
  await expect(page.getByRole('status', { name: /Gyro:/ })).toBeVisible({ timeout: 5_000 })
  await expect(page.getByRole('status', { name: /Gyro: OK/ })).toBeVisible({ timeout: 5_000 })

  // The message bell in the nav has accrued the boot STATUSTEXTs.
  await page.getByRole('button', { name: 'Recent messages from your drone' }).click()
  // Boot banner — sent by ArduPilot in response to our DO_SEND_BANNER.
  // `.first()`: SITL sometimes emits the banner twice (boot + DO_SEND_BANNER
  // reply), so the bell can hold two identical lines — strict mode would
  // otherwise fail on the multi-match.
  await expect(page.getByText(/ArduCopter V.*SFD/).first()).toBeVisible({ timeout: 5_000 })
  // One of the routine boot lines we always see from SITL. `.first()`
  // because either side of the regex may match — they both show up in
  // the bell on a normal SITL boot, and toBeVisible() forbids multi-match.
  await expect(page.getByText(/ArduPilot Ready|Barometer 1 calibration/).first()).toBeVisible()
  // Close the popover by clicking the bell again (or pressing Escape).
  await page.keyboard.press('Escape')

  // Flipping expert mode on reveals the developer detail it had hidden —
  // System ID and the firmware git hash both appear on the card.
  await page.getByText('Expert', { exact: true }).click()
  await expect(page.getByText('System ID:')).toBeVisible()
  await expect(
    page.getByText(/SmallFastDrone 4\.\d+\.\d+(?:-alpha|-beta|-rc|-dev)? \([0-9a-f]{6,}\)/),
  ).toBeVisible()

  // Disconnect works without throwing (a quiet secondary once connected).
  await page.getByRole('button', { name: 'Disconnect' }).click()
  await expect(page.getByRole('button', { name: 'Connect drone' })).toBeVisible()
})
