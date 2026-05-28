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

// Manifest for the Connections wizard. Owns the SERIALn_PROTOCOL +
// SERIALn_BAUD params for the standard SERIAL slots ArduPilot exposes
// (0..8 covers every SmallFastDrone-supported FC; rows the FC doesn't
// expose are silently ignored at runtime). Slice 1 ships the
// overview-table half — the detect-and-propose step lands in slice 2.
// See docs/WIZARDS.md.

import type { WizardManifest } from '../../workflow/wizard-runtime'

// Build owns_params declaratively so adding a slot is a one-line edit.
function serialParams(): string[] {
  const params: string[] = []
  for (let i = 0; i <= 8; i++) {
    params.push(`SERIAL${i}_PROTOCOL`, `SERIAL${i}_BAUD`)
  }
  return params
}

export const manifest: WizardManifest = {
  id: 'connections-setup',
  title: 'Set up connections',
  description: 'See what\'s plugged into each port on your drone, and set what each one does.',
  category: 'bringup',
  hero: 'i-lucide-cable',
  outcome: 'Each port on your drone knows what\'s plugged into it.',
  engines: [{ kind: 'desktop' }],
  owns_params: serialParams(),
  prerequisites: [
    { kind: 'connected', message: 'Your drone needs to be connected.' },
    { kind: 'heartbeat', message: 'Waiting to hear from your drone — give it a moment after plugging in.' },
  ],
  in_flight: false,
  requires_props_off: false,
}
