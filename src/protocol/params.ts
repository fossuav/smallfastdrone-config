import type { MavParamType } from 'mavlink-mappings/dist/lib/common'
import { CommandLong, MavCmd, ParamRequestList, ParamSet } from 'mavlink-mappings/dist/lib/common'
import metadataRaw from './param-metadata.json'

// PARAM_REQUEST_LIST / PARAM_VALUE flow.
//
// Operator triggers a fetch; FC streams one PARAM_VALUE per parameter
// (typically a few hundred to a few thousand). Each carries its index +
// the total count so we can show progress and detect completion.
//
// Today: protocol-layer helpers only. The fetch loop itself lives in
// stores/params.ts so it can use the session store's send/subscribe
// helpers without us having to expose the raw MavLinkSession instance.
//
// Editing + commit (PARAM_SET + PREFLIGHT_STORAGE) lands in next slices.

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

export function buildParamRequestList(targetSystem: number, targetComponent: number): ParamRequestList {
  const req = new ParamRequestList()
  req.targetSystem = targetSystem
  req.targetComponent = targetComponent
  return req
}

// Pad a param name to the 16-byte MAVLink param_id slot. Strings shorter
// than 16 chars are null-terminated; exactly-16 fill the field without a
// terminator. Our serializer handles either case.
export function buildParamSet(targetSystem: number, targetComponent: number, name: string, value: number, type: MavParamType): ParamSet {
  const ps = new ParamSet()
  ps.targetSystem = targetSystem
  ps.targetComponent = targetComponent
  ps.paramId = name
  ps.paramValue = value
  ps.paramType = type
  return ps
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

export function getParamMeta(name: string): ParamMeta | undefined {
  return metadata[name]
}
