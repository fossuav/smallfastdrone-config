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

// Manifest for the motor-check wizard (bringup phase 04, see
// docs/BRINGUP.md). Spins each motor in turn and has the operator confirm
// it's in the right place and turning the right way — the classic
// "props off, which one moved?" check. This slice detects and reports;
// auto-correction (output remap + DShot reverse) lands in a follow-up.
//
// requires_props_off is the load-bearing flag here: this is the one
// bringup wizard that physically spins motors.

import type { WizardManifest } from '../../workflow/wizard-runtime'

export const manifest: WizardManifest = {
  id: 'motor-check',
  title: 'Check motor spin',
  description: 'Spin each motor in turn and confirm it\'s in the right place and turning the right way.',
  category: 'bringup',
  hero: 'i-lucide-fan',
  outcome: 'Every motor is in the right place and spinning the right way.',
  engines: [{ kind: 'desktop' }],
  // Reads the frame layout to know the motor map; the detection slice
  // writes nothing. The correction slice adds SERVOn_FUNCTION +
  // SERVO_BLH_RVMASK here.
  owns_params: ['FRAME_CLASS', 'FRAME_TYPE'],
  prerequisites: [
    { kind: 'connected', message: 'Your drone needs to be connected.' },
    { kind: 'heartbeat', message: 'Waiting to hear from your drone — give it a moment after plugging in.' },
  ],
  in_flight: false,
  // This wizard spins motors. The operator must confirm props are off.
  requires_props_off: true,
}
