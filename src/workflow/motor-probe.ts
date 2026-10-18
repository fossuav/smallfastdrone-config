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

// Props-on motor probe: reading what the applet on the drone
// (src/wizards/motor-probe/applet.lua) reports, and saying what it means
// against the frame the drone believes it has. The meaning of a bearing
// or a yaw sign is pure and unit-tested here, because nothing about a
// wrong sign looks wrong on a bench. Design: docs/BRINGUP.md "Props-on
// motor measurement" (PLAN decision 48).
//
// The composable that runs the applet is use-motor-probe.ts; this file is
// pure so the tests need no drone.

import type { FrameGeometry, FrameMotor, Spin } from './motor-geometry'

// The wizard id, which is also the applet's name on the drone.
export const MOTOR_PROBE_ID = 'motor-probe'

// The applet's run switch.
export const PROBE_ACTIVE_PARAM = 'MPRB_ACTIVE'

// The applet's stages (MP_STATE), mirrored from STAGE in applet.lua.
export const PROBE_STAGE = {
  OFF: 0,
  SETTLING: 1,
  FINDING_START: 2,
  IDLING: 3,
  PULSE: 4,
  OBSERVE: 5,
  RESTING: 6,
  RAMPING: 7,
  GAP: 8,
  DONE: 9,
  ABORTED: 10,
} as const

// What the drone is doing, for the progress line.
export function stageLabel(stage: number): string {
  switch (stage) {
    case PROBE_STAGE.SETTLING: return 'Holding still'
    case PROBE_STAGE.FINDING_START: return 'Finding where the motor starts'
    case PROBE_STAGE.IDLING: return 'Idling'
    case PROBE_STAGE.PULSE:
    case PROBE_STAGE.OBSERVE:
    case PROBE_STAGE.RESTING:
    case PROBE_STAGE.RAMPING: return 'Pushing until the corner lifts'
    case PROBE_STAGE.GAP: return 'Next motor'
    case PROBE_STAGE.DONE: return 'Done'
    case PROBE_STAGE.ABORTED: return 'Stopped'
    default: return 'Starting'
  }
}

// Why the drone stopped a run (MP_ABORT), mirrored from ABORT in
// applet.lua, as what the operator does about it.
export const PROBE_ABORT_TEXT: Record<number, string> = {
  1: 'The drone is armed. Disarm it and try again.',
  2: 'The drone was moving when the test started. Set it down, keep it still, and try again.',
  3: 'The drone isn\'t flat. Put it on level floor and try again.',
  4: 'The drone wouldn\'t spin its motors. Check it is disarmed and on the ground.',
  5: 'The drone moved while a motor was only idling. Check nothing is touching it, then try again.',
  6: 'The drone tipped further than it should. Check the props are on tight, then try again.',
  7: 'The drone turned on the spot. Put it on a surface it can grip, then try again.',
  8: 'This drone has no motors set up yet. Pick your frame first.',
  9: 'Something went wrong on the drone. Try again.',
  10: 'The drone lost contact with this computer, so it stopped. Check the cable and try again.',
}

// One motor's measurement, as the applet reports it. Throttles are
// fractions of the full output range - the scale the drone's own idle
// settings use.
export interface ProbeMotorResult {
  // The motor test number the frame gave it.
  testOrder: number
  // Where it started turning, by its RPM. Null without RPM telemetry.
  start: number | null
  // Where its corner lifted. Null when it never did, up to the cap.
  lift: number | null
  // Which side of the drone went up, degrees clockwise from the nose.
  bearingDeg: number | null
  tiltDeg: number
  // How far the frame turned while the motor spun up. Negative means the
  // frame turned anticlockwise - the motor turns clockwise.
  yawDeg: number
  // Peak RPM seen. Null without telemetry.
  rpm: number | null
  // The output it's wired to, 1-based, from telemetry. Null without it.
  output: number | null
}

// The per-motor result fields the applet sends, as Mt<FIELD>.
export const PROBE_FIELDS = ['START', 'LIFT', 'BRG', 'TILT', 'YAW', 'RPM', 'CH'] as const
type ProbeField = typeof PROBE_FIELDS[number]

