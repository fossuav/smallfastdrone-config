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

// Protocol-layer helpers for the parameter system: builders for
// PARAM_REQUEST_LIST / PARAM_SET / PREFLIGHT_STORAGE, formatters for the
// wire value (int vs float), and the per-parameter metadata accessor
// backed by the SFD-derived param-metadata.json blob.
//
// Operator triggers a fetch; the FC streams one PARAM_VALUE per parameter
// (typically a few hundred to a few thousand). Each PARAM_VALUE carries
// its index + the total count so the fetch loop in stores/params.ts can
// show progress and detect completion.
//
// The metadata blob is built from SFD's apm.pdef.xml by
// scripts/build-param-metadata.py and regenerated on submodule bumps via
// `bun run params:rebuild`. Stays bundled with the app so the operator
// gets parameter documentation offline.

import type { MavParamType } from 'mavlink-mappings/dist/lib/common'
import { CommandLong, MavCmd, ParamRequestList, ParamRequestRead, ParamSet } from 'mavlink-mappings/dist/lib/common'
import metadataRaw from './param-metadata.json'

export const MSGID_PARAM_VALUE = 22
export const MSGID_COMMAND_ACK = 77

// MAV_CMD_PREFLIGHT_STORAGE param1 actions (from MavLink spec).
export const PREFLIGHT_STORAGE_PARAM_SAVE = 1

export interface ParamRecord {
  name: string
  value: number
  type: MavParamType
  index: number
}

// Build a PARAM_REQUEST_LIST that asks the FC to stream every parameter
// it knows about. The FC responds with one PARAM_VALUE per parameter; the
// fetch loop in stores/params.ts assembles them into the params map.
export function buildParamRequestList(targetSystem: number, targetComponent: number): ParamRequestList {
  const req = new ParamRequestList()
  req.targetSystem = targetSystem
  req.targetComponent = targetComponent
  return req
}

// Build a PARAM_SET to write a single parameter. The FC echoes the new
// value back as a PARAM_VALUE on success (the apply path in
// stores/params.ts uses that echo to confirm the write landed).
// The param_id field is the 16-byte MAVLink slot; strings shorter than
// 16 chars are null-terminated, exactly-16 fill the field without a
// terminator, and the serializer handles either case.
export function buildParamSet(targetSystem: number, targetComponent: number, name: string, value: number, type: MavParamType): ParamSet {
  const ps = new ParamSet()
  ps.targetSystem = targetSystem
  ps.targetComponent = targetComponent
  ps.paramId = name
  ps.paramValue = value
  ps.paramType = type
  return ps
}

// Build a PARAM_REQUEST_READ for a single parameter by name. The FC
// replies with one PARAM_VALUE (or nothing if the param doesn't exist).
// Used to probe for a parameter that may have just come into existence —
// e.g. a Lua applet's control param after a scripting restart — without
// re-streaming the whole param set. param_index=-1 selects by name.
export function buildParamRequestRead(targetSystem: number, targetComponent: number, name: string): ParamRequestRead {
  const req = new ParamRequestRead()
  req.targetSystem = targetSystem
  req.targetComponent = targetComponent
  req.paramId = name
  req.paramIndex = -1
  return req
}

// MAV_CMD_PREFLIGHT_STORAGE with param1=1 → save current parameters to
// non-volatile storage (EEPROM/flash). FC ACKs via COMMAND_ACK.
export function buildPreflightStorageSave(targetSystem: number, targetComponent: number): CommandLong {
  const cmd = new CommandLong()
  cmd.targetSystem = targetSystem
  cmd.targetComponent = targetComponent
  cmd.command = MavCmd.PREFLIGHT_STORAGE
  cmd._param1 = PREFLIGHT_STORAGE_PARAM_SAVE
  cmd._param2 = 0
  cmd._param3 = 0
  cmd._param4 = 0
  cmd._param5 = 0
  cmd._param6 = 0
  cmd._param7 = 0
  cmd.confirmation = 0
  return cmd
}

