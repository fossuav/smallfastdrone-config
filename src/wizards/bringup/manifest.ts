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

// Manifest for the bringup meta-wizard. Bringup itself owns no FC
// state — its DesktopView is a sequencer that walks the operator
// through a fixed ordered list of sub-wizards and tracks their
// completion. Each sub-wizard runs in its own URL and owns its own
// state; bringup just keeps the operator oriented. See docs/WIZARDS.md
// "Bringup as meta-wizard" + docs/BRINGUP.md.

import type { WizardManifest } from '../../workflow/wizard-runtime'

export const manifest: WizardManifest = {
  id: 'bringup',
  title: 'Full bringup',
  description: 'Guided, opinionated walk through every part of getting your drone configured.',
  category: 'bringup',
  hero: 'i-lucide-list-checks',
  outcome: 'Your drone is configured, checked, and ready for its first flight.',
  engines: [{ kind: 'desktop' }],
  owns_params: [],
  prerequisites: [
    { kind: 'connected', message: 'Your drone needs to be connected.' },
    { kind: 'heartbeat', message: 'Waiting to hear from your drone — give it a moment after plugging in.' },
  ],
  in_flight: false,
  requires_props_off: false,
}