// The NAMED_VALUE_FLOAT name for one of a motor's results.
export function probeValueName(testOrder: number, field: ProbeField): string {
  return `M${testOrder}${field}`
}

// Assemble one motor's result from the latest named values. Null until
// every field has arrived.
export function probeResult(testOrder: number, values: ReadonlyMap<string, number>): ProbeMotorResult | null {
  const v = (f: ProbeField) => values.get(probeValueName(testOrder, f))
  if (PROBE_FIELDS.some(f => v(f) === undefined))
    return null
  const lift = v('LIFT')!
  return {
    testOrder,
    start: v('START')! < 0 ? null : v('START')!,
    lift: lift < 0 ? null : lift,
    bearingDeg: lift < 0 || v('BRG')! < 0 ? null : v('BRG')!,
    tiltDeg: v('TILT')!,
    yawDeg: v('YAW')!,
    rpm: v('RPM')! > 0 ? v('RPM')! : null,
    output: v('CH')! > 0 ? v('CH')! : null,
  }
}

// Signed difference b - a between two angles, in (-180, 180].
export function angleDiff(a: number, b: number): number {
  const d = ((b - a) % 360 + 360) % 360
  return d > 180 ? d - 360 : d
}

// Below this the frame's turn is noise, not a direction. Provisional:
// the bench decides it.
export const SPIN_MIN_YAW_DEG = 0.3

// Which way a motor turns, from the frame's reaction to it spinning up.
// The rotor kicks the frame the other way, and the firmware counts
// clockwise-from-above as positive yaw - so a frame that turned
// anticlockwise has a motor turning clockwise. Null when too small to call.
export function spinFromYaw(yawDeg: number): Spin | null {
  if (Math.abs(yawDeg) < SPIN_MIN_YAW_DEG)
    return null
  return yawDeg < 0 ? 'cw' : 'ccw'
}

// What one motor's measurement says, against the frame the drone thinks
// it has.
export interface ProbeReading {
  result: ProbeMotorResult
  // Where the frame believes this motor is.
  expected: FrameMotor | null
  // The frame position nearest the side that lifted. Null if it never lifted.
  found: FrameMotor | null
  // It lifted where the frame expects it. Null if it never lifted.
  placeOk: boolean | null
  // Which way it turns. Null if it never lifted, or the turn was too small.
  spin: Spin | null
  // It turns the way the frame expects it to. Null if spin is.
  spinOk: boolean | null
}

// Read one motor's measurement against the frame.
export function readProbe(geo: FrameGeometry, result: ProbeMotorResult): ProbeReading {
  const expected = geo.motors.find(m => m.testOrder === result.testOrder) ?? null
  let found: FrameMotor | null = null
  if (result.bearingDeg !== null) {
    const bearing = result.bearingDeg
    found = geo.motors.reduce((best, m) =>
      Math.abs(angleDiff(m.angleDeg, bearing)) < Math.abs(angleDiff(best.angleDeg, bearing)) ? m : best,
    )
  }
  const spin = result.lift === null ? null : spinFromYaw(result.yawDeg)
  return {
    result,
    expected,
    found,
    placeOk: found && expected ? found.testOrder === expected.testOrder : null,
    spin,
    spinOk: spin && expected ? spin === expected.spin : null,
  }
}

// ArduPilot's usual step from spin-arm up to spin-min.
const SPIN_MIN_ABOVE_ARM = 0.03
// Margin above the slowest-starting motor for spin-arm.
const SPIN_ARM_MARGIN = 0.02

// What the motors' starts suggest for the drone's idle settings: spin-arm
// a margin above the slowest-starting motor, spin-min ArduPilot's usual
// step above that. Null unless every motor reported a start.
export function suggestSpin(results: ProbeMotorResult[]): { slowest: number, arm: number, min: number } | null {
  if (results.length === 0 || results.some(r => r.start === null))
    return null
  const slowest = Math.max(...results.map(r => r.start!))
  const arm = Math.round((slowest + SPIN_ARM_MARGIN) * 100) / 100
  return { slowest, arm, min: Math.round((arm + SPIN_MIN_ABOVE_ARM) * 100) / 100 }
}
