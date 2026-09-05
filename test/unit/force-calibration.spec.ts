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

// MAV_CMD_PREFLIGHT_CALIBRATION is a shared message: the same command that
// accepts a stored calibration also *starts* real ones, decided entirely by
// which slot a value lands in. param1 = 1 begins a gyro calibration and
// param5 = 4 begins an accelerometer calibration - neither is something to
// start by accident while an operator is putting settings back after a
// wipe. So the slots are pinned here rather than trusted to review.

import { describe, expect, it } from 'vitest'
import { buildForceSaveCalibration } from '../../src/protocol/mavlink'

const SYSID = 7
const COMPID = 1
const MAV_CMD_PREFLIGHT_CALIBRATION = 241
const ACCEPT_STORED = 76

describe('buildForceSaveCalibration', () => {
  it('accepts the stored compass and accel calibration', () => {
    const cmd = buildForceSaveCalibration(SYSID, COMPID)
    expect(Number(cmd.command)).toBe(MAV_CMD_PREFLIGHT_CALIBRATION)
    expect(cmd._param2).toBe(ACCEPT_STORED) // magnetometer slot
    expect(cmd._param5).toBe(ACCEPT_STORED) // accelerometer slot
    expect(cmd.targetSystem).toBe(SYSID)
    expect(cmd.targetComponent).toBe(COMPID)
  })

  it('starts no gyro calibration — param1 must not be 1', () => {
    expect(buildForceSaveCalibration(SYSID, COMPID)._param1).toBe(0)
  })

  it('starts no accelerometer calibration — param5 must not be 4 or 2', () => {
    const p5 = buildForceSaveCalibration(SYSID, COMPID)._param5
    expect(p5).not.toBe(4) // simple accel cal
    expect(p5).not.toBe(2) // level
    expect(p5).not.toBe(1) // gyro cal via the int slot
  })

  it('leaves every other slot clear', () => {
    const cmd = buildForceSaveCalibration(SYSID, COMPID)
    for (const p of [cmd._param3, cmd._param4, cmd._param6, cmd._param7])
      expect(p).toBe(0)
  })
})
