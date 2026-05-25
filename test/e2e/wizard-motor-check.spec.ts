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

// End-to-end tests for the "Set up motors" wizard against SITL.
// scripts/sitl-start.sh boots SITL as a quad X (FRAME_CLASS=1,
// FRAME_TYPE=1) with DShot600 + telemetry (MOT_PWM_TYPE=6, SERVO_BLH_BDMASK),
// correctly "wired", so the ESC-setup phase lands already-configured
// (Continue) and an operator who confirms each motor where/how the firmware
// expects gets an all-clear. Drives real MAV_CMD_DO_MOTOR_TEST spins.
//
// The wizard's first phase is ESC setup; openMotorCheck() clicks through it
// (Continue) to reach the motor-check safety gate. A final test exercises
// the ESC apply path (change protocol → restart → reconnect).
//
// Four flows (in run order, so the only mutating one is last):
//  1. happy path — confirm every motor correct → review pass → Done badge.
//  2. order swap (no writes) — report a front-left/front-right swap; the
//     wizard offers a custom output remap ("wired to the wrong spot").
//  3. one motor reversed (no writes) — the wizard offers a software reverse
//     when the FC exposes SERVO_BLH_RVMASK (BLHeli builds, incl. the
//     blheli-sitl branch), or manual-fix guidance when it doesn't (stock
//     SITL). Robust to both via an either/or assertion.
//  4. props-out (slice 2b, writes) — toggle props-out, confirm the motors,
//     and the wizard recognises the build matches a standard props-out
//     layout and switches FRAME_TYPE to it (X→H), restarts, and
//     auto-reconnects. A frame-type change needs no reverse mask, so this
//     works on stock SITL too. Reaching "Fix applied" proves SITL acked the
//     write. Leaves FRAME_TYPE=H — harmless: it's the last motor-touching
//     spec, wizard.spec.ts (next) only checks the vehicle is a quad (H is),
//     and SITL is restarted fresh each run.
//
// Only flow 4 changes FC state, and only flows that apply trigger a reboot;
// the rest just read, so they don't hit the post-reboot motor-test settle
// window.
//
// The wizard steps motors in the firmware's test order — a clockwise sweep
// from the front-right: front-right → rear-right → rear-left → front-left,
// each with its expected spin.

import type { Page } from '@playwright/test'
import { expect, test } from '@playwright/test'

const SITL_QUERY = '?transport=websocket&host=localhost:5761'
const SITL_URL = `/${SITL_QUERY}`

const X_SEQUENCE = [
  { position: 'Front right', direction: 'Counter-clockwise' },
  { position: 'Rear right', direction: 'Clockwise' },
  { position: 'Rear left', direction: 'Counter-clockwise' },
  { position: 'Front left', direction: 'Clockwise' },
]

// Front-right and front-left reported swapped (each motor keeps its own
// spin) — an order error with no direction fault. The wizard should offer a
// SERVOn_FUNCTION remap.
const X_SWAP_SEQUENCE = [
  { position: 'Front left', direction: 'Clockwise' }, // T1 expected front-right/ccw
  { position: 'Rear right', direction: 'Clockwise' },
  { position: 'Rear left', direction: 'Counter-clockwise' },
  { position: 'Front right', direction: 'Counter-clockwise' }, // T4 expected front-left/cw
]

// Every motor in the right place, but the front-right spins the wrong way.
const X_REVERSED_SEQUENCE = [
  { position: 'Front right', direction: 'Clockwise' }, // T1 should be counter-clockwise
  { position: 'Rear right', direction: 'Clockwise' },
  { position: 'Rear left', direction: 'Counter-clockwise' },
  { position: 'Front left', direction: 'Clockwise' },
]

// Correct positions, every motor reversed — a props-out build. The wizard
// should recognise this as the props-out (H) layout, not 4 individual
// reverses.
const X_PROPS_OUT_SEQUENCE = [
  { position: 'Front right', direction: 'Clockwise' }, // props-out: was ccw
  { position: 'Rear right', direction: 'Counter-clockwise' }, // was cw
  { position: 'Rear left', direction: 'Clockwise' }, // was ccw
  { position: 'Front left', direction: 'Counter-clockwise' }, // was cw
]

