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

// The bringup chain, as data, so the ribbon and the catalogue agree on
// it. The ribbon walks these in order; the catalogue reads them to say
// how far through the guided path this drone is, and to mark the same
// wizards as steps of it rather than loose entries.
//
// It lives here rather than inside the ribbon's DesktopView because a
// `<script setup>` block exports nothing — and two hand-kept copies of
// an ordered list is precisely the drift that makes a catalogue and a
// sequence disagree about what "done" means.

// Ordered chain of bringup areas. Pre-arm readiness is deliberately NOT
// here - that's a phase-05 (pre-first-flight) gate, not an opening-step
// concern. See docs/BRINGUP.md. Securing comes last: it is about the
// drone's identity rather than whether it will fly, and on a drone that
// isn't an SFD drone the panel says so rather than disappearing
// (WIZARDS.md, "never silently hide").
export const BRINGUP_AREA_IDS = ['preflight', 'frame-select', 'connections-setup', 'motor-check', 'sfd-enable'] as const

// Areas offered in the chain but which never gate its completion.
// Bringup is about getting the drone flying; securing is about its
// identity, and most drones cannot be secured at all - gating on it
// would mean an ordinary ArduPilot drone could never finish bringup.
export const BRINGUP_OPTIONAL_AREA_IDS: ReadonlySet<string> = new Set(['sfd-enable'])

// The steps that actually have to be done for bringup to count as done.
export function requiredBringupAreas(): string[] {
  return BRINGUP_AREA_IDS.filter(id => !BRINGUP_OPTIONAL_AREA_IDS.has(id))
}
