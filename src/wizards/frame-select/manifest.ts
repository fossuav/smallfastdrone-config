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

// Manifest for the frame-select wizard. The first end-to-end wizard the
// tool ships — demonstrates the desktop-engine contract end-to-end by
// letting the operator pick their drone's motor layout and writing
// FRAME_CLASS + FRAME_TYPE to the FC. See docs/WIZARDS.md.

import type { WizardManifest } from '../../workflow/wizard-runtime'

export const manifest: WizardManifest = {
  id: 'frame-select',
  title: 'Pick your frame',
  description: 'Tell us what shape your drone is — quad, hex, octo, X, Plus.',
  category: 'bringup',
  hero: 'i-lucide-orbit',
  outcome: 'Your drone knows its motor layout.',
  engines: [{ kind: 'desktop' }],
  owns_params: ['FRAME_CLASS', 'FRAME_TYPE'],
  prerequisites: [
    { kind: 'connected', message: 'Your drone needs to be connected.' },
    { kind: 'heartbeat', message: 'Waiting to hear from your drone — give it a moment after plugging in.' },
  ],
  in_flight: false,
  // The wizard never spins motors — it only sets configuration params.
  // Props-on or off doesn't change the safety calculus.
  requires_props_off: false,
}
