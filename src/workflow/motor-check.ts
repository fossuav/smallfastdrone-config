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

// Motor-check correction maths — the pure logic that turns the operator's
// observations ("which motor actually moved, and which way") into the
// parameter changes that fix a mis-wired drone:
//
//   - motor ORDER  → reassign SERVOn_FUNCTION so each output channel
//     drives the motor role that matches the physical motor plugged into
//     it (Betaflight-style auto-remap).
//   - motor DIRECTION → toggle the output channel's bit in
//     SERVO_BLH_RVMASK so the ESC is told to spin the other way.
//
// This is the dangerous part — a wrong remap makes a drone flip on
// take-off — so it's isolated here as side-effect-free logic with unit
// tests (test/unit/motor-check.spec.ts) rather than buried in a view.
// The chain it relies on (verified against SITL):
//   test order → mixer motor index → Motor function (SERVOn_FUNCTION value)
//   → output channel.

import type { FrameGeometry, MotorPosition, Spin } from './motor-geometry'
import { flipSpin } from './motor-geometry'

// SERVOn_FUNCTION value for a motor by 0-based mixer index. Motor1..8 are
// k_motor1..8 = 33..40; Motor9..12 are k_motor9..12 = 82..85 (from
// SRV_Channel.h). The wizard only handles up to 8 today, but the mapping
// is here in full so it doesn't surprise a future hex/octo extension.
export function motorFunctionId(motorIndex: number): number {
  return motorIndex < 8 ? 33 + motorIndex : 82 + (motorIndex - 8)
}

// Is this SERVOn_FUNCTION value one of the motor functions (k_motor1..12)?
// Used to pick out the motor output channels from the full servo set.
export function isMotorFunction(fn: number): boolean {
  return (fn >= 33 && fn <= 40) || (fn >= 82 && fn <= 85)
}

// SERVOn_FUNCTION parameter name for a 1-based output channel.
export function servoFunctionParam(channel: number): string {
  return `SERVO${channel}_FUNCTION`
}

// The FC parameter that reverses a DShot/BLHeli motor's spin direction.
// Reboot-required, present only on builds that compile BLHeli support
// (stock SITL doesn't — see the `blheli-sitl` SFD branch), so direction
// correction is gated on the live FC actually exposing it.
//
// CRITICAL — what the bits mean (verified against AP_BLHeli.cpp). RVMASK is
// applied via `hal.rcout->set_reversed_mask(channel_reversed_mask &
// digital_mask)`, where bit i is OUTPUT CHANNEL i (rcout index, 0-based) —
// i.e. bit 0 = Channel 1 = SERVO1's physical output. It is keyed by the
// output channel, NOT by motor number, and (unlike the 3D/reversible mask)
// does NOT pass through `motor_map`. So to reverse the motor plugged into a
// given output, we toggle that output channel's bit — which is exactly the
// `channel` field carried in a RemapEntry / the SERVOn index. See
// applyReverseMask.
export const REVERSE_MASK_PARAM = 'SERVO_BLH_RVMASK'

// ArduPilot supports up to 32 servo outputs.
const MAX_SERVO_CHANNELS = 32

// One motor's observation as reported by the operator.
export interface MotorObservation {
  position: MotorPosition
  spin: Spin
}

// A single SERVOn_FUNCTION reassignment.
export interface RemapEntry {
  channel: number
  fromFunction: number
  toFunction: number
}

export interface MotorCorrections {
  // Every motor reported exactly where/how the firmware expects.
  orderOk: boolean
  directionOk: boolean
  // SERVOn_FUNCTION reassignments that fix the motor order.
  remap: RemapEntry[]
  // Output channels (1-based) whose direction bit must be toggled in
  // SERVO_BLH_RVMASK. The caller XORs these into the current mask.
  reverseChannels: number[]
  // The observations don't form a valid permutation of the frame's
  // positions (e.g. two motors reported at the same spot) — no safe remap
  // can be computed, so the operator should re-run the check.
  inconsistent: boolean
}

// The operator's physical build, recovered from their observations: for
// each output channel, the position of the motor plugged into it and the
// way that motor actually spins. `inconsistent` is set when the reports
// don't form a valid permutation of the frame's positions.
interface PhysicalBuild {
  physPosition: Map<number, MotorPosition>
  physSpin: Map<number, Spin>
  inconsistent: boolean
}

