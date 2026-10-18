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

// Unit tests for the port probe's decisions. What matters most is what it
// never touches: the port the tool talks over, a port with a role nothing
// here recognises, and a device that's already working. Then that a run
// cut short puts every port back as it was.

import type { PortResult, PortRole } from '../../src/workflow/port-probe'
import { describe, expect, it } from 'vitest'
import {
  baudCode,
  findingLabel,
  outcomeEdits,
  planRoles,
  portResult,
  portsToProbe,
  restoreEdits,
} from '../../src/workflow/port-probe'

// A drone's port roles, SERIALn -> [protocol, baud].
function roles(entries: Record<number, [number, number]>): Map<number, PortRole> {
  return new Map(Object.entries(entries).map(([n, [protocol, baud]]) => [Number(n), { protocol, baud }]))
}

// A TBS Lucid H7's defaults: MAVLink on USB, GPS on 2, DJI video on 3,
// telemetry on 4 and 7, a receiver on 6, ESC telemetry on 8, 1 and 5 free.
const LUCID = roles({ 0: [2, 115], 1: [-1, 57], 2: [5, 230], 3: [42, 115], 4: [2, 57], 5: [-1, 57], 6: [23, 115], 7: [2, 57], 8: [16, 115] })

// A result for a port.
function found(serial: number, finding: PortResult['finding'], baud: number | null = null): [number, PortResult] {
  return [serial, { serial, finding, baud, bytes: 100 }]
}

describe('portsToProbe', () => {
  it('listens on free ports and on a receiver or GPS port that isn\'t working', () => {
    expect(portsToProbe(LUCID, { receiverWorking: false, gpsWorking: false })).toEqual([1, 2, 5, 6])
  })

  it('leaves a working receiver and a working GPS alone', () => {
    expect(portsToProbe(LUCID, { receiverWorking: true, gpsWorking: true })).toEqual([1, 5])
  })

  it('never touches USB, telemetry, video or ESC telemetry', () => {
    const probed = portsToProbe(LUCID, { receiverWorking: false, gpsWorking: false })
    for (const n of [0, 3, 4, 7, 8])
      expect(probed).not.toContain(n)
  })

  it('treats the unused console setting as no role', () => {
    expect(portsToProbe(roles({ 1: [0, 57] }), { receiverWorking: true, gpsWorking: true })).toEqual([1])
  })
})

describe('portResult', () => {
  it('waits until all of a port\'s result has arrived', () => {
    expect(portResult(5, new Map([['S5FOUND', 2], ['S5BAUD', 420000]]))).toBeNull()
  })

  it('reads a receiver, and a silent port', () => {
    const values = new Map([['S5FOUND', 2], ['S5BAUD', 420000], ['S5BYTES', 30], ['S6FOUND', 0], ['S6BAUD', 0], ['S6BYTES', 0]])
    expect(portResult(5, values)).toEqual({ serial: 5, finding: 'crsf', baud: 420000, bytes: 30 })
    expect(portResult(6, values)).toEqual({ serial: 6, finding: 'silent', baud: null, bytes: 0 })
  })
})

describe('planRoles', () => {
  it('sets a found receiver and GPS, and puts back a port where nothing was found', () => {
    const probed = [1, 2, 5, 6]
    const results = new Map([found(1, 'ubx', 115200), found(2, 'silent'), found(5, 'crsf', 420000), found(6, 'silent')])
    const plan = planRoles(probed, results, LUCID)
    expect(plan).toEqual([
      { serial: 1, kind: 'gps', finding: 'ubx', baud: 115200 },
      { serial: 2, kind: 'restore', role: { protocol: 5, baud: 230 }, why: 'nothing' },
      { serial: 5, kind: 'receiver', finding: 'crsf' },
      { serial: 6, kind: 'restore', role: { protocol: 23, baud: 115 }, why: 'nothing' },
    ])
  })

  it('won\'t set a second receiver when one is already set up and working', () => {
    // The receiver on SERIAL6 works, so it wasn't probed; a second CRSF
    // device on SERIAL1 (a second receiver, a backpack) stays as it was.
    const plan = planRoles([1, 5], new Map([found(1, 'crsf', 420000)]), LUCID)
    expect(plan[0]).toEqual({ serial: 1, kind: 'restore', role: { protocol: -1, baud: 57 }, why: 'second-receiver' })
  })

  it('takes the first receiver when two are found', () => {
    const plan = planRoles([1, 5], new Map([found(1, 'crsf', 420000), found(5, 'crsf', 420000)]), roles({ 1: [-1, 57], 5: [-1, 57] }))
    expect(plan.map(o => o.kind)).toEqual(['receiver', 'restore'])
  })

  it('sets at most two GPS', () => {
    const r = roles({ 1: [-1, 57], 2: [-1, 57], 5: [-1, 57] })
    const plan = planRoles([1, 2, 5], new Map([found(1, 'nmea', 9600), found(2, 'ubx', 38400), found(5, 'nmea', 9600)]), r)
    expect(plan.map(o => o.kind)).toEqual(['gps', 'gps', 'restore'])
  })

  it('puts back a port that never reported', () => {
    const plan = planRoles([5], new Map(), LUCID)
    expect(plan).toEqual([{ serial: 5, kind: 'restore', role: { protocol: -1, baud: 57 }, why: 'nothing' }])
  })
})

describe('outcomeEdits', () => {
  it('writes a receiver\'s role, and a GPS\'s role and baud', () => {
    const edits = outcomeEdits([
      { serial: 5, kind: 'receiver', finding: 'crsf' },
      { serial: 1, kind: 'gps', finding: 'ubx', baud: 115200 },
    ])
    expect(edits).toEqual([
      { name: 'SERIAL5_PROTOCOL', value: 23 },
      { name: 'SERIAL1_PROTOCOL', value: 5 },
      { name: 'SERIAL1_BAUD', value: 115 },
    ])
  })

  it('puts every probed port back exactly as it was', () => {
    expect(restoreEdits([2, 6], LUCID)).toEqual([
      { name: 'SERIAL2_PROTOCOL', value: 5 },
      { name: 'SERIAL2_BAUD', value: 230 },
      { name: 'SERIAL6_PROTOCOL', value: 23 },
      { name: 'SERIAL6_BAUD', value: 115 },
    ])
  })
})

describe('baudCode', () => {
  it('encodes rates the way SERIALn_BAUD does, not as plain thousands', () => {
    expect(baudCode(9600)).toBe(9)
    expect(baudCode(57600)).toBe(57)
    expect(baudCode(115200)).toBe(115)
    expect(baudCode(460800)).toBe(460)
  })
})

describe('findingLabel', () => {
  it('names each finding without protocol jargon', () => {
    expect(findingLabel('crsf')).toBe('ELRS / Crossfire receiver')
    expect(findingLabel('ubx')).toBe('GPS')
    expect(findingLabel('silent')).toBe('Nothing heard')
  })
})
