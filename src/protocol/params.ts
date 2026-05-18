import type { MavParamType } from 'mavlink-mappings/dist/lib/common'
import { ParamRequestList } from 'mavlink-mappings/dist/lib/common'

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
