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

// Frame motor geometry — the source of truth the motor-check wizard uses
// to know, for each frame, where every motor sits, the order they're
// spun in, and which way each one should turn.
//
// Transcribed directly from the firmware mixer tables in
// vendor/smallfastdrone/libraries/AP_Motors/AP_MotorsMatrix.cpp
// (MotorDef = { angle_degrees, yaw_factor, testing_order }) and
// cross-checked against ArduPilot's documented motor diagrams. Getting a
// motor's EXPECTED spin direction wrong here would tell an operator their
// correctly-wired drone is backwards — so this data is treated as
// safety-critical and only ever changed against the firmware source.
//
// Angle convention (matches the firmware): 0° = straight forward (nose),
// increasing clockwise viewed from above — 90° = right, 180° = aft,
// 270°/-90° = left. Spin direction is the propeller's rotation viewed
// from above.
//
// v1 covers the quad frames (the SmallFastDrone bread-and-butter). The
// table structure extends to hex/octo by transcribing the matching
// MotorDef arrays; the wizard reports "frame not supported yet" for
// anything absent so it never guesses.

// Propeller rotation viewed from above.
export type Spin = 'cw' | 'ccw'

// Operator-facing position name — no motor numbers, no MAVLink terms.
export type MotorPosition
  = | 'front' | 'front-right' | 'right' | 'rear-right'
    | 'rear' | 'rear-left' | 'left' | 'front-left'

// One motor in a frame.
export interface FrameMotor {
  // 1-based test-order — what MAV_CMD_DO_MOTOR_TEST's motor number takes,
  // and the order the wizard walks motors in.
  testOrder: number
  // 0-based mixer index. The motor's MAVLink output function is
  // Motor{motorIndex + 1} (k_motor1 = 33, so SERVOn_FUNCTION for this
  // motor is 33 + motorIndex). Carried for the slice-2 remap correction.
  motorIndex: number
  // Position on the airframe, in the firmware's angle convention.
  angleDeg: number
  // Operator-facing position label derived from the angle.
  position: MotorPosition
  // Direction the propeller should spin, viewed from above.
  spin: Spin
}

// A frame's full motor layout.
export interface FrameGeometry {
  frameClass: number
  frameType: number
  // Operator-facing frame name, e.g. "Quad X".
  label: string
  // Short layout-family name for fix microcopy, e.g. "Betaflight". The
  // layouts differ by motor order / direction; this is what we tell the
  // operator we're switching their drone to.
  layoutName: string
  // Propeller orientation: false = props-in (ArduPilot default), true =
  // props-out (Betaflight default). Equivalent to every motor's spin being
  // flipped relative to the props-in variant of the same order.
  propsOut: boolean
  // Motors in test order.
  motors: FrameMotor[]
}

// FRAME_CLASS / FRAME_TYPE values we map. Transcribed from the
// motor_frame_type enum in AP_Motors_Class.h — the integer values are NOT
// sequential by family, so each is taken from the firmware directly
// (getting one wrong sets the wrong frame, which flips a drone).
const FRAME_CLASS_QUAD = 1
const FRAME_TYPE_PLUS = 0
const FRAME_TYPE_X = 1
const FRAME_TYPE_H = 3 // X order, props-out
const FRAME_TYPE_PLUSREV = 6 // plus, props-out
const FRAME_TYPE_BF_X = 12 // Betaflight order
const FRAME_TYPE_DJI_X = 13 // DJI order
const FRAME_TYPE_CW_X = 14 // clockwise-from-front-right order
const FRAME_TYPE_BF_X_REV = 18 // Betaflight order, props-out

// Map an airframe angle to an operator-facing position label. The quad
// frames only ever use the eight cardinal/intercardinal angles below.
function positionForAngle(angleDeg: number): MotorPosition {
  // Normalise to [0, 360).
  const a = ((angleDeg % 360) + 360) % 360
  switch (a) {
    case 0: return 'front'
    case 45: return 'front-right'
    case 90: return 'right'
    case 135: return 'rear-right'
    case 180: return 'rear'
    case 225: return 'rear-left'
    case 270: return 'left'
    case 315: return 'front-left'
    default:
      // Should never happen for the supported frames; fall back to the
      // nearest cardinal so the UI degrades rather than throws.
      return a < 90 || a >= 315 ? 'front' : a < 180 ? 'right' : a < 270 ? 'rear' : 'left'
  }
}

