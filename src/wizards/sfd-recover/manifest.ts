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

// Manifest for the exit ceremony (T3's view). The customer's escape
// hatch: back out of SmallFastDrone entirely, keeping the drone's
// settings across a mass erase. Owns no parameters - it reads all of them
// into a backup and writes them back, but claiming ownership would lock
// the whole set out of the param browser. See docs/SECURITY.md
// "The exit ceremony" + docs/WIZARDS.md.

import type { WizardManifest } from '../../workflow/wizard-runtime'

export const manifest: WizardManifest = {
  id: 'sfd-recover',
  title: 'Remove your drone\'s security',
  description: 'Take this drone back out of SmallFastDrone, keeping the settings you have now.',
  category: 'safety',
  hero: 'i-lucide-shield-off',
  outcome: 'Your drone is back to ordinary firmware, with your settings put back.',
  engines: [{ kind: 'desktop' }],
  // Param names this wizard reads/writes (the operator never sees these).
  owns_params: [],
  prerequisites: [
    { kind: 'connected', message: 'Your drone needs to be connected.' },
    { kind: 'heartbeat', message: 'Waiting to hear from your drone — give it a moment after plugging in.' },
  ],
  in_flight: false,
  requires_props_off: false,
}
