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

// Port probe: which ports to listen on, what the applet on the drone
// (src/wizards/port-probe/applet.lua) reports for each, and the roles to
// set from it. Pure, so which port gets touched - the part a mistake here
// would cost an operator their receiver or their telemetry - is unit-tested.
// Design: docs/BRINGUP.md "Finding what's plugged in" (PLAN decision 49).
// The composable that runs it is use-port-probe.ts.

// The wizard id, which is also the applet's name on the drone.
export const PORT_PROBE_ID = 'port-probe'

// The applet's run switch.
export const PORT_PROBE_ACTIVE_PARAM = 'PPRB_ACTIVE'

// SERIALn_PROTOCOL values this touches.
export const PROTOCOL_SCRIPTING = 28
const PROTOCOL_NONE = -1
const PROTOCOL_CONSOLE = 0 // unused in ArduPilot: as good as no role
const PROTOCOL_GPS = 5
const PROTOCOL_RCIN = 23

// The applet's stages (PP_STATE), mirrored from STAGE in applet.lua.
export const PORT_PROBE_STAGE = { OFF: 0, PROBING: 1, DONE: 2 } as const

// What a port was found to have (Sn FOUND), in the order of FOUND in
// applet.lua.
export type PortFinding = 'silent' | 'traffic' | 'crsf' | 'ghost' | 'ibus' | 'nmea' | 'ubx'
const FINDINGS: readonly PortFinding[] = ['silent', 'traffic', 'crsf', 'ghost', 'ibus', 'nmea', 'ubx']

// Whether a finding is a radio receiver, or a GPS.
export function isReceiver(f: PortFinding): boolean {
  return f === 'crsf' || f === 'ghost' || f === 'ibus'
}
export function isGps(f: PortFinding): boolean {
  return f === 'nmea' || f === 'ubx'
}

// A finding as the operator reads it.
export function findingLabel(f: PortFinding): string {
  switch (f) {
    case 'crsf': return 'ELRS / Crossfire receiver'
    case 'ghost': return 'Ghost receiver'
    case 'ibus': return 'FlySky receiver'
    case 'nmea':
    case 'ubx': return 'GPS'
    case 'traffic': return 'Something talking we don\'t recognise'
    default: return 'Nothing heard'
  }
}

// One port's role: what it's for, and its baud setting.
export interface PortRole {
  protocol: number
  baud: number
}

// What the drone says is working right now.
export interface PortHealth {
  receiverWorking: boolean
  gpsWorking: boolean
}

// The ports to listen on: every port with no role, and a receiver or GPS
// port whose device isn't working. Never SERIAL0 (USB, or whatever the
// tool is talking over), and never a port with another role - telemetry,
// video, ESC telemetry - because nothing here can recognise those yet,
// so taking one over could only lose its role.
export function portsToProbe(roles: ReadonlyMap<number, PortRole>, health: PortHealth): number[] {
  return [...roles.entries()]
    .filter(([n, r]) => {
      if (n === 0)
        return false
      if (r.protocol === PROTOCOL_NONE || r.protocol === PROTOCOL_CONSOLE)
        return true
      if (r.protocol === PROTOCOL_RCIN)
        return !health.receiverWorking
      if (r.protocol === PROTOCOL_GPS)
        return !health.gpsWorking
      return false
    })
    .map(([n]) => n)
    .sort((a, b) => a - b)
}

// One port's result, as the applet reports it.
export interface PortResult {
  serial: number
  finding: PortFinding
  // The baud it was found at. Null when nothing was found.
  baud: number | null
  // The most bytes heard in one listen.
  bytes: number
}

// Assemble one port's result from the latest named values. Null until all
// of it has arrived.
export function portResult(serial: number, values: ReadonlyMap<string, number>): PortResult | null {
  const found = values.get(`S${serial}FOUND`)
  const baud = values.get(`S${serial}BAUD`)
  const bytes = values.get(`S${serial}BYTES`)
  if (found === undefined || baud === undefined || bytes === undefined)
    return null
  return {
    serial,
    finding: FINDINGS[Math.trunc(found)] ?? 'silent',
    baud: baud > 0 ? baud : null,
    bytes,
  }
}

// SERIALn_BAUD's encoding of a baud rate: mostly the rate in thousands,
// but not quite (9600 is 9, 57600 is 57, 460800 is 460).
const BAUD_CODES: Record<number, number> = {
  9600: 9,
  19200: 19,
  38400: 38,
  57600: 57,
  115200: 115,
  230400: 230,
  460800: 460,
  921600: 921,
}
export function baudCode(baud: number): number {
  return BAUD_CODES[baud] ?? Math.floor(baud / 1000)
}

// One parameter write.
export interface PortEdit {
  name: string
  value: number
}

// What happens to one port when the results are applied.
export type PortOutcome
  = | { serial: number, kind: 'receiver', finding: PortFinding }
    | { serial: number, kind: 'gps', finding: PortFinding, baud: number }
    | { serial: number, kind: 'restore', role: PortRole, why: 'nothing' | 'second-receiver' | 'third-gps' }

// ArduPilot takes one receiver port (two is an arming error) and two GPS.
const MAX_GPS = 2

// From what was found, the role each probed port gets: a receiver, a GPS,
// or put back as it was. A port probed but never reported - a run cut
// short - is put back too. A second receiver isn't set when a port that
// wasn't probed already has that role, and nor is a third GPS.
export function planRoles(
  probed: readonly number[],
  results: ReadonlyMap<number, PortResult>,
  roles: ReadonlyMap<number, PortRole>,
): PortOutcome[] {
  const kept = [...roles.entries()].filter(([n]) => !probed.includes(n))
  let receiverTaken = kept.some(([, r]) => r.protocol === PROTOCOL_RCIN)
  let gpsCount = kept.filter(([, r]) => r.protocol === PROTOCOL_GPS).length

  return [...probed].sort((a, b) => a - b).map((serial): PortOutcome => {
    const role = roles.get(serial) ?? { protocol: PROTOCOL_NONE, baud: 57 }
    const r = results.get(serial)
    if (r && isReceiver(r.finding)) {
      if (receiverTaken)
        return { serial, kind: 'restore', role, why: 'second-receiver' }
      receiverTaken = true
      return { serial, kind: 'receiver', finding: r.finding }
    }
    if (r && isGps(r.finding) && r.baud !== null) {
      if (gpsCount >= MAX_GPS)
        return { serial, kind: 'restore', role, why: 'third-gps' }
      gpsCount++
      return { serial, kind: 'gps', finding: r.finding, baud: r.baud }
    }
    return { serial, kind: 'restore', role, why: 'nothing' }
  })
}

// The parameter writes that carry the outcomes out. A receiver's baud is
// left alone: ArduPilot's receiver input finds its own.
export function outcomeEdits(outcomes: readonly PortOutcome[]): PortEdit[] {
  return outcomes.flatMap((o): PortEdit[] => {
    const p = `SERIAL${o.serial}_`
    if (o.kind === 'receiver')
      return [{ name: `${p}PROTOCOL`, value: PROTOCOL_RCIN }]
    if (o.kind === 'gps')
      return [{ name: `${p}PROTOCOL`, value: PROTOCOL_GPS }, { name: `${p}BAUD`, value: baudCode(o.baud) }]
    return [{ name: `${p}PROTOCOL`, value: o.role.protocol }, { name: `${p}BAUD`, value: o.role.baud }]
  })
}

// Put every probed port back exactly as it was.
export function restoreEdits(probed: readonly number[], roles: ReadonlyMap<number, PortRole>): PortEdit[] {
  return outcomeEdits(planRoles(probed, new Map(), roles))
}
