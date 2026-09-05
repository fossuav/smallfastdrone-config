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

// Asking a drone for telemetry must not change the drone.
//
// ArduPilot treats REQUEST_DATA_STREAM as configuration and set_and_saves
// it into the MAVn_* parameters, so connecting used to leave a permanent
// mark - nine parameters moved from 0 to 2 on a bench board purely because
// the tool had been plugged in, and they then rode along in every settings
// backup. SET_MESSAGE_INTERVAL is the per-message equivalent and the
// firmware keeps it in RAM.

import { describe, expect, it } from 'vitest'
import {
  buildSetMessageInterval,
  MSGID_SYS_STATUS,
} from '../../src/protocol/mavlink'

const SYSID = 7
const COMPID = 1
const MAV_CMD_SET_MESSAGE_INTERVAL = 511

describe('buildSetMessageInterval', () => {
  it('addresses one message, at an interval in microseconds', () => {
    const cmd = buildSetMessageInterval(SYSID, COMPID, MSGID_SYS_STATUS, 500_000)
    expect(Number(cmd.command)).toBe(MAV_CMD_SET_MESSAGE_INTERVAL)
    expect(cmd._param1).toBe(MSGID_SYS_STATUS)
    expect(cmd._param2).toBe(500_000)
    expect(cmd.targetSystem).toBe(SYSID)
    expect(cmd.targetComponent).toBe(COMPID)
  })

  it('leaves the unused parameters clear', () => {
    const cmd = buildSetMessageInterval(SYSID, COMPID, MSGID_SYS_STATUS, 500_000)
    for (const p of [cmd._param3, cmd._param4, cmd._param5, cmd._param6, cmd._param7])
      expect(p).toBe(0)
  })

  it('passes -1 through, which is how a message is stopped', () => {
    expect(buildSetMessageInterval(SYSID, COMPID, MSGID_SYS_STATUS, -1)._param2).toBe(-1)
  })
})

describe('the persisting request is gone', () => {
  // The point of the change: no builder for it, so no way to send it by
  // reaching for the obvious name.
  it('offers no REQUEST_DATA_STREAM builder', async () => {
    const mavlink = await import('../../src/protocol/mavlink') as Record<string, unknown>
    expect(mavlink.buildRequestDataStream).toBeUndefined()
  })
})