// Connect to SITL and open the "Set up motors" wizard, clicking through the
// ESC-setup phase (SITL boots DShot600 + telemetry, so it's already
// configured — Continue) and stopping at the motor-check safety gate.
async function openMotorCheck(page: Page) {
  await page.goto(SITL_URL)
  await page.getByRole('button', { name: 'Connect drone' }).click()
  await expect(page.getByText(/Connected to your \w+/)).toBeVisible({ timeout: 15_000 })
  await page.getByRole('link', { name: 'Bringup' }).click()
  await page.getByRole('link', { name: /Open the Set up motors wizard/ }).click()
  await expect(page.getByRole('heading', { name: 'Set up motors' })).toBeVisible()
  // ESC setup runs first. SITL boots DShot600, so it's usually already-good
  // ("Continue"); but if a sluggish post-reboot param load shows the
  // recommend path instead, "Set up & continue" gets us there too (it
  // applies DShot600 + reboots — harmless). Accept either.
  const continueBtn = page.getByRole('button', { name: 'Continue', exact: true })
  const setupBtn = page.getByRole('button', { name: 'Set up & continue' })
  await expect(continueBtn.or(setupBtn)).toBeVisible({ timeout: 30_000 })
  await (await continueBtn.isVisible() ? continueBtn : setupBtn).click()
  // 90s budget covers the (rare) reboot the setup path would trigger.
  await expect(page.getByText('Remove all propellers first')).toBeVisible({ timeout: 90_000 })
}

// Walk every motor, reporting the given position + direction for each, and
// advance (Finish on the last). The safety gate must already be passed.
async function walkMotors(
  page: Page,
  sequence: Array<{ position: string, direction: string }>,
) {
  for (let i = 0; i < sequence.length; i++) {
    const step = sequence[i]!
    const posButton = page.getByRole('button', { name: step.position, exact: true })
    // A motor test is occasionally rejected by SITL (EKF still settling /
    // arming state) — the wizard then shows its spin-error + "Spin again"
    // instead of the answer buttons. Wait for whichever appears and retry
    // the spin once so the walk is robust to that flake.
    const spinError = page.getByText('wouldn\'t spin that motor')
    await expect(posButton.or(spinError)).toBeVisible({ timeout: 10_000 })
    if (await spinError.isVisible()) {
      await page.getByRole('button', { name: 'Spin again' }).click()
      await expect(posButton).toBeVisible({ timeout: 10_000 })
    }
    await posButton.click()
    await page.getByRole('button', { name: step.direction, exact: true }).click()
    const advance = i === sequence.length - 1 ? 'Finish' : 'Next motor'
    await page.getByRole('button', { name: advance }).click()
  }
}

test('Motor check passes when every motor is confirmed correct (SITL quad X)', async ({ page }) => {
  await openMotorCheck(page)
  await expect(page.getByText(/Quad X/)).toBeVisible()
  await page.getByRole('switch', { name: 'Propellers are removed' }).click()
  await page.getByRole('button', { name: 'Start motor check' }).click()

  // Walk all four motors. Each auto-spins; position + direction are
  // pre-selected to the expected values — we confirm them.
  await walkMotors(page, X_SEQUENCE)

  // Review: all correct → Done badge on the library card.
  await expect(page.getByRole('heading', { name: 'Motors all check out' })).toBeVisible({ timeout: 10_000 })
  await page.getByRole('button', { name: 'Back to library' }).click()
  await expect(page.getByRole('heading', { name: 'Bringup wizards' })).toBeVisible()
  const card = page.getByRole('link', { name: /Open the Set up motors wizard/ })
  await expect(card.getByText('Done')).toBeVisible()
})

