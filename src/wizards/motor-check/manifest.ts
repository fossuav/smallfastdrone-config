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

// Manifest for the "Set up motors" wizard (bringup phase 04, see
// docs/BRINGUP.md). Two phases in dependency order: first ESC setup —
// output protocol + bidirectional DShot (opinionated default DShot600 +
// RPM telemetry) — then the classic "props off, which one moved?" motor
// order + direction check, which offers to fix what's wrong (a FRAME_TYPE
// switch or SERVOn_FUNCTION remap for order, SERVO_BLH_RVMASK for
// direction). ESC setup comes first because the direction auto-fix needs
// DShot.
//
// requires_props_off is the load-bearing flag here: this is the one
// bringup wizard that physically spins motors.

import type { WizardManifest } from '../../workflow/wizard-runtime'

export const manifest: WizardManifest = {
  id: 'motor-check',
  title: 'Set up motors',
  description: 'Set your ESC protocol, then spin each motor to check it\'s in the right place and turning the right way.',
  category: 'bringup',
  hero: 'i-lucide-fan',
  outcome: 'Your ESCs are configured and every motor is in the right place, spinning the right way.',
  engines: [{ kind: 'desktop' }],
  // ESC setup writes MOT_PWM_TYPE + SERVO_BLH_BDMASK (+POLES); the motor
  // check reads the frame layout and, on a fix, writes the affected
  // SERVOn_FUNCTION channels / FRAME_TYPE plus SERVO_BLH_RVMASK.
  owns_params: ['FRAME_CLASS', 'FRAME_TYPE', 'MOT_PWM_TYPE', 'SERVO_BLH_BDMASK', 'SERVO_BLH_POLES', 'SERVO_BLH_RVMASK'],
  prerequisites: [
    { kind: 'connected', message: 'Your drone needs to be connected.' },
    { kind: 'heartbeat', message: 'Waiting to hear from your drone — give it a moment after plugging in.' },
  ],
  in_flight: false,
  // This wizard spins motors. The operator must confirm props are off.
  requires_props_off: true,
  // Installable on the radio's CRSF menu for no-laptop use at the field
  // (src/wizards/motor-check/applet.lua). Install/remove lives on the
  // wizard's safety screen.
  field_capable: true,
}
