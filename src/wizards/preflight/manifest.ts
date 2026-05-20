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

// Manifest for the preflight sub-wizard. Owns no params — it's an
// operator-facing sanity check before bringup starts changing
// configuration. Lets the operator look at the drone, its firmware,
// and its sensor health, and confirm everything's where it should be.
// See docs/WIZARDS.md + docs/BRINGUP.md.

import type { WizardManifest } from '../../workflow/wizard-runtime'

export const manifest: WizardManifest = {
  id: 'preflight',
  title: 'Pre-flight check',
  description: 'Eyeball the basics before we change anything — vehicle, firmware, sensors.',
  category: 'bringup',
  hero: 'i-lucide-clipboard-check',
  outcome: 'You\'ve confirmed the basics — link, sensors, firmware all look right.',
  engines: [{ kind: 'desktop' }],
  owns_params: [],
  prerequisites: [
    { kind: 'connected', message: 'Your drone needs to be connected.' },
    { kind: 'heartbeat', message: 'Waiting to hear from your drone — give it a moment after plugging in.' },
  ],
  in_flight: false,
  requires_props_off: false,
}