test('Motor check offers an output remap for a non-standard swap (SITL quad X)', async ({ page }) => {
  await openMotorCheck(page)
  await page.getByRole('switch', { name: 'Propellers are removed' }).click()
  await page.getByRole('button', { name: 'Start motor check' }).click()

  // Front-left/front-right swap — not a standard order, so the wizard offers
  // a per-output remap. (No apply: keeps SITL state clean for later specs.)
  await walkMotors(page, X_SWAP_SEQUENCE)
  await expect(page.getByText('Some motors need attention')).toBeVisible({ timeout: 10_000 })
  await expect(page.getByText(/wired to the wrong spot/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Fix this for me' })).toBeVisible()

  await page.getByRole('button', { name: 'Run again' }).click()
  await expect(page.getByText('Remove all propellers first')).toBeVisible()
})

test('Motor check offers a reverse or manual guidance for a backwards motor (SITL)', async ({ page }) => {
  await openMotorCheck(page)
  await page.getByRole('switch', { name: 'Propellers are removed' }).click()
  await page.getByRole('button', { name: 'Start motor check' }).click()

  // One motor spinning the wrong way. On a BLHeli build (SERVO_BLH_RVMASK
  // present, incl. the blheli-sitl branch) the wizard offers a software
  // reverse; on stock SITL it shows manual-fix guidance. Accept either, and
  // don't apply.
  await walkMotors(page, X_REVERSED_SEQUENCE)
  const fixButton = page.getByRole('button', { name: 'Fix this for me' })
  const guidance = page.getByText('can\'t be reversed automatically').or(page.getByText('Direction can\'t be fixed automatically here'))
  await expect(fixButton.or(guidance)).toBeVisible({ timeout: 10_000 })

  await page.getByRole('button', { name: 'Run again' }).click()
  await expect(page.getByText('Remove all propellers first')).toBeVisible()
})

test('Motor check switches to the props-out layout, restarts, and reconnects (SITL quad X)', async ({ page }) => {
  // One reboot/reconnect cycle — give it room.
  test.setTimeout(120_000)

  await openMotorCheck(page)
  await page.getByRole('switch', { name: 'Propellers are removed' }).click()
  // Declare a props-out build before starting.
  await page.getByRole('switch', { name: 'Props-out build' }).click()
  await page.getByRole('button', { name: 'Start motor check' }).click()

  // Motors in the right place but all spinning props-out → the wizard
  // recognises the props-out (H) layout and switches FRAME_TYPE to it.
  await walkMotors(page, X_PROPS_OUT_SEQUENCE)
  await expect(page.getByText('Your motors match a standard layout')).toBeVisible({ timeout: 10_000 })
  const fixButton = page.getByRole('button', { name: 'Fix this for me' })
  await expect(fixButton).toBeVisible()

  // Apply: write FRAME_TYPE → restart → auto-reconnect → re-check screen.
  // Reaching "Fix applied" proves SITL acked the write and the wizard
  // survives its own reboot. A frame-type change needs no reverse mask, so
  // this passes on stock SITL too.
  await fixButton.click()
  await expect(page.getByText('Restarting your drone…')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText('Fix applied — let\'s check again')).toBeVisible({ timeout: 90_000 })
})

test('Motor check installs the field version, detects it on reopen, and removes it', async ({ page }) => {
  test.setTimeout(150_000)
  // Relies on scripting being enabled by an earlier spec
  // (wizard-imu-noise-live, which runs before this one and leaves
  // SCR_ENABLE=1) — same dependency style as that spec.
  await openMotorCheck(page)

  // Not installed yet (directory listing found no applet) → install.
  await page.getByRole('button', { name: 'Install on radio' }).click()
  await expect(page.getByRole('button', { name: 'Remove from radio' })).toBeVisible({ timeout: 60_000 })

  // Reopen the wizard: the on-mount directory-listing check must detect the
  // applet on the FC and show it as installed (not back to "Install").
  await openMotorCheck(page)
  await expect(page.getByRole('button', { name: 'Remove from radio' })).toBeVisible({ timeout: 30_000 })

  // Remove → reopen → detected as not installed again (clean for later specs).
  await page.getByRole('button', { name: 'Remove from radio' }).click()
  await expect(page.getByRole('button', { name: 'Install on radio' })).toBeVisible({ timeout: 30_000 })
  await openMotorCheck(page)
  await expect(page.getByRole('button', { name: 'Install on radio' })).toBeVisible({ timeout: 30_000 })
})

test('ESC setup: changing the protocol applies, restarts, and reconnects (SITL)', async ({ page }) => {
  // One reboot/reconnect cycle. Runs last — it changes MOT_PWM_TYPE.
  test.setTimeout(120_000)
  await page.goto(SITL_URL)
  await page.getByRole('button', { name: 'Connect drone' }).click()
  await expect(page.getByText(/Connected to your \w+/)).toBeVisible({ timeout: 15_000 })
  await page.getByRole('link', { name: 'Bringup' }).click()
  await page.getByRole('link', { name: /Open the Set up motors wizard/ }).click()

  // ESC setup is already-good (booted DShot600); go expert and pick a
  // different protocol so there's a real change to apply (works on any
  // build — MOT_PWM_TYPE always exists, unlike the BLHeli telemetry param).
  await expect(page.getByText('Your ESCs are set up well')).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: 'Choose myself' }).click()
  // Bidir DShot is configurable in SITL now (HAL_WITH_BIDIR_DSHOT on the
  // blheli-sitl branch) — the telemetry toggle is enabled, not greyed out.
  await expect(page.getByRole('switch', { name: 'RPM telemetry' })).toBeEnabled()
  await page.getByRole('button', { name: 'DShot300', exact: true }).click()
  await page.getByRole('button', { name: 'Apply & continue' }).click()

  // Apply writes MOT_PWM_TYPE → restart → auto-reconnect → motor-check
  // safety gate. Reaching it proves SITL acked the write + the wizard
  // survived its own reboot.
  await expect(page.getByText('Restarting your drone…')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText('Remove all propellers first')).toBeVisible({ timeout: 90_000 })
})
