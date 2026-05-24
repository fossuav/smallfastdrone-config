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
// v1 covers the common quad / hexa / octa layouts (X and + for hexa/octa,
// plus the quad order/orientation variants). The table structure extends
// to other frames by transcribing the matching MotorDef arrays; the wizard
// reports "frame not supported yet" for anything absent so it never guesses.

// Propeller rotation viewed from above.
export type Spin = 'cw' | 'ccw'

// Operator-facing position name — no motor numbers, no MAVLink terms. The
// eight cardinal/intercardinal names cover quad + hexa + octa-plus; the
// four "side" names (e.g. right-front) name octa-X's pairs that straddle a
// diagonal (22.5° / 67.5° …), which don't land on a cardinal.
export type MotorPosition
  = | 'front' | 'front-right' | 'right' | 'rear-right'
    | 'rear' | 'rear-left' | 'left' | 'front-left'
    | 'right-front' | 'right-rear' | 'left-rear' | 'left-front'

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
const FRAME_CLASS_HEXA = 2
const FRAME_CLASS_OCTA = 3
const FRAME_TYPE_PLUS = 0
const FRAME_TYPE_X = 1
const FRAME_TYPE_H = 3 // X order, props-out
const FRAME_TYPE_PLUSREV = 6 // plus, props-out
const FRAME_TYPE_BF_X = 12 // Betaflight order
const FRAME_TYPE_DJI_X = 13 // DJI order
const FRAME_TYPE_CW_X = 14 // clockwise-from-front-right order
const FRAME_TYPE_BF_X_REV = 18 // Betaflight order, props-out

// Airframe angle (normalised to [0,360), 1-decimal key) → operator-facing
// position. Multiple angles share a label across frames (a quad's 45° and a
// hexa's 30° are both "front right") but within any one frame each motor
// gets a distinct label — verified in the unit tests. Octa-X's 22.5°-offset
// motors straddle the diagonals, so they use the four "side" names.
const POSITION_BY_ANGLE = new Map<number, MotorPosition>([
  [0, 'front'],
  [22.5, 'front-right'], // octa X
  [30, 'front-right'], // hexa X
  [45, 'front-right'], // quad / octa +
  [60, 'front-right'], // hexa +
  [67.5, 'right-front'], // octa X
  [90, 'right'],
  [112.5, 'right-rear'], // octa X
  [120, 'rear-right'], // hexa +
  [135, 'rear-right'], // quad / octa +
  [150, 'rear-right'], // hexa X
  [157.5, 'rear-right'], // octa X
  [180, 'rear'],
  [202.5, 'rear-left'], // octa X
  [210, 'rear-left'], // hexa X
  [225, 'rear-left'], // quad / octa +
  [240, 'rear-left'], // hexa +
  [247.5, 'left-rear'], // octa X
  [270, 'left'],
  [292.5, 'left-front'], // octa X
  [300, 'front-left'], // hexa +
  [315, 'front-left'], // quad / octa +
  [330, 'front-left'], // hexa X
  [337.5, 'front-left'], // octa X
])

// Map an airframe angle to its operator-facing position label.
function positionForAngle(angleDeg: number): MotorPosition {
  const a = Math.round((((angleDeg % 360) + 360) % 360) * 10) / 10
  const hit = POSITION_BY_ANGLE.get(a)
  if (hit !== undefined)
    return hit
  // Unsupported angle — fall back to the nearest cardinal so the UI
  // degrades rather than throws.
  return a < 90 || a >= 315 ? 'front' : a < 180 ? 'right' : a < 270 ? 'rear' : 'left'
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

// Flip a spin direction.
export function flipSpin(s: Spin): Spin {
  return s === 'cw' ? 'ccw' : 'cw'
}

// The spin a motor should turn for the operator's chosen props orientation,
// relative to the frame it belongs to. Each FrameMotor.spin is correct for
// its own frame's orientation (geo.propsOut); building the opposite
// orientation flips every motor. This works across frame classes —
// hexa/octa spins don't follow the quad's position→spin rule, so we read
// from the frame's own table rather than a global position map.
export function expectedSpin(motor: FrameMotor, propsOut: boolean, geo: FrameGeometry): Spin {
  return propsOut === geo.propsOut ? motor.spin : flipSpin(motor.spin)
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

// Hexa X — AP_MotorsMatrix.cpp setup_hexa_matrix MOTOR_FRAME_TYPE_X.
// Six arms at ±30 / ±90 / ±150. (Hexa props-out is the raw-coord "H"
// frame, not modelled yet; DJI/CW hexa orders are deferred.)
const HEXA_X: FrameGeometry = {
  frameClass: FRAME_CLASS_HEXA,
  frameType: FRAME_TYPE_X,
  label: 'Hexa X',
  layoutName: 'X',
  propsOut: false,
  motors: [
    motor(1, 4, 30, 'ccw'),
    motor(2, 0, 90, 'cw'),
    motor(3, 3, 150, 'ccw'),
    motor(4, 5, -150, 'cw'),
    motor(5, 1, -90, 'ccw'),
    motor(6, 2, -30, 'cw'),
  ],
}

// Hexa Plus — arms at 0 / ±60 / ±120 / 180.
const HEXA_PLUS: FrameGeometry = {
  frameClass: FRAME_CLASS_HEXA,
  frameType: FRAME_TYPE_PLUS,
  label: 'Hexa +',
  layoutName: 'Plus',
  propsOut: false,
  motors: [
    motor(1, 0, 0, 'cw'),
    motor(2, 3, 60, 'ccw'),
    motor(3, 5, 120, 'cw'),
    motor(4, 1, 180, 'ccw'),
    motor(5, 2, -120, 'cw'),
    motor(6, 4, -60, 'ccw'),
  ],
}

// Octa X — AP_MotorsMatrix.cpp setup_octa_matrix MOTOR_FRAME_TYPE_X.
// Eight arms at ±22.5 / ±67.5 / ±112.5 / ±157.5 (the 22.5° offset is why
// octa-X uses the "side" position names). DJI/CW octa orders deferred.
const OCTA_X: FrameGeometry = {
  frameClass: FRAME_CLASS_OCTA,
  frameType: FRAME_TYPE_X,
  label: 'Octa X',
  layoutName: 'X',
  propsOut: false,
  motors: [
    motor(1, 0, 22.5, 'cw'),
    motor(2, 2, 67.5, 'ccw'),
    motor(3, 7, 112.5, 'cw'),
    motor(4, 3, 157.5, 'ccw'),
    motor(5, 1, -157.5, 'cw'),
    motor(6, 5, -112.5, 'ccw'),
    motor(7, 6, -67.5, 'cw'),
    motor(8, 4, -22.5, 'ccw'),
  ],
}

// Octa Plus — arms on the eight cardinal/intercardinal axes.
const OCTA_PLUS: FrameGeometry = {
  frameClass: FRAME_CLASS_OCTA,
  frameType: FRAME_TYPE_PLUS,
  label: 'Octa +',
  layoutName: 'Plus',
  propsOut: false,
  motors: [
    motor(1, 0, 0, 'cw'),
    motor(2, 2, 45, 'ccw'),
    motor(3, 7, 90, 'cw'),
    motor(4, 3, 135, 'ccw'),
    motor(5, 1, 180, 'cw'),
    motor(6, 5, -135, 'ccw'),
    motor(7, 6, -90, 'cw'),
    motor(8, 4, -45, 'ccw'),
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
  HEXA_X,
  HEXA_PLUS,
  OCTA_X,
  OCTA_PLUS,
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