// Operator-facing label for a position — "front-left" → "Front left".
// Hyphen becomes a space and the first letter is capitalised.
export function positionLabel(p: MotorPosition): string {
  const spaced = p.replace('-', ' ')
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

// Human label for a spin direction.
export function spinLabel(s: Spin): string {
  return s === 'cw' ? 'clockwise' : 'counter-clockwise'
}

// Top-down unit coordinates for a motor at the given airframe angle, with
// the nose pointing up. Returns x ∈ [-1, 1] (right positive) and y ∈
// [-1, 1] (DOWN positive, screen convention) so the same value drives
// both the HTML hotspot overlay and any 2D layout. Multiply by a radius.
export function motorTopdownXY(angleDeg: number): { x: number, y: number } {
  const rad = (angleDeg * Math.PI) / 180
  return { x: Math.sin(rad), y: -Math.cos(rad) }
}

// Build a FrameMotor from the firmware MotorDef fields, deriving the
// operator-facing position from the angle.
function motor(testOrder: number, motorIndex: number, angleDeg: number, spin: Spin): FrameMotor {
  return { testOrder, motorIndex, angleDeg, position: positionForAngle(angleDeg), spin }
}

// Canonical props-IN spin for each airframe position, read off the
// firmware's default X and PLUS tables. Every props-in quad variant (X,
// BF_X, DJI_X, CW_X) shares this position→spin map; props-out is every
// entry flipped. The wizard uses this so "which way should it turn?"
// follows the props-in/out choice rather than a specific frame type.
const SPIN_IN: Record<MotorPosition, Spin> = {
  'front': 'cw',
  'front-right': 'ccw',
  'right': 'ccw',
  'rear-right': 'cw',
  'rear': 'cw',
  'rear-left': 'ccw',
  'left': 'ccw',
  'front-left': 'cw',
}

// Expected spin for a position given the propeller orientation. props-out
// is simply the mirror of props-in.
export function spinForPosition(position: MotorPosition, propsOut: boolean): Spin {
  const inSpin = SPIN_IN[position]
  if (!propsOut)
    return inSpin
  return inSpin === 'cw' ? 'ccw' : 'cw'
}

// All quad layouts we recognise, transcribed in test order from the
// MotorDef tables in AP_MotorsMatrix.cpp setup_quad_matrix(). Each is a
// distinct motor order and/or props orientation; the wizard matches an
// operator's observed wiring against these to offer "switch to a standard
// layout" before falling back to a custom output remap.
//
// props-in family (X / Betaflight / DJI / clockwise) and their props-out
// counterparts (H / Betaflight-rev), plus the cardinal + frames.
const QUAD_X: FrameGeometry = {
  frameClass: FRAME_CLASS_QUAD,
  frameType: FRAME_TYPE_X,
  label: 'Quad X',
  layoutName: 'ArduPilot standard',
  propsOut: false,
  motors: [
    motor(1, 0, 45, 'ccw'), // front-right
    motor(2, 3, 135, 'cw'), // rear-right
    motor(3, 1, -135, 'ccw'), // rear-left
    motor(4, 2, -45, 'cw'), // front-left
  ],
}

// X order with every motor reversed — the props-out counterpart of X.
const QUAD_H: FrameGeometry = {
  frameClass: FRAME_CLASS_QUAD,
  frameType: FRAME_TYPE_H,
  label: 'Quad X (props out)',
  layoutName: 'ArduPilot, props out',
  propsOut: true,
  motors: [
    motor(1, 0, 45, 'cw'),
    motor(2, 3, 135, 'ccw'),
    motor(3, 1, -135, 'cw'),
    motor(4, 2, -45, 'ccw'),
  ],
}

// Betaflight motor order (props in).
const QUAD_BF_X: FrameGeometry = {
  frameClass: FRAME_CLASS_QUAD,
  frameType: FRAME_TYPE_BF_X,
  label: 'Quad X (Betaflight order)',
  layoutName: 'Betaflight',
  propsOut: false,
  motors: [
    motor(1, 1, 45, 'ccw'),
    motor(2, 0, 135, 'cw'),
    motor(3, 2, -135, 'ccw'),
    motor(4, 3, -45, 'cw'),
  ],
}

// Betaflight order, motors reversed — Betaflight's own default (props out).
const QUAD_BF_X_REV: FrameGeometry = {
  frameClass: FRAME_CLASS_QUAD,
  frameType: FRAME_TYPE_BF_X_REV,
  label: 'Quad X (Betaflight, props out)',
  layoutName: 'Betaflight, props out',
  propsOut: true,
  motors: [
    motor(1, 1, 45, 'cw'),
    motor(2, 0, 135, 'ccw'),
    motor(3, 2, -135, 'cw'),
    motor(4, 3, -45, 'ccw'),
  ],
}

// DJI motor order (props in).
const QUAD_DJI_X: FrameGeometry = {
  frameClass: FRAME_CLASS_QUAD,
  frameType: FRAME_TYPE_DJI_X,
  label: 'Quad X (DJI order)',
  layoutName: 'DJI',
  propsOut: false,
  motors: [
    motor(1, 0, 45, 'ccw'),
    motor(2, 3, 135, 'cw'),
    motor(3, 2, -135, 'ccw'),
    motor(4, 1, -45, 'cw'),
  ],
}

// Clockwise-from-front-right order (motor numbers follow test order).
const QUAD_CW_X: FrameGeometry = {
  frameClass: FRAME_CLASS_QUAD,
  frameType: FRAME_TYPE_CW_X,
  label: 'Quad X (clockwise order)',
  layoutName: 'Clockwise',
  propsOut: false,
  motors: [
    motor(1, 0, 45, 'ccw'),
    motor(2, 1, 135, 'cw'),
    motor(3, 2, -135, 'ccw'),
    motor(4, 3, -45, 'cw'),
  ],
}

// Quad Plus — arms on the cardinal axes (props in).
const QUAD_PLUS: FrameGeometry = {
  frameClass: FRAME_CLASS_QUAD,
  frameType: FRAME_TYPE_PLUS,
  label: 'Quad +',
  layoutName: 'Plus',
  propsOut: false,
  motors: [
    motor(1, 2, 0, 'cw'), // front
    motor(2, 0, 90, 'ccw'), // right
    motor(3, 3, 180, 'cw'), // rear
    motor(4, 1, -90, 'ccw'), // left
  ],
}

// Quad Plus, motors reversed (props out).
const QUAD_PLUSREV: FrameGeometry = {
  frameClass: FRAME_CLASS_QUAD,
  frameType: FRAME_TYPE_PLUSREV,
  label: 'Quad + (props out)',
  layoutName: 'Plus, props out',
  propsOut: true,
  motors: [
    motor(1, 2, 0, 'ccw'),
    motor(2, 0, 90, 'cw'),
    motor(3, 3, 180, 'ccw'),
    motor(4, 1, -90, 'cw'),
  ],
}

const GEOMETRIES: FrameGeometry[] = [
  QUAD_X,
  QUAD_H,
  QUAD_BF_X,
  QUAD_BF_X_REV,
  QUAD_DJI_X,
  QUAD_CW_X,
  QUAD_PLUS,
  QUAD_PLUSREV,
]

// Look up the geometry for a connected FC's FRAME_CLASS / FRAME_TYPE.
// Returns null for frames we don't have a transcribed table for yet, so
// the wizard can say so rather than guess.
export function frameGeometry(frameClass: number, frameType: number): FrameGeometry | null {
  return GEOMETRIES.find(g => g.frameClass === frameClass && g.frameType === frameType) ?? null
}

// Every standard layout for a frame class — the candidate set the
// correction planner matches an operator's observed wiring against.
export function frameVariants(frameClass: number): FrameGeometry[] {
  return GEOMETRIES.filter(g => g.frameClass === frameClass)
}