// Render a param value as a string for display. Integer types are floored
// from the float wire representation; float types show with sensible precision.
export function formatParamValue(value: number, type: MavParamType): string {
  // MavParamType enum values:
  //   1..8  = (U)INT8..(U)INT64
  //   9     = REAL32
  //   10    = REAL64
  if (type >= 1 && type <= 8) {
    return Math.trunc(value).toString()
  }
  // Floats: trim trailing zeros after the decimal point.
  return Number.parseFloat(value.toPrecision(7)).toString()
}

// Short human label for a MAV_PARAM_TYPE value, used by the param browser
// in expert mode to surface the underlying wire type alongside the value.
export function paramTypeLabel(type: MavParamType): string {
  switch (type) {
    case 1: return 'uint8'
    case 2: return 'int8'
    case 3: return 'uint16'
    case 4: return 'int16'
    case 5: return 'uint32'
    case 6: return 'int32'
    case 7: return 'uint64'
    case 8: return 'int64'
    case 9: return 'float'
    case 10: return 'double'
    default: return `type ${type}`
  }
}

// Per-parameter metadata extracted from the SFD source by
// scripts/build-param-metadata.py and committed at
// src/protocol/param-metadata.json. ~5700 entries.
// Regenerate after `git submodule update --remote vendor/smallfastdrone`
// via `bun run params:rebuild`.
export interface ParamMeta {
  displayName?: string
  description?: string
  units?: string
  range?: { low?: string, high?: string }
  bitmask?: Record<string, string>
  values?: Record<string, string>
  user?: string
  rebootRequired?: string
}

const metadata = metadataRaw as Record<string, ParamMeta>

// Look up the static SFD-derived metadata for a parameter. Returns
// undefined for parameters the FC reports that aren't in the bundled
// blob (e.g. a custom Lua-defined param, or a vehicle-specific param the
// metadata generator didn't cover).
export function getParamMeta(name: string): ParamMeta | undefined {
  return metadata[name]
}

// If the param has `Values` metadata (enum-style) and the value matches a
// declared key, return the human label. Otherwise undefined.
export function getValueLabel(name: string, value: number): string | undefined {
  const m = metadata[name]
  if (!m?.values)
    return undefined
  // Param values are floats on the wire; for Values lookup we expect ints.
  const key = String(Math.trunc(value))
  return m.values[key]
}

// If the param has `Bitmask` metadata, decode the value's set bits into a
// readable label like "UseRTLOnAbort | DualAircraftSynchronised". Zero
// returns undefined.
export function getBitmaskLabel(name: string, value: number): string | undefined {
  const m = metadata[name]
  if (!m?.bitmask)
    return undefined
  const v = Math.trunc(value)
  if (v === 0)
    return undefined
  const set: string[] = []
  for (const [bit, label] of Object.entries(m.bitmask)) {
    const bitNum = Number.parseInt(bit, 10)
    if (Number.isFinite(bitNum) && (v & (1 << bitNum)) !== 0) {
      set.push(label)
    }
  }
  return set.length > 0 ? set.join(' | ') : undefined
}

// Combined human label: Values takes priority, then Bitmask.
export function describeParamValue(name: string, value: number): string | undefined {
  return getValueLabel(name, value) ?? getBitmaskLabel(name, value)
}

// Tooltip hint about valid range, e.g. "Range: 0.1 to 100".
export function getRangeHint(name: string): string | undefined {
  const m = metadata[name]
  if (!m?.range)
    return undefined
  const low = m.range.low
  const high = m.range.high
  if (low === undefined && high === undefined)
    return undefined
  if (low !== undefined && high !== undefined)
    return `Range: ${low} to ${high}`
  if (low !== undefined)
    return `Minimum: ${low}`
  return `Maximum: ${high}`
}