// Recover the physical build from the operator's observations. For each
// motor the firmware spun (by test order), find the output channel its
// function currently drives, and record what the operator saw on it.
function recoverPhysical(
  geometry: FrameGeometry,
  observations: Map<number, MotorObservation>,
  channelFunctions: Map<number, number>,
): PhysicalBuild {
  const channelByFunction = new Map<number, number>()
  for (const [channel, fn] of channelFunctions)
    channelByFunction.set(fn, channel)

  const physPosition = new Map<number, MotorPosition>()
  const physSpin = new Map<number, Spin>()
  let missing = false

  for (const m of geometry.motors) {
    const channel = channelByFunction.get(motorFunctionId(m.motorIndex))
    const obs = observations.get(m.testOrder)
    if (channel === undefined || obs === undefined) {
      missing = true
      continue
    }
    physPosition.set(channel, obs.position)
    physSpin.set(channel, obs.spin)
  }

  const reported = [...physPosition.values()]
  const inconsistent = missing
    || new Set(reported).size !== reported.length
    || reported.length !== geometry.motors.length

  return { physPosition, physSpin, inconsistent }
}

// Order remap against a frame: reassign each output channel to the
// function whose expected position matches the physical motor on it.
function computeRemap(geometry: FrameGeometry, build: PhysicalBuild, channelFunctions: Map<number, number>): RemapEntry[] {
  const functionByPosition = new Map<MotorPosition, number>()
  for (const m of geometry.motors)
    functionByPosition.set(m.position, motorFunctionId(m.motorIndex))

  const remap: RemapEntry[] = []
  for (const [channel, physPosition] of build.physPosition) {
    const currentFn = channelFunctions.get(channel)
    const desiredFn = functionByPosition.get(physPosition)
    if (currentFn !== undefined && desiredFn !== undefined && desiredFn !== currentFn)
      remap.push({ channel, fromFunction: currentFn, toFunction: desiredFn })
  }
  return remap
}

// Compute the corrections needed to make every motor land in its proper
// role and direction against the GIVEN frame (positions + spins from
// `geometry`). This is the custom-output-remap path; planCorrection prefers
// a standard frame-type change and only falls back to this.
//
// `channelFunctions` maps each motor output channel (1-based) to its
// current SERVOn_FUNCTION value, read from the FC. `observations` is keyed
// by the motor's 1-based test order (what was spun).
export function computeCorrections(
  geometry: FrameGeometry,
  observations: Map<number, MotorObservation>,
  channelFunctions: Map<number, number>,
): MotorCorrections {
  const build = recoverPhysical(geometry, observations, channelFunctions)
  if (build.inconsistent)
    return { orderOk: false, directionOk: false, remap: [], reverseChannels: [], inconsistent: true }

  const remap = computeRemap(geometry, build, channelFunctions)

  // Direction: a channel's physical motor must spin the way the frame
  // expects for that (physical) position; if not, toggle its reverse bit.
  const spinByPosition = new Map<MotorPosition, Spin>()
  for (const m of geometry.motors)
    spinByPosition.set(m.position, m.spin)
  const reverseChannels: number[] = []
  for (const [channel, physSpin] of build.physSpin) {
    if (physSpin !== spinByPosition.get(build.physPosition.get(channel)!))
      reverseChannels.push(channel)
  }
  reverseChannels.sort((a, b) => a - b)

  // "OK" means nothing needs changing — derived from the computed fixes so
  // a pure position swap (no reversal) doesn't read as a direction fault.
  return {
    orderOk: remap.length === 0,
    directionOk: reverseChannels.length === 0,
    remap,
    reverseChannels,
    inconsistent: false,
  }
}

// Pick out the motor output channels (1-based) and their current
// SERVOn_FUNCTION values from the FC's servo set. `read` returns the
// function value for a given channel, or undefined if that channel isn't
// set (or isn't in the fetched param map). Only channels carrying a motor
// function are kept — this is the `channelFunctions` input to
// computeCorrections.
export function collectMotorChannels(read: (channel: number) => number | undefined): Map<number, number> {
  const out = new Map<number, number>()
  for (let channel = 1; channel <= MAX_SERVO_CHANNELS; channel++) {
    const fn = read(channel)
    if (fn !== undefined && isMotorFunction(fn))
      out.set(channel, fn)
  }
  return out
}

// Turn the order-remap corrections into the parameter writes that apply
// them: each entry reassigns one channel's SERVOn_FUNCTION to the role its
// physically-plugged-in motor should fill.
export function remapParamEdits(remap: RemapEntry[]): Array<{ name: string, value: number }> {
  return remap.map(r => ({ name: servoFunctionParam(r.channel), value: r.toFunction }))
}

// Fold the direction-correction channels into the current reverse mask by
// XORing each channel's bit (bit 0 = channel 1) — toggling a motor's
// reverse flag flips its spin. XOR (not OR) so applying the fix twice is a
// no-op rather than sticking a motor reversed forever. Returned as an
// unsigned 32-bit integer.
export function applyReverseMask(currentMask: number, reverseChannels: number[]): number {
  let mask = currentMask >>> 0
  for (const channel of reverseChannels)
    mask ^= 1 << (channel - 1)
  return mask >>> 0
}

