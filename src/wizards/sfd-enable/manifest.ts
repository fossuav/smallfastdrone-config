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

// Manifest for the SFD enable wizard - the identity half of the ceremony
// in docs/SECURITY.md (T7). Asks the drone to make its own identity and
// hands the operator the file that proves it. Owns no parameters: the
// identity lives in the bootloader sector, reached over SECURE_COMMAND,
// not in the parameter store. See docs/WIZARDS.md + src/wizards/CLAUDE.md.

import type { WizardManifest } from '../../workflow/wizard-runtime'

export const manifest: WizardManifest = {
  id: 'sfd-enable',
  title: 'Secure your drone',
  description: 'Give your drone its own identity, so it can run SmallFastDrone\'s protected features.',
  category: 'safety',
  hero: 'i-lucide-shield-check',
  outcome: 'Your drone has its own identity, and you have the file that proves it.',
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
