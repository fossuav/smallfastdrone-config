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

// End-to-end coverage of the wizard library + the frame-select wizard:
// library renders unlocked + locked wizards, frame-select walks from
// pick → confirm → apply → done against SITL, and the locked Pro stub
// shows the gating affordance but doesn't start.

import { expect, test } from '@playwright/test'

const SITL_URL = '/?transport=websocket&host=localhost:5761'
const SITL_QUERY = '?transport=websocket&host=localhost:5761'

test('Wizard library shows unlocked + locked cards, and frame-select writes FRAME_CLASS+TYPE to SITL', async ({ page }) => {
  await page.goto(SITL_URL)
  await page.getByRole('button', { name: 'Connect drone' }).click()
  await expect(page.getByText('Connected to your Quadcopter')).toBeVisible({ timeout: 15_000 })

  // Open the library via the nav.
  await page.getByRole('link', { name: 'Bringup' }).click()
  await expect(page.getByRole('heading', { name: 'Bringup wizards' })).toBeVisible()

  // Unlocked card for frame-select is present.
  await expect(page.getByRole('link', { name: /Open the Pick your frame wizard/ })).toBeVisible()

  // Locked Pro card is present with the "Coming soon" affordance.
  await expect(page.getByText('Pro wizards — coming soon')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Coming soon' })).toBeDisabled()

  // Open frame-select.
  await page.getByRole('link', { name: /Open the Pick your frame wizard/ }).click()
  await expect(page.getByRole('heading', { name: 'Pick your frame' })).toBeVisible()

  // The wizard loads params on entry; wait until the picker is visible
  // (the loading state is brief but real against SITL).
  await expect(page.getByRole('button', { name: /Quad X/, pressed: false })).toBeVisible({ timeout: 30_000 })

  // Pick Hex X (deliberately different from SITL's default to force a
  // write) and confirm.
  await page.getByRole('button', { name: /Hex X/, pressed: false }).click()
  await expect(page.getByText('Set your drone up as a Hex X?')).toBeVisible()
  await page.getByRole('button', { name: 'Apply' }).click()

  // Success state.
  await expect(page.getByText('Done — your drone knows its motor layout.')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText('Set as a Hex X.')).toBeVisible()

  // Returning to the library shows the completion badge + the wizard's
  // dynamic outcome instead of the manifest's prospective outcome.
  await page.getByRole('button', { name: 'Back to the wizard library' }).click()
  await expect(page.getByRole('heading', { name: 'Bringup wizards' })).toBeVisible()
  const frameCard = page.getByRole('link', { name: /Open the Pick your frame wizard/ })
  await expect(frameCard.getByText('Done')).toBeVisible()
  await expect(frameCard.getByText('Set as a Hex X')).toBeVisible()

  // Cross-check via the param browser: FRAME_CLASS should now read 2.
  await page.getByRole('switch', { name: 'Expert' }).click()
  await page.getByRole('link', { name: 'Parameters' }).click()
  await expect(page.getByRole('heading', { name: 'Parameters' })).toBeVisible({ timeout: 5_000 })
  await page.getByRole('textbox', { name: /Filter by name/ }).fill('FRAME_')
  await expect(page.getByRole('row', { name: /FRAME_CLASS/ })).toContainText('2')
  await expect(page.getByRole('row', { name: /FRAME_TYPE/ })).toContainText('1')
})

test('Wizard runner refuses an unknown wizard id gracefully', async ({ page }) => {
  // No connection needed — the not-found card renders for any id that
  // isn't in the registry, regardless of session state.
  await page.goto(`/wizard/does-not-exist${SITL_QUERY}`)
  await expect(page.getByRole('heading', { name: 'Wizard not found' })).toBeVisible()
})

test('Locked Pro wizard accessed by URL renders the gating page, not the runner', async ({ page }) => {
  // No connection needed — locked wizards short-circuit prereq + engine
  // resolution and render the gating card unconditionally.
  await page.goto(`/wizard/pid-autotune-pro${SITL_QUERY}`)
  await expect(page.getByRole('heading', { name: 'Pro PID tune' })).toBeVisible()
  await expect(page.getByText('Coming soon — a paid Pro wizard')).toBeVisible()
})

test('Bringup meta-wizard chains preflight + frame-select + motor-check and marks itself complete', async ({ page }) => {
  // Two reboot-free reconfigs but a hexa motor walk — give it room.
  test.setTimeout(120_000)

  await page.goto(SITL_URL)
  await page.getByRole('button', { name: 'Connect drone' }).click()
  // Loose vehicle-type match — the earlier frame-select happy-path test
  // persists FRAME_CLASS=2 to SITL, so subsequent specs see SITL report
  // as a Hexacopter rather than the default Quadcopter. Either is fine
  // for this test; we just need a heartbeat-driven connection.
  await expect(page.getByText(/Connected to your \w+/)).toBeVisible({ timeout: 15_000 })

  // Open bringup from the library.
  await page.getByRole('link', { name: 'Bringup' }).click()
  await page.getByRole('link', { name: /Open the Full bringup wizard/ }).click()
  await expect(page.getByRole('heading', { name: 'Full bringup' })).toBeVisible()

  // All steps render as not-yet-started, "0 of 3 complete".
  await expect(page.getByText('0 of 3 complete')).toBeVisible()

  // Start preflight from bringup. The Start button is a router link to
  // /wizard/preflight?returnTo=/wizard/bringup; we click and end up at
  // the preflight runner.
  const preflightRow = page.locator('li').filter({ hasText: 'Pre-flight check' })
  await preflightRow.getByRole('link', { name: 'Start' }).click()
  await expect(page.getByRole('heading', { name: 'Pre-flight check' })).toBeVisible()

  // Confirm — preflight has no FC writes, just an operator confirmation.
  await page.getByRole('button', { name: /Looks good/ }).click()

  // Back at bringup, preflight is done and progress reads 1 of 3.
  await expect(page.getByRole('heading', { name: 'Full bringup' })).toBeVisible()
  await expect(page.getByText('1 of 3 complete')).toBeVisible()
  await expect(preflightRow.getByText(/Pre-flight check passed/)).toBeVisible()

  // Start frame-select from bringup; ends at /wizard/frame-select.
  const frameRow = page.locator('li').filter({ hasText: 'Pick your frame' })
  await frameRow.getByRole('link', { name: 'Start' }).click()
  await expect(page.getByRole('heading', { name: 'Pick your frame' })).toBeVisible()

  // Wait for params, pick a frame, apply. (Quad X may already be set —
  // the wizard handles that case with the "no change needed" path.)
  await expect(page.getByRole('button', { name: /Hex Plus/, pressed: false })).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: /Hex Plus/, pressed: false }).click()
  await page.getByRole('button', { name: 'Apply' }).click()
  await expect(page.getByText('Done — your drone knows its motor layout.')).toBeVisible({ timeout: 15_000 })

  // Back to bringup via the Done button — should return us to the
  // bringup runner, not the library, because of the returnTo query.
  await page.getByRole('button', { name: 'Back to the wizard library' }).click()
  await expect(page.getByRole('heading', { name: 'Full bringup' })).toBeVisible()

  // Frame done — 2 of 3; motor-check still pending, so no banner yet.
  await expect(page.getByText('2 of 3 complete')).toBeVisible()
  await expect(page.getByText('Bringup complete!')).toHaveCount(0)

  // Run the motor check. The frame is now a Hex Plus and the FC applies
  // that live (it rebuilds the mixer + reassigns motor outputs while
  // disarmed), so this exercises the hexa geometry end-to-end — six
  // motors, no reboot needed.
  const motorRow = page.locator('li').filter({ hasText: 'Set up motors' })
  await motorRow.getByRole('link', { name: 'Start' }).click()
  await expect(page.getByRole('heading', { name: 'Set up motors' })).toBeVisible()
  // ESC setup runs first (booted DShot600 → already good) → continue.
  await expect(page.getByText('Your ESCs are set up well')).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await expect(page.getByText('Remove all propellers first')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText(/Hexa \+/)).toBeVisible()
  await page.getByRole('switch', { name: 'Propellers are removed' }).click()
  await page.getByRole('button', { name: 'Start motor check' }).click()

  // Confirm the six hexa-plus motors at their pre-selected expected
  // position + spin (front cw, then alternating round the ring).
  const hexaPlus = [
    { position: 'Front', direction: 'Clockwise' },
    { position: 'Front right', direction: 'Counter-clockwise' },
    { position: 'Rear right', direction: 'Clockwise' },
    { position: 'Rear', direction: 'Counter-clockwise' },
    { position: 'Rear left', direction: 'Clockwise' },
    { position: 'Front left', direction: 'Counter-clockwise' },
  ]
  for (let i = 0; i < hexaPlus.length; i++) {
    const step = hexaPlus[i]!
    const posButton = page.getByRole('button', { name: step.position, exact: true })
    await expect(posButton).toBeVisible({ timeout: 10_000 })
    await posButton.click()
    await page.getByRole('button', { name: step.direction, exact: true }).click()
    await page.getByRole('button', { name: i === hexaPlus.length - 1 ? 'Finish' : 'Next motor' }).click()
  }
  await expect(page.getByRole('heading', { name: 'Motors all check out' })).toBeVisible({ timeout: 10_000 })
  await page.getByRole('button', { name: 'Back to library' }).click()

  // All three steps complete; the celebratory done banner appears.
  await expect(page.getByRole('heading', { name: 'Full bringup' })).toBeVisible()
  await expect(page.getByText('3 of 3 complete')).toBeVisible()
  await expect(page.getByText('Bringup complete!')).toBeVisible()

  // Library card for bringup itself now shows the completion badge.
  await page.getByRole('link', { name: 'Bringup', exact: true }).click()
  const bringupCard = page.getByRole('link', { name: /Open the Full bringup wizard/ })
  await expect(bringupCard.getByText('Done')).toBeVisible()
  await expect(bringupCard.getByText(/All 3 bringup steps complete/)).toBeVisible()
})
