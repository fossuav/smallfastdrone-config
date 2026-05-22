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

// End-to-end test for the motor-check wizard's happy path against SITL.
// SITL boots as a quad Plus (FRAME_CLASS=1, FRAME_TYPE=0) and is, by
// definition, correctly "wired" — so an operator who reports each motor
// exactly where/how the firmware expects gets an all-clear. This drives
// real MAV_CMD_DO_MOTOR_TEST spins against SITL and exercises the full
// flow: props-off gate → spin each motor → identify position + direction
// → review pass → Done badge.
//
// The mismatch / correction path (deliberately reporting a swap) lands
// with the auto-correction slice.

import { expect, test } from '@playwright/test'

const SITL_QUERY = '?transport=websocket&host=localhost:5761'
const SITL_URL = `/${SITL_QUERY}`

// Quad Plus, in test order, with each motor's correct position + spin
// (from the firmware mixer — see src/workflow/motor-geometry.ts).
const PLUS_SEQUENCE = [
  { position: 'front', direction: 'Clockwise' },
  { position: 'right', direction: 'Counter-clockwise' },
  { position: 'rear', direction: 'Clockwise' },
  { position: 'left', direction: 'Counter-clockwise' },
]

test('Motor check passes when every motor is reported correctly (SITL quad +)', async ({ page }) => {
  await page.goto(SITL_URL)
  await page.getByRole('button', { name: 'Connect drone' }).click()
  await expect(page.getByText(/Connected to your \w+/)).toBeVisible({ timeout: 15_000 })

  await page.getByRole('link', { name: 'Bringup' }).click()
  await page.getByRole('link', { name: /Open the Check motor spin wizard/ }).click()
  await expect(page.getByRole('heading', { name: 'Check motor spin' })).toBeVisible()

  // Safety gate. Frame layout loads from params first (give it room), then
  // the props-off confirmation gates Start.
  await expect(page.getByText('Remove all propellers first')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText(/Quad \+/)).toBeVisible()
  await page.getByRole('switch', { name: 'Propellers are removed' }).click()
  await page.getByRole('button', { name: 'Start motor check' }).click()

  // Walk all four motors. Each: spin (real DO_MOTOR_TEST), tap the
  // position that "moved", pick the direction, advance.
  for (let i = 0; i < PLUS_SEQUENCE.length; i++) {
    const step = PLUS_SEQUENCE[i]!
    await expect(page.getByText(`Motor ${i + 1} of ${PLUS_SEQUENCE.length}`)).toBeVisible()
    await page.getByRole('button', { name: 'Spin this motor' }).click()
    // Hotspot becomes clickable once the FC accepts the spin.
    await page.getByRole('button', { name: step.position, exact: true }).click()
    await page.getByRole('button', { name: step.direction, exact: true }).click()
    const advance = i === PLUS_SEQUENCE.length - 1 ? 'Finish' : 'Next motor'
    await page.getByRole('button', { name: advance }).click()
  }

  // Review: all correct.
  await expect(page.getByRole('heading', { name: 'Motors all check out' })).toBeVisible({ timeout: 10_000 })

  // Completion recorded — library card shows Done.
  await page.getByRole('button', { name: 'Back to library' }).click()
  await expect(page.getByRole('heading', { name: 'Bringup wizards' })).toBeVisible()
  const card = page.getByRole('link', { name: /Open the Check motor spin wizard/ })
  await expect(card.getByText('Done')).toBeVisible()
})
