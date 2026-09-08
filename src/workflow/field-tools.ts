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

// The Lua assets behind a field-capable wizard — the applet (+ any shared
// modules) that gets installed onto the FC so the wizard can be run from the
// transmitter's own CRSF menu with no laptop.
//
// This is deliberately NOT a catalogue. Which recipes have a radio version is
// declared by the wizard manifests (`field_capable: true`), and the operator
// sees them in the one catalogue (PLAN decision 43); this registry holds only
// what a manifest cannot carry, which is a .lua file. Keyed by wizard id, so
// the join is exact. It used to double as the catalogue behind a `/field`
// page, and a second list of the same things is how the two came to disagree.
//
// Deliberately a registry (not a single hardcoded install) so the operator
// installs only what they choose, and so the set can grow after the fact:
//
//   - Built-in tools carry their Lua assets as ?raw imports and install via
//     the lua-engine FTP path.
//   - Paid ones are locked *wizard manifests* — the same commercial gating
//     seam as everything else in the catalogue, not a parallel one. A locked
//     entry ships no assets to a non-entitled build; entitlement is where the
//     assets and the install become available.
//   - Custom (operator-supplied) tools come in behind expert mode, the same
//     posture as operator-supplied firmware DFU. The registry being data-
//     driven is what lets a custom or downloaded tool be added without
//     rebuilding the app.
//
// All asset uploads route through the lua-engine, which is the consumer of the
// security uploader seam (src/security/uploader.ts) — the same path DFU uses,
// and where signed Lua for paid tools lands later. That was aspirational when
// written and became true on 2026-09-07; encrypted applets from SFD go the same
// way. See docs/WIZARDS.md "Field-capable wizards".

import motorCheckApplet from '../wizards/motor-check/applet.lua?raw'
import motorCheckHelper from '../wizards/motor-check/crsf_helper.lua?raw'

// A shared Lua module an applet `require()`s, shipped alongside it.
export interface FieldModule {
  // Filename as the applet requires it (lands in scripts/modules/).
  name: string
  source: string
}

export interface FieldTool {
  // Applet id on the FC — the filename stem under APM/scripts/. This is the
  // owning wizard's id: it is what joins the assets to the manifest that
  // declared `field_capable`.
  id: string
  // Operator-facing — no parameter names / MAVLink terms (docs/UX.md).
  name: string
  description: string
  icon: string
  // Lua applet source + any shared modules. Optional because a paid entry
  // ships no assets to a non-entitled build — the gating itself lives on the
  // wizard manifest (`locked`), not here.
  applet?: string
  modules?: FieldModule[]
}

export const FIELD_TOOLS: FieldTool[] = [
  {
    id: 'motor-check',
    name: 'Motor check',
    description: 'Spin each motor and fix order + direction from the radio — handy after a field repair or motor swap.',
    icon: 'i-lucide-fan',
    applet: motorCheckApplet,
    modules: [{ name: 'crsf_helper.lua', source: motorCheckHelper }],
  },
]

// Tools that actually ship assets — installable right now.
export function installableTools(): FieldTool[] {
  return FIELD_TOOLS.filter(t => t.applet)
}

// The assets for one field-capable wizard, or undefined if it declares a
// radio version but nothing has been built yet. The catalogue lists the
// manifest and looks the assets up here, so a manifest that promises a radio
// version we cannot install simply doesn't offer one.
export function fieldToolFor(wizardId: string): FieldTool | undefined {
  return installableTools().find(t => t.id === wizardId)
}
