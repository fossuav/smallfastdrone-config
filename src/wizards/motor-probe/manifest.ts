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

// Manifest for the props-on motor probe: with the props on and the drone
// flat on the floor, an applet on the drone pulses each motor and works
// out from its own gyro where the motor is, which way it turns, and
// whether its prop lifts. The first slice of PLAN decision 48 - a
// measuring instrument, behind expert mode until bench runs settle its
// thresholds. It changes no setting the drone keeps.

import type { WizardManifest } from '../../workflow/wizard-runtime'

export const manifest: WizardManifest = {
  id: 'motor-probe',
  title: 'Measure motors with props on',
  description: 'With its props on, the drone spins each motor in short bursts and works out for itself where each one is and which way it turns.',
  category: 'diagnostic',
  hero: 'i-lucide-activity',
  outcome: 'Every motor measured with its prop on.',
  engines: [{ kind: 'lua', applet: 'applet.lua', requires: { scripting: true } }],
  // The applet's own settings, plus two it changes only for the run (in
  // memory) and puts back: the gyro filter, so a short pulse isn't
  // smeared, and logging while disarmed, so the run is recorded.
  owns_params: ['MPRB_ACTIVE', 'INS_GYRO_FILTER', 'LOG_DISARMED'],
  prerequisites: [
    { kind: 'connected', message: 'Your drone needs to be connected.' },
    { kind: 'heartbeat', message: 'Waiting to hear from your drone — give it a moment after plugging in.' },
  ],
  in_flight: false,
  // Props ON, by design - the view runs its own safety gate.
  requires_props_off: false,
  expert_only: true,
}
