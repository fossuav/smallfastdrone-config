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
// SITL boots as a quad Plus (FRAME_CLASS=1, FRAME_TYPE=0), correctly
// "wired", so an operator who confirms each motor where/how the firmware
// expects gets an all-clear. Drives real MAV_CMD_DO_MOTOR_TEST spins and
// exercises the full flow: props-off gate → walk each motor by number
// (auto-spun) → confirm position + direction → review pass → Done badge.
//
// The wizard steps motors in motor-NUMBER order. For SITL's quad Plus the
// firmware numbering is Motor1=right, Motor2=left, Motor3=front,
// Motor4=rear, each with its expected spin.

import { expect, test } from '@playwright/test'

const SITL_QUERY = '?transport=websocket&host=localhost:5761'
const SITL_URL = `/${SITL_QUERY}`

const PLUS_SEQUENCE = [
  { position: 'right', direction: 'Counter-clockwise' },
  { position: 'left', direction: 'Counter-clockwise' },
  { position: 'front', direction: 'Clockwise' },
  { position: 'rear', direction: 'Clockwise' },
]

test('Motor check passes when every motor is confirmed correct (SITL quad +)', async ({ page }) => {
  await page.goto(SITL_URL)
  await page.getByRole('button', { name: 'Connect drone' }).click()
  await expect(page.getByText(/Connected to your \w+/)).toBeVisible({ timeout: 15_000 })

  await page.getByRole('link', { name: 'Bringup' }).click()
  await page.getByRole('link', { name: /Open the Check motor spin wizard/ }).click()
  await expect(page.getByRole('heading', { name: 'Check motor spin' })).toBeVisible()

  // Safety gate (frame loads from params first).
  await expect(page.getByText('Remove all propellers first')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText(/Quad \+/)).toBeVisible()
  await page.getByRole('switch', { name: 'Propellers are removed' }).click()
  await page.getByRole('button', { name: 'Start motor check' }).click()

  // Walk all four motors. Each auto-spins; we confirm the position
  // (pre-selected to the expected one) and pick the direction.
  for (let i = 0; i < PLUS_SEQUENCE.length; i++) {
    const step = PLUS_SEQUENCE[i]!
    await expect(page.getByText(`Should be the ${step.position} motor`)).toBeVisible({ timeout: 10_000 })
    await page.getByRole('button', { name: step.position, exact: true }).click()
    await page.getByRole('button', { name: step.direction, exact: true }).click()
    const advance = i === PLUS_SEQUENCE.length - 1 ? 'Finish' : 'Next motor'
    await page.getByRole('button', { name: advance }).click()
  }

  // Review: all correct → Done badge on the library card.
  await expect(page.getByRole('heading', { name: 'Motors all check out' })).toBeVisible({ timeout: 10_000 })
  await page.getByRole('button', { name: 'Back to library' }).click()
  await expect(page.getByRole('heading', { name: 'Bringup wizards' })).toBeVisible()
  const card = page.getByRole('link', { name: /Open the Check motor spin wizard/ })
  await expect(card.getByText('Done')).toBeVisible()
})
