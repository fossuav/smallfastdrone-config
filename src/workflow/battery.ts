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

// The flight battery: worked out from its voltage, and turned into the
// drone's battery settings. The operator plugs the battery in anyway -
// the motors need it - so how many cells it has is read, not asked (PLAN
// decision 44), and everything that follows from the cell count is set
// from it: when it warns and comes home, when it lands, what it won't
// take off on, and the range it keeps its thrust steady across as the
// battery drains. Pure, so the counting is unit-tested.
//
// Fresh-drone defaults are why this matters: the low-battery warning sits
// at 10.5 V whatever the battery, which blocks arming on anything under
// a charged 3S, and both battery failsafes only warn.

// LiPo, or high-voltage LiPo (charged to 4.35 V a cell), told apart by a
// full charge a plain LiPo can't hold. Li-ion can't be told from LiPo by
// its voltage, and wants lower thresholds; it isn't handled yet (TODO.md).
export type Chemistry = 'lipo' | 'lihv'

// Where a plugged-in cell can sit for its count to be read: from a pack
// that is still worth flying (about a fifth left) up to a full
// high-voltage one. The bottom is set by the counts, not the chemistry:
// at 3.5 V a cell a nearly flat 6S reads exactly like a full 5S, and
// guessing the lower count is the dangerous way round - every threshold a
// cell low, so the next 6S is flown down to 2.9 V a cell. At 3.65 the
// windows for 1S to 6S don't touch; a flatter pack is "charge it", and a
// count above that whose window does touch a neighbour's is asked.
const CELL_READ_MIN = 3.65
const CELL_READ_MAX = 4.36
// A cell resting above this can only be high-voltage LiPo.
const LIHV_ABOVE = 4.22
// Below this there's no flight battery, just USB power and sensor noise.
const NO_BATTERY_BELOW = 2.5
const MAX_CELLS = 12

// Volts a cell for each setting. Low and critical are ArduPilot's usual
// LiPo advice, read under load over BATT_LOW_TIMER (10 s), so a punch-out
// doesn't trip them. Take-off needs a little more than low, resting, so
// a pack that would trip low straight away can't be flown. The thrust
// range is what ArduPilot's own parameter descriptions recommend.
const LOW_PER_CELL = 3.5
const CRITICAL_PER_CELL = 3.3
const ARM_PER_CELL = 3.6
const FULL_PER_CELL: Record<Chemistry, number> = { lipo: 4.2, lihv: 4.35 }
const EMPTY_PER_CELL = 3.3

// BATT_FS_*_ACT values. Low comes home, which lands instead when the drone
// has no position to come home to (Copter's set_mode_RTL_or_land_with_pause),
// so it is safe with or without GPS. Critical lands where it is.
const FS_ACTION_RTL = 2
const FS_ACTION_LAND = 1

// A battery whose cell count is known.
export interface BatteryRead {
  kind: 'read'
  volts: number
  cells: number
  chemistry: Chemistry
  perCell: number
}

// What the battery voltage says. `unclear` is too flat (or too high) to
// count; `either` is two counts that both fit, for the operator to pick.
export type BatteryReading
  = | { kind: 'none' }
    | { kind: 'unclear', volts: number }
    | { kind: 'either', volts: number, cells: number[] }
    | BatteryRead

// Read the battery as a given number of cells.
export function readAs(volts: number, cells: number): BatteryRead {
  const perCell = volts / cells
  return { kind: 'read', volts, cells, chemistry: perCell > LIHV_ABOVE ? 'lihv' : 'lipo', perCell }
}

// Work out the battery from its voltage.
export function readBattery(volts: number | null): BatteryReading {
  if (volts === null || volts < NO_BATTERY_BELOW)
    return { kind: 'none' }
  const fits: number[] = []
  for (let n = 1; n <= MAX_CELLS; n++) {
    const perCell = volts / n
    if (perCell >= CELL_READ_MIN && perCell <= CELL_READ_MAX)
      fits.push(n)
  }
  if (fits.length === 0)
    return { kind: 'unclear', volts }
  if (fits.length > 1)
    return { kind: 'either', volts, cells: fits }
  return readAs(volts, fits[0]!)
}

// One setting the battery decides.
export interface BatteryEdit {
  name: string
  value: number
}

// Round a voltage to the hundredth, so 3 x 3.3 is 9.9 and not 9.8999...
function volts2(v: number): number {
  return Math.round(v * 100) / 100
}

// Every setting that follows from the cell count.
export function batteryEdits(cells: number, chemistry: Chemistry): BatteryEdit[] {
  return [
    { name: 'BATT_LOW_VOLT', value: volts2(cells * LOW_PER_CELL) },
    { name: 'BATT_FS_LOW_ACT', value: FS_ACTION_RTL },
    { name: 'BATT_CRT_VOLT', value: volts2(cells * CRITICAL_PER_CELL) },
    { name: 'BATT_FS_CRT_ACT', value: FS_ACTION_LAND },
    { name: 'BATT_ARM_VOLT', value: volts2(cells * ARM_PER_CELL) },
    { name: 'MOT_BAT_VOLT_MAX', value: volts2(cells * FULL_PER_CELL[chemistry]) },
    { name: 'MOT_BAT_VOLT_MIN', value: volts2(cells * EMPTY_PER_CELL) },
  ]
}

// The drone stores these as 32-bit floats, so 9.9 comes back as 9.8999996.
const SAME_WITHIN = 0.005

// The settings that differ from what the drone has now. A setting the
// drone doesn't have (current undefined) is left out: there's nothing to
// write it to.
export function changedEdits(edits: BatteryEdit[], current: (name: string) => number | undefined): BatteryEdit[] {
  return edits.filter((e) => {
    const now = current(e.name)
    return now !== undefined && Math.abs(now - e.value) > SAME_WITHIN
  })
}

// Volts as an operator reads them.
function v(x: number): string {
  return `${x.toFixed(1)} V`
}

// What the settings mean, in the operator's terms, one line each.
export function batterySummary(cells: number, chemistry: Chemistry): string[] {
  return [
    `Comes home when the battery gets low (${v(cells * LOW_PER_CELL)}), or lands if it has no way home`,
    `Lands where it is when the battery is nearly flat (${v(cells * CRITICAL_PER_CELL)})`,
    `Won't take off on a battery below ${v(cells * ARM_PER_CELL)}`,
    `Keeps its thrust steady as the battery drains from ${v(cells * FULL_PER_CELL[chemistry])} to ${v(cells * EMPTY_PER_CELL)}`,
  ]
}

// The battery in a few words: "4-cell LiPo, 16.4 V, full".
export function batteryLabel(r: BatteryRead): string {
  const type = r.chemistry === 'lihv' ? 'high-voltage LiPo' : 'LiPo'
  const charge = r.perCell >= 4.1 ? 'full' : r.perCell >= 3.75 ? 'part used' : 'getting low'
  return `${r.cells}-cell ${type}, ${r.volts.toFixed(1)} V, ${charge}`
}
