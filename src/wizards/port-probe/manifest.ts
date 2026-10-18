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

// Manifest for the port probe: an applet on the drone listens on every
// serial port not already working and recognises what's plugged in - a
// radio receiver or a GPS so far - and the tool sets each port's role from
// it. Two restarts: one to hand the ports to the applet, one to give them
// their roles. Behind expert mode until it has been proven on real
// hardware (PLAN decision 49).

import type { WizardManifest } from '../../workflow/wizard-runtime'

export const manifest: WizardManifest = {
  id: 'port-probe',
  title: 'Find what\'s plugged in',
  description: 'The drone listens on its own connections and works out what\'s plugged in, so each one can be set up without asking you.',
  category: 'diagnostic',
  hero: 'i-lucide-cable',
  outcome: 'Each connection set up for what\'s plugged into it.',
  engines: [{ kind: 'lua', applet: 'applet.lua', requires: { scripting: true } }],
  // The ports' roles and bauds it hands over and sets (SERIAL1..15), and
  // scripting, turned on for the run if it was off and back off after.
  owns_params: ['PPRB_ACTIVE', 'SCR_ENABLE', 'SERIALn_PROTOCOL', 'SERIALn_BAUD'],
  prerequisites: [
    { kind: 'connected', message: 'Your drone needs to be connected.' },
    { kind: 'heartbeat', message: 'Waiting to hear from your drone — give it a moment after plugging in.' },
  ],
  in_flight: false,
  // Nothing spins: it only listens.
  requires_props_off: false,
  expert_only: true,
}