// The fix the wizard will apply for a failed check.
export type CorrectionPlan
  = | { kind: 'none' }
    | { kind: 'inconsistent' }
    // Switch the drone to a standard layout (FRAME_TYPE). `reverseChannels`
    // is the rare residual: an individual motor still spinning the wrong way
    // for that layout, fixed via the reverse mask.
    | { kind: 'frame-type', frameType: number, label: string, layoutName: string, reverseChannels: number[] }
    // No standard layout matched — remap individual outputs and reverse any
    // motor not turning the chosen-orientation way.
    | { kind: 'remap', remap: RemapEntry[], reverseChannels: number[] }

// Is the FC's output wiring the default 1:1 mapping (SERVOn drives Motor
// n)? A standard FRAME_TYPE change only makes sense on default wiring,
// since the frame types assume Motor n on output n.
export function wiringIsDefault(channelFunctions: Map<number, number>): boolean {
  if (channelFunctions.size === 0)
    return false
  for (const [channel, fn] of channelFunctions) {
    if (fn !== motorFunctionId(channel - 1))
      return false
  }
  return true
}

// Plan the fix for a failed motor check, preferring a single standard
// FRAME_TYPE change over a custom output remap.
//
// `propsOut` is the operator's chosen propeller orientation: it selects
// which standard layouts are candidates and what direction each motor
// should turn. `candidates` is the set of standard layouts for the frame
// class (motor-geometry's frameVariants).
export function planCorrection(
  currentGeometry: FrameGeometry,
  observations: Map<number, MotorObservation>,
  channelFunctions: Map<number, number>,
  propsOut: boolean,
  candidates: FrameGeometry[],
): CorrectionPlan {
  const build = recoverPhysical(currentGeometry, observations, channelFunctions)
  if (build.inconsistent)
    return { kind: 'inconsistent' }

  // Prefer a standard layout. On default wiring, find the candidate in the
  // chosen props orientation whose motor order matches the observed
  // positions — setting FRAME_TYPE to it fixes order + orientation in one
  // reboot-required change.
  if (wiringIsDefault(channelFunctions)) {
    for (const v of candidates) {
      if (v.propsOut !== propsOut || v.motors.length !== build.physPosition.size)
        continue
      const posByIndex = new Map<number, MotorPosition>()
      const spinByIndex = new Map<number, Spin>()
      for (const m of v.motors) {
        posByIndex.set(m.motorIndex, m.position)
        spinByIndex.set(m.motorIndex, m.spin)
      }
      // Default wiring: output channel ch carries motor index ch-1.
      let orderMatch = true
      for (const [channel, pos] of build.physPosition) {
        if (posByIndex.get(channel - 1) !== pos) {
          orderMatch = false
          break
        }
      }
      if (!orderMatch)
        continue
      // Residual reversals: channels whose observed spin differs from this
      // layout's — usually none (a single individually-reversed motor).
      const reverseChannels: number[] = []
      for (const [channel, sp] of build.physSpin) {
        if (sp !== spinByIndex.get(channel - 1))
          reverseChannels.push(channel)
      }
      reverseChannels.sort((a, b) => a - b)

      if (v.frameType === currentGeometry.frameType) {
        // Same layout, no reorder needed: either all good, or just reverse
        // the odd motor(s). Treat the latter as a direction-only remap (no
        // frame change) so the UI doesn't claim a layout switch.
        if (reverseChannels.length === 0)
          return { kind: 'none' }
        return { kind: 'remap', remap: [], reverseChannels }
      }
      return { kind: 'frame-type', frameType: v.frameType, label: v.label, layoutName: v.layoutName, reverseChannels }
    }
  }

  // Fallback: custom output remap to the current frame, plus reversing any
  // motor not turning the chosen-orientation direction. "Desired spin" is
  // the current frame's spin for each position, flipped if the operator's
  // props orientation differs from the frame's.
  const remap = computeRemap(currentGeometry, build, channelFunctions)
  const spinByPosition = new Map<MotorPosition, Spin>()
  for (const m of currentGeometry.motors)
    spinByPosition.set(m.position, m.spin)
  const desiredSpin = (pos: MotorPosition): Spin => {
    const base = spinByPosition.get(pos)!
    return propsOut === currentGeometry.propsOut ? base : flipSpin(base)
  }
  const reverseChannels: number[] = []
  for (const [channel, physSpin] of build.physSpin) {
    if (physSpin !== desiredSpin(build.physPosition.get(channel)!))
      reverseChannels.push(channel)
  }
  reverseChannels.sort((a, b) => a - b)

  if (remap.length === 0 && reverseChannels.length === 0)
    return { kind: 'none' }
  return { kind: 'remap', remap, reverseChannels }
}
