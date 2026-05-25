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

// Registry of field tools — the catalogue behind the "Field tools" page, the
// things an operator can install onto the radio to run from the transmitter's
// own CRSF menu with no laptop. Deliberately a registry (not a single
// hardcoded install) so the operator installs only what they choose, and so
// the set can grow after the fact:
//
//   - Built-in tools carry their Lua assets (the applet + any shared modules)
//     as ?raw imports and install via the lua-engine FTP path.
//   - Paid tools are `locked` entries — they reuse the wizard library's
//     commercial gating seam (the Pro badge + entitlement check). They appear
//     greyed with "Unlock" until entitled; only then do they carry assets and
//     become installable. v1 ships the seam, not a payment integration.
//   - Custom (operator-supplied) tools come in behind expert mode, the same
//     posture as operator-supplied firmware DFU. The registry being data-
//     driven is what lets a custom or downloaded tool be added without
//     rebuilding the app.
//
// All asset uploads route through the lua-engine, which is the consumer of the
// security uploader seam (src/security/uploader.ts) — the same path DFU uses,
// and where signed/encrypted Lua for paid tools lands later. See
// docs/WIZARDS.md "Field tools catalogue".

import motorCheckApplet from '../wizards/motor-check/applet.lua?raw'
import motorCheckHelper from '../wizards/motor-check/crsf_helper.lua?raw'

// A shared Lua module an applet `require()`s, shipped alongside it.
export interface FieldModule {
  // Filename as the applet requires it (lands in scripts/modules/).
  name: string
  source: string
}

export interface FieldTool {
  // Applet id on the FC — the filename stem under APM/scripts/. Matches the
  // owning wizard's id where the tool is a wizard's radio counterpart.
  id: string
  // Operator-facing — no parameter names / MAVLink terms (docs/UX.md).
  name: string
  description: string
  icon: string
  // Lua applet source + any shared modules. Absent on a locked entry until
  // it's entitled (the seam): a locked tool advertises itself but ships no
  // assets to a non-entitled build.
  applet?: string
  modules?: FieldModule[]
  // Commercial gating — reuses the wizard library's locked/Pro seam.
  locked?: boolean
  // Why it's worth unlocking (shown on the Pro row), like a manifest's blurb.
  unlock_blurb?: string
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
  // Paid-tool seam (no implementation yet) — demonstrates that the catalogue
  // carries locked entries that slot in via the same gating as the wizard
  // library. Same "coming soon" posture as the pid-autotune-pro stub.
  {
    id: 'field-tune',
    name: 'Field tune',
    description: 'Touch up filtering and response from the radio after a field tweak, without a laptop.',
    icon: 'i-lucide-sparkles',
    locked: true,
    unlock_blurb: 'A paid field tool — coming soon.',
  },
]

// Tools that ship assets and aren't gated — installable right now.
export function installableTools(): FieldTool[] {
  return FIELD_TOOLS.filter(t => !t.locked && t.applet)
}

// Locked (paid) tools — shown as Pro rows until entitlement lands.
export function lockedTools(): FieldTool[] {
  return FIELD_TOOLS.filter(t => t.locked)
}
