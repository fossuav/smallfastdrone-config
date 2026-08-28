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

// Parser for ArduPilot's packed parameter file, served over MAVLink-FTP at
// `@PARAM/param.pck`. Requested with `?withdefaults=1` it is the only
// authoritative source for a drone's *default* values: the firmware knows
// its own board- and frame-specific defaults, and no static metadata table
// can (ArduPilot's param metadata carries ReadOnly but no Default at all).
//
// The firmware attaches a default to an entry only when the current value
// differs from it — so "has a default attached" reads directly as "the
// operator changed this", which is what the settings backup saves.
//
// Wire format, from AP_Filesystem/AP_Filesystem_Param.cpp:
//
//   header:  uint16 magic, uint16 num_params, uint16 total_params  (LE)
//            magic 0x671b plain, 0x671c when defaults are included
//   entry:   uint8  type:4 | flags:4        flags bit 0 = default follows
//            uint8  common_len:4 | (name_len-1):4
//            uint8  name[name_len]          appended to the previous name's
//                                           first common_len characters
//            uint8  value[type_size]
//            uint8  default[type_size]      only when the flag is set
//
// Zero bytes between entries are padding the firmware inserts to stop a
// value straddling a read-block boundary; they are unambiguous because a
// real entry's type nibble is never zero.

// AP_Param's ap_var_type, narrowed to the scalar types param.pck emits.
export const PARAM_PACK_TYPE = {
  INT8: 1,
  INT16: 2,
  INT32: 3,
  FLOAT: 4,
} as const

export type ParamPackType = typeof PARAM_PACK_TYPE[keyof typeof PARAM_PACK_TYPE]

const MAGIC_PLAIN = 0x671B
const MAGIC_WITH_DEFAULTS = 0x671C

const HEADER_LEN = 6

export interface PackedParam {
  name: string
  type: ParamPackType
  value: number
  // The firmware's default for this parameter, present only when it
  // differs from `value`. null therefore means "at its default" — but
  // only trust that when the pack was fetched with defaults; see
  // ParamPack.withDefaults.
  defaultValue: number | null
}

export interface ParamPack {
  // True when this pack was fetched with `?withdefaults=1`. When false,
  // every defaultValue is null because none were requested, not because
  // every parameter is at its default.
  withDefaults: boolean
  // How many parameters the FC says it has in total. A pack fetched
  // without start/count holds all of them, so this should match
  // params.length; a mismatch means a truncated download.
  totalParams: number
  params: PackedParam[]
}

// Decode a packed parameter file. Throws with an operator-readable
// message on anything malformed — a partly-decoded parameter set is
// worse than none, because the caller would treat missing entries as
// "at default" and silently drop them from a backup.
export function parseParamPack(bytes: Uint8Array): ParamPack {
  if (bytes.byteLength < HEADER_LEN)
    throw new Error('Your drone sent an empty settings list.')

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const magic = view.getUint16(0, true)
  if (magic !== MAGIC_PLAIN && magic !== MAGIC_WITH_DEFAULTS)
    throw new Error('Your drone sent a settings list this tool doesn\'t understand.')

  const withDefaults = magic === MAGIC_WITH_DEFAULTS
  const totalParams = view.getUint16(4, true)

  const params: PackedParam[] = []
  let offset = HEADER_LEN
  let previousName = ''

  while (offset < bytes.byteLength) {
    // Padding between entries. A real entry never starts with a zero
    // byte, since that would encode AP_PARAM_NONE.
    if (bytes[offset] === 0) {
      offset++
      continue
    }

    if (offset + 2 > bytes.byteLength)
      throw new Error('Your drone\'s settings list ended unexpectedly.')

    const typeAndFlags = bytes[offset]!
    const nameLengths = bytes[offset + 1]!
    offset += 2

    const type = typeAndFlags & 0x0F
    const hasDefault = (typeAndFlags >> 4) & 0x01
    const commonLen = nameLengths & 0x0F
    const nameLen = ((nameLengths >> 4) & 0x0F) + 1

    const typeSize = paramTypeSize(type)
    if (typeSize === null)
      throw new Error(`Your drone reported a setting of an unknown kind (${type}).`)

    const needed = nameLen + typeSize + (hasDefault ? typeSize : 0)
    if (offset + needed > bytes.byteLength)
      throw new Error('Your drone\'s settings list ended unexpectedly.')

    // Names are stored as a shared prefix plus the tail that differs, so
    // a run like SERIAL1_BAUD / SERIAL1_PROTOCOL costs only the suffix.
    const suffix = String.fromCharCode(...bytes.subarray(offset, offset + nameLen))
    const name = previousName.slice(0, commonLen) + suffix
    previousName = name
    offset += nameLen

    const value = readValue(view, type as ParamPackType, offset)
    offset += typeSize

    let defaultValue: number | null = null
    if (hasDefault) {
      defaultValue = readValue(view, type as ParamPackType, offset)
      offset += typeSize
    }

    params.push({ name, type: type as ParamPackType, value, defaultValue })
  }

  return { withDefaults, totalParams, params }
}

// The names of every parameter the drone has been changed away from its
// factory default. This is what a settings backup saves: the delta is the
// configuration, and it is what restores cleanly onto freshly-flashed
// firmware that boots at defaults.
//
// Throws when the pack wasn't fetched with defaults, because the answer
// would otherwise be a confident, silent "none of them".
export function changedParamNames(pack: ParamPack): Set<string> {
  if (!pack.withDefaults)
    throw new Error('Your drone didn\'t report which settings it has changed.')
  const names = new Set<string>()
  for (const p of pack.params) {
    if (p.defaultValue !== null)
      names.add(p.name)
  }
  return names
}

// Byte width of each AP_Param scalar type. null for anything else —
// VECTOR3F and GROUP never appear here because the firmware walks
// scalars only.
function paramTypeSize(type: number): number | null {
  switch (type) {
    case PARAM_PACK_TYPE.INT8: return 1
    case PARAM_PACK_TYPE.INT16: return 2
    case PARAM_PACK_TYPE.INT32: return 4
    case PARAM_PACK_TYPE.FLOAT: return 4
    default: return null
  }
}

// Values are the raw parameter storage, so integers are signed and
// little-endian and floats are IEEE-754 single precision. `offset` indexes
// the same buffer window the DataView was built over.
function readValue(view: DataView, type: ParamPackType, offset: number): number {
  switch (type) {
    case PARAM_PACK_TYPE.INT8: return view.getInt8(offset)
    case PARAM_PACK_TYPE.INT16: return view.getInt16(offset, true)
    case PARAM_PACK_TYPE.INT32: return view.getInt32(offset, true)
    case PARAM_PACK_TYPE.FLOAT: return view.getFloat32(offset, true)
  }
}
