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

// End-to-end test for the props-on motor probe against SITL: the plumbing,
// not the physics. SITL holds a grounded drone level, so no corner ever
// lifts there and every motor reports "didn't lift" - which still proves
// the whole chain: the card only in expert mode, the battery read from its
// voltage and the settings that follow from it saved, the applet uploaded and
// loaded, the run started over a parameter, the firmware's motor test
// driven from Lua on every motor, results back as named values, the
// ground-station heartbeat keeping the run alive, and the applet taken
// off again. Whether a corner lifts, and at what power, is a bench
// question (docs/BRINGUP.md "Props-on motor measurement").
//
// Never under BENCH=1: on a real drone this spins every motor, and the
// props may well be on. A bench run of the probe is the operator's,
// standing back, through the UI.

import { expect, test } from '@playwright/test'

const SITL_URL = '/?transport=websocket&host=localhost:5761'
const CARD = /Open the Measure motors with props on recipe/

test('The props-on motor probe runs every motor on SITL and reports each one', async ({ page }) => {
  // Ramping each motor to find its start, then a pulse ladder to the cap,
  // takes about twelve seconds a motor.
  test.setTimeout(240_000)
  test.skip(Boolean(process.env.BENCH), 'spins every motor of a real drone, perhaps with props on')

  await page.goto(SITL_URL)
  await page.getByRole('button', { name: 'Connect drone' }).click()
  await expect(page.getByText(/Connected to your \w+/)).toBeVisible({ timeout: 15_000 })

  // A tool still being proven on the bench is in the catalogue only in
  // expert mode.
  await page.getByRole('link', { name: 'Recipes', exact: true }).click()
  await expect(page.getByRole('link', { name: /Open the Set up motors recipe/ })).toBeVisible()
  await expect(page.getByRole('link', { name: CARD })).toHaveCount(0)
  await page.getByText('Expert', { exact: true }).click()
  await page.getByRole('link', { name: CARD }).click()
  await expect(page.getByRole('heading', { name: 'Measure motors with props on' })).toBeVisible()

  // The test runs as a script, so scripts have to be on. An earlier spec
  // may have left them either way; turning them on restarts SITL.
  const turnOn = page.getByRole('button', { name: 'Turn on scripts' })
  const gate = page.getByText('Before you start')
  await expect(turnOn.or(gate)).toBeVisible({ timeout: 30_000 })
  if (await turnOn.isVisible())
    await turnOn.click()
  await expect(gate).toBeVisible({ timeout: 90_000 })

  // The battery is read, not asked: SITL simulates a full 3S. One button
  // sets everything that follows from the cell count, and then says so.
  await expect(page.getByText(/3-cell LiPo, 12\.\d V, full/)).toBeVisible({ timeout: 15_000 })
  await page.getByRole('button', { name: 'Set up for a 3-cell battery' }).click()
  await expect(page.getByText('Settings match this battery')).toBeVisible({ timeout: 15_000 })

  // Nothing spins until the operator says the safety list is done.
  const startBtn = page.getByRole('button', { name: 'Start', exact: true })
  await expect(startBtn).toBeDisabled()
  await page.getByRole('switch', { name: 'Ready, the motors will spin with props on' }).click()
  await startBtn.click()

  // Running: a stop that is always there, and the drone saying which
  // motor it's on.
  await expect(page.getByRole('button', { name: 'Stop now' })).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText(/Motor 1 of 4/)).toBeVisible({ timeout: 30_000 })

  // Every motor reports, and on SITL none lifts.
  await expect(page.getByRole('button', { name: 'Run again' })).toBeVisible({ timeout: 180_000 })
  await expect(page.getByRole('cell', { name: 'Didn\'t lift' })).toHaveCount(4)
  await expect(page.getByText('may have a prop pushing down')).toBeVisible()

  // Done takes the applet back off the drone and returns to the catalogue.
  await page.getByRole('button', { name: 'Done' }).click()
  await expect(page).toHaveURL(/\/recipes/)
})
