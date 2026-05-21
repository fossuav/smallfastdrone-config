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

// Manifest for the IMU noise check wizard — the tool's first Lua-engine
// wizard. Uploads applet.lua, drives it via WIZ_NOISE_ACTIVE, listens
// for NAMED_VALUE_FLOAT (wn_prog + wn_max), reports the max gyro
// magnitude seen during a 5-second still sample.
//
// `engines: [{ kind: 'lua', applet: 'applet.lua', requires: { scripting: true } }]`
// declares the wizard as Lua-engine for future engine-aware runtime
// selection. The current runtime doesn't act on the descriptor
// (DesktopView orchestrates the Lua side directly via useLuaEngine()),
// but the manifest carries the truth so a later slice can lift the
// orchestration into the runtime.

import type { WizardManifest } from '../../workflow/wizard-runtime'

export const manifest: WizardManifest = {
  id: 'imu-noise',
  title: 'Check sensor noise',
  description: 'See how quiet your drone\'s gyros are at rest — a quick mounting / vibration check.',
  category: 'diagnostic',
  hero: 'i-lucide-activity',
  outcome: 'You know how noisy your IMU is, and whether the airframe needs vibration work.',
  engines: [{ kind: 'lua', applet: 'applet.lua', requires: { scripting: true } }],
  owns_params: ['WIZ_NOISE_ACTIVE'],
  prerequisites: [
    { kind: 'connected', message: 'Your drone needs to be connected.' },
    { kind: 'heartbeat', message: 'Waiting to hear from your drone — give it a moment after plugging in.' },
  ],
  in_flight: false,
  requires_props_off: false,
}
