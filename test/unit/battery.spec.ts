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

// Unit tests for reading the flight battery from its voltage. The count
// is what everything else hangs on: a 5S read as 4S would put the
// low-battery landing a whole cell too early, and a 4S read as 5S would
// put it below the point the pack is damaged.

import { describe, expect, it } from 'vitest'
import { batteryEdits, batteryLabel, batterySummary, changedEdits, readAs, readBattery } from '../../src/workflow/battery'

// The cell count read from a voltage, or the reading's kind if none.
function cellsAt(volts: number | null): number | string {
  const r = readBattery(volts)
  return r.kind === 'read' ? r.cells : r.kind
}

describe('readBattery', () => {
  it('sees no battery on USB power alone', () => {
    expect(cellsAt(null)).toBe('none')
    expect(cellsAt(0)).toBe('none')
    expect(cellsAt(0.4)).toBe('none')
  })

  it('counts cells from full to part used, for every common pack', () => {
    for (let cells = 1; cells <= 6; cells++) {
      expect(cellsAt(cells * 4.2), `${cells}S full`).toBe(cells)
      // A full high-voltage 6S also fits a part-used 7S: asked, below.
      if (cells < 6)
        expect(cellsAt(cells * 4.35), `${cells}S high-voltage full`).toBe(cells)
      expect(cellsAt(cells * 3.8), `${cells}S storage`).toBe(cells)
      expect(cellsAt(cells * 3.7), `${cells}S getting low`).toBe(cells)
    }
  })

  it('reads a full 4S as 4S, not a flat 5S', () => {
    expect(cellsAt(16.8)).toBe(4)
  })

  it('reads a full 5S as 5S, not a nearly flat 6S', () => {
    // 21.0 V is 3.5 V a cell over six - too flat to count as 6S.
    expect(cellsAt(21.0)).toBe(5)
  })

  it('won\'t guess at a pack too flat to count', () => {
    // A nearly flat 6S at 3.55 V a cell is 21.3 V - which a full
    // high-voltage 5S also reads. Guessing 5S would set every threshold a
    // cell low; at 3.55 a cell it is a pack to charge, not to count.
    expect(cellsAt(13.6)).toBe('unclear')
    expect(cellsAt(4 * 3.6)).toBe('unclear')
  })

  it('asks when two counts both fit', () => {
    // A full high-voltage 6S (4.35 a cell) or a part-used 7S (3.73).
    const r = readBattery(26.1)
    expect(r).toEqual({ kind: 'either', volts: 26.1, cells: [6, 7] })
  })

  it('reads a pack as the count the operator picked', () => {
    expect(readAs(26.1, 6)).toMatchObject({ cells: 6, chemistry: 'lihv' })
    expect(readAs(26.1, 7)).toMatchObject({ cells: 7, chemistry: 'lipo' })
  })

  it('knows a high-voltage LiPo by a charge a plain one can\'t hold', () => {
    const r = readBattery(17.4)
    expect(r.kind === 'read' && r.cells).toBe(4)
    expect(r.kind === 'read' && r.chemistry).toBe('lihv')
    expect(readBattery(16.8).kind === 'read' && (readBattery(16.8) as { chemistry: string }).chemistry).toBe('lipo')
  })
})

describe('batteryEdits', () => {
  it('sets every threshold from the cell count', () => {
    const edits = Object.fromEntries(batteryEdits(4, 'lipo').map(e => [e.name, e.value]))
    expect(edits).toEqual({
      BATT_LOW_VOLT: 14,
      BATT_FS_LOW_ACT: 2,
      BATT_CRT_VOLT: 13.2,
      BATT_FS_CRT_ACT: 1,
      BATT_ARM_VOLT: 14.4,
      MOT_BAT_VOLT_MAX: 16.8,
      MOT_BAT_VOLT_MIN: 13.2,
    })
  })

  it('keeps the thresholds in order: take off above low, low above critical', () => {
    for (let cells = 1; cells <= 6; cells++) {
      const e = Object.fromEntries(batteryEdits(cells, 'lipo').map(x => [x.name, x.value]))
      expect(e.BATT_ARM_VOLT).toBeGreaterThan(e.BATT_LOW_VOLT!)
      expect(e.BATT_LOW_VOLT).toBeGreaterThan(e.BATT_CRT_VOLT!)
      expect(e.MOT_BAT_VOLT_MAX).toBeGreaterThan(e.MOT_BAT_VOLT_MIN!)
    }
  })

  it('rounds voltages so a float never reads as a change', () => {
    const crt = batteryEdits(3, 'lipo').find(e => e.name === 'BATT_CRT_VOLT')!
    expect(crt.value).toBe(9.9)
  })

  it('lets a high-voltage pack keep its top charge for thrust', () => {
    const max = batteryEdits(4, 'lihv').find(e => e.name === 'MOT_BAT_VOLT_MAX')!
    expect(max.value).toBe(17.4)
  })
})

describe('changedEdits', () => {
  it('leaves out what the drone already has, within float precision', () => {
    const now: Record<string, number> = { BATT_CRT_VOLT: 9.8999996, BATT_LOW_VOLT: 10.5, BATT_ARM_VOLT: 0 }
    const changed = changedEdits(
      [{ name: 'BATT_CRT_VOLT', value: 9.9 }, { name: 'BATT_LOW_VOLT', value: 10.5 }, { name: 'BATT_ARM_VOLT', value: 10.8 }],
      name => now[name],
    )
    expect(changed.map(e => e.name)).toEqual(['BATT_ARM_VOLT'])
  })

  it('leaves out a setting the drone doesn\'t have', () => {
    expect(changedEdits([{ name: 'NOT_A_PARAM', value: 1 }], () => undefined)).toEqual([])
  })
})

describe('operator copy', () => {
  it('says what each setting does, with the voltages, and no setting names', () => {
    const lines = batterySummary(4, 'lipo')
    expect(lines.join(' ')).toContain('14.0 V')
    expect(lines.join(' ')).not.toMatch(/[A-Z]{3,}_/)
  })

  it('describes the battery in a few words', () => {
    const r = readBattery(16.4)
    expect(r.kind).toBe('read')
    if (r.kind === 'read')
      expect(batteryLabel(r)).toBe('4-cell LiPo, 16.4 V, full')
  })
})
