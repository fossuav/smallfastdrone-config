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

// The ground station's own heartbeat. The tool doesn't otherwise send
// one. The props-on motor probe does while it runs, because the applet on
// the drone stops spinning motors when the heartbeat goes quiet - an
// unplugged laptop must not leave props pulsing with nobody watching.
// ArduPilot takes a HEARTBEAT from its configured ground-station system
// id (MAV_GCS_SYSID, default 255, which is what this tool sends as) to
// mean the ground station is there; gcs:last_seen() in Lua reads it.

import { Heartbeat, MavAutopilot, MavState, MavType } from 'mavlink-mappings/dist/lib/minimal'

// Build a HEARTBEAT saying "a ground station is here".
export function buildGcsHeartbeat(): Heartbeat {
  const hb = new Heartbeat()
  hb.type = MavType.GCS
  hb.autopilot = MavAutopilot.INVALID
  hb.baseMode = 0 as Heartbeat['baseMode']
  hb.customMode = 0
  hb.systemStatus = MavState.ACTIVE
  hb.mavlinkVersion = 3
  return hb
}
