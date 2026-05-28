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

test('Wizard library lists bringup wizards; frame-select writes FRAME_CLASS+TYPE to SITL', async ({ page }) => {
  await page.goto(SITL_URL)
  await page.getByRole('button', { name: 'Connect drone' }).click()
  await expect(page.getByText('Connected to your Quadcopter')).toBeVisible({ timeout: 15_000 })

  // Open the library: Bringup → ribbon → "All wizards" → library.
  await page.getByRole('link', { name: 'Bringup' }).click()
  await page.getByRole('link', { name: 'All wizards' }).click()
  await expect(page.getByRole('heading', { name: 'Bringup wizards' })).toBeVisible()

  // Unlocked card for frame-select is present.
  await expect(page.getByRole('link', { name: /Open the Pick your frame wizard/ })).toBeVisible()
  // Pro PID tune lives in Recipes now, not the library — the library has
  // no "Pro wizards" section.
  await expect(page.getByText('Pro wizards — coming soon')).toHaveCount(0)
  await expect(page.getByRole('link', { name: /Open the Pro PID tune wizard/ })).toHaveCount(0)

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

test('Recipes hosts Pro PID tune (the locked-gating seam on the recipes surface)', async ({ page }) => {
  // No connection needed — Recipes renders from the static wizard registry
  // and the locked card renders regardless of capability.
  await page.goto(`/recipes${SITL_QUERY}`)
  await expect(page.getByRole('heading', { name: 'Tuning recipes' })).toBeVisible()
  await expect(page.getByText('Pro recipes — coming soon')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Pro PID tune' })).toBeVisible()
  await expect(page.getByText('Coming soon — a paid Pro wizard')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Coming soon' })).toBeDisabled()
})

test('Bringup ribbon walks preflight + frame-select + connections + motor-check and marks itself complete', async ({ page }) => {
  // Two reboot-free reconfigs + a hexa motor walk — give it room.
  test.setTimeout(120_000)

  await page.goto(SITL_URL)
  await page.getByRole('button', { name: 'Connect drone' }).click()
  // Loose vehicle-type match — the earlier frame-select happy-path test
  // persists FRAME_CLASS=2 to SITL, so subsequent specs see SITL report
  // as a Hexacopter rather than the default Quadcopter. Either is fine.
  await expect(page.getByText(/Connected to your \w+/)).toBeVisible({ timeout: 15_000 })

  // Bringup nav lands on the ribbon directly (the runner mounts the
  // bringup wizard's DesktopView = the ribbon).
  await page.getByRole('link', { name: 'Bringup', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Full bringup' })).toBeVisible()
  // Pre-flight tab is the default (first incomplete).
  await expect(page.getByRole('tab', { name: /Pre-flight check/ })).toBeVisible({ timeout: 15_000 })

  // Complete preflight inline — no FC writes, just operator confirmation.
  // The button's leave() returns to the ribbon, which auto-advances.
  await page.getByRole('button', { name: /Looks good/ }).click()

  // Auto-advanced to Frame: the frame picker is the inline content.
  // Pick Hex Plus, Apply, then "Back to the wizard library" returns to
  // the ribbon (via returnTo), which auto-advances to Motors.
  await expect(page.getByRole('button', { name: /Hex Plus/, pressed: false })).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: /Hex Plus/, pressed: false }).click()
  await page.getByRole('button', { name: 'Apply' }).click()
  await expect(page.getByText('Done — your drone knows its motor layout.')).toBeVisible({ timeout: 15_000 })
  await page.getByRole('button', { name: 'Back to the wizard library' }).click()

  // Connections tab: the ribbon panel renders the live UART table from
  // @SYS/uarts.txt + SERIALn_PROTOCOL params. Slice 1 only marks the
  // tab done — slice 2 will add the detect-and-propose step.
  await expect(page.getByRole('cell', { name: 'SERIAL0' })).toBeVisible({ timeout: 15_000 })
  await page.getByRole('button', { name: 'Done', exact: true }).click()

  // Motors tab: skipEsc → motor-check opens straight on the safety gate
  // (ESC config lives in the ribbon's panel above). Six-motor hexa walk
  // exercises the hexa geometry end-to-end — no reboot needed.
  await expect(page.getByText('Remove all propellers first')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText(/Hexa \+/)).toBeVisible()
  await page.getByRole('switch', { name: 'Propellers are removed' }).click()
  await page.getByRole('button', { name: 'Start motor check' }).click()

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

  // All three sub-wizards complete → bringup auto-marks itself; the
  // library card shows the Done badge with the outcome from the watcher.
  // Library is one hop further now (Bringup nav → ribbon → All wizards).
  await page.getByRole('link', { name: 'Bringup', exact: true }).click()
  await page.getByRole('link', { name: 'All wizards' }).click()
  const bringupCard = page.getByRole('link', { name: /Open the Full bringup wizard/ })
  await expect(bringupCard.getByText('Done')).toBeVisible({ timeout: 15_000 })
  await expect(bringupCard.getByText(/All 4 bringup steps complete/)).toBeVisible()
})

test('Connections tab reads @SYS/uarts.txt + SERIAL params from SITL into the live table', async ({ page }) => {
  await page.goto(SITL_URL)
  await page.getByRole('button', { name: 'Connect drone' }).click()
  await expect(page.getByText(/Connected to your \w+/)).toBeVisible({ timeout: 15_000 })

  // Navigate via SPA links so the session survives. The ribbon's tabs
  // are deep-linkable (?area=...) but a fresh page.goto() reloads + drops
  // Pinia state, so click the tab in-page instead.
  await page.getByRole('link', { name: 'Bringup', exact: true }).click()
  await page.getByRole('tab', { name: /Set up connections/ }).click()
  await expect(page.getByRole('heading', { name: 'Set up connections', level: 2 })).toBeVisible({ timeout: 15_000 })

  // Table reads from @SYS/uarts.txt — SITL exposes 9 SERIAL slots.
  // SERIAL0 is the GCS link (USB / OTG on hardware) and is always
  // active since we're talking on it; assert that signal is present.
  const serial0 = page.getByRole('row', { name: /SERIAL0/ })
  await expect(serial0).toBeVisible({ timeout: 15_000 })
  await expect(serial0).toContainText(/MAVLink2|MAVLink/)
  await expect(serial0).toContainText('Active')

  // SERIAL3 on SITL is the GPS port — protocol cell reads "GPS".
  await expect(page.getByRole('row', { name: /SERIAL3/ })).toContainText('GPS')

  // The full SERIAL set the FC reported is in the table.
  for (const id of ['SERIAL0', 'SERIAL1', 'SERIAL2', 'SERIAL3', 'SERIAL4', 'SERIAL5', 'SERIAL6', 'SERIAL7', 'SERIAL8'])
    await expect(page.getByRole('cell', { name: id, exact: true })).toBeVisible()

  // Refresh re-reads without leaving.
  await page.getByRole('button', { name: 'Refresh' }).click()
  await expect(page.getByRole('row', { name: /SERIAL0/ })).toContainText('Active')
})
