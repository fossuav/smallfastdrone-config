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

// SERVOn_FUNCTION value for a motor by 0-based mixer index. Motor1..8 are
// k_motor1..8 = 33..40; Motor9..12 are k_motor9..12 = 82..85 (from
// SRV_Channel.h). The wizard only handles up to 8 today, but the mapping
// is here in full so it doesn't surprise a future hex/octo extension.
export function motorFunctionId(motorIndex: number): number {
  return motorIndex < 8 ? 33 + motorIndex : 82 + (motorIndex - 8)
}

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

// Compute the corrections needed to make every motor land in its proper
// role and direction.
//
// `channelFunctions` maps each motor output channel (1-based) to its
// current SERVOn_FUNCTION value, read from the FC. `observations` is keyed
// by the motor's 1-based test order (what was spun).
export function computeCorrections(
  geometry: FrameGeometry,
  observations: Map<number, MotorObservation>,
  channelFunctions: Map<number, number>,
): MotorCorrections {
  // function id → the airframe position that function's motor should sit
  // at, and position → the spin it should turn.
  const positionByFunction = new Map<number, MotorPosition>()
  const spinByPosition = new Map<MotorPosition, Spin>()
  for (const m of geometry.motors) {
    positionByFunction.set(motorFunctionId(m.motorIndex), m.position)
    spinByPosition.set(m.position, m.spin)
  }

  // function id → output channel currently driving it (invert the input).
  const channelByFunction = new Map<number, number>()
  for (const [channel, fn] of channelFunctions)
    channelByFunction.set(fn, channel)

  // For each tested motor, work out the physical motor on its channel.
  // physByChannel: channel → the position the operator saw move (i.e. the
  // physical motor plugged into that channel) + the way it spun.
  const physPositionByChannel = new Map<number, MotorPosition>()
  const physSpinByChannel = new Map<number, Spin>()
  let missing = false

  for (const m of geometry.motors) {
    const fn = motorFunctionId(m.motorIndex)
    const channel = channelByFunction.get(fn)
    const obs = observations.get(m.testOrder)
    if (channel === undefined || obs === undefined) {
      missing = true
      continue
    }
    physPositionByChannel.set(channel, obs.position)
    physSpinByChannel.set(channel, obs.spin)
  }

  // Sanity: the reported positions must be a permutation of the frame's
  // positions, or a remap is undefined.
  const reported = [...physPositionByChannel.values()]
  const uniqueReported = new Set(reported)
  const inconsistent = missing
    || uniqueReported.size !== reported.length
    || reported.length !== geometry.motors.length

  if (inconsistent)
    return { orderOk: false, directionOk: false, remap: [], reverseChannels: [], inconsistent: true }

  // Order remap: each channel should drive the function whose expected
  // position matches the physical motor plugged into it.
  const remap: RemapEntry[] = []
  for (const [channel, physPosition] of physPositionByChannel) {
    const currentFn = channelFunctions.get(channel)
    let desiredFn: number | undefined
    for (const [fn, pos] of positionByFunction) {
      if (pos === physPosition) {
        desiredFn = fn
        break
      }
    }
    if (currentFn !== undefined && desiredFn !== undefined && desiredFn !== currentFn)
      remap.push({ channel, fromFunction: currentFn, toFunction: desiredFn })
  }

  // Direction: a channel's physical motor must spin the way its (physical)
  // position requires; if not, toggle its reverse bit.
  const reverseChannels: number[] = []
  for (const [channel, physSpin] of physSpinByChannel) {
    const physPosition = physPositionByChannel.get(channel)!
    if (physSpin !== spinByPosition.get(physPosition))
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
