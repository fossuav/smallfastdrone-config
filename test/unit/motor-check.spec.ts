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

// Unit tests for the motor-check correction maths. This is the dangerous
// logic — a wrong remap flips a drone — so the swap / reverse / combined
// cases are pinned down here with the quad-X geometry.

import type { MotorObservation } from '../../src/workflow/motor-check'
import { describe, expect, it } from 'vitest'
import {
  applyReverseMask,
  collectMotorChannels,
  computeCorrections,
  isMotorFunction,
  motorFunctionId,
  planCorrection,
  remapParamEdits,
  servoFunctionParam,
  wiringIsDefault,
} from '../../src/workflow/motor-check'
import { frameGeometry, frameVariants, spinForPosition } from '../../src/workflow/motor-geometry'

// Quad X: idx0 FR/ccw (T1), idx1 RL/ccw (T3), idx2 FL/cw (T4), idx3 RR/cw (T2).
const QUAD_X = frameGeometry(1, 1)!
// Default wiring: SERVO1..4 = Motor1..4 (functions 33..36).
const DEFAULT_CHANNELS = new Map([[1, 33], [2, 34], [3, 35], [4, 36]])

// Observations for a perfectly-wired quad X, keyed by test order.
function correctObservations(): Map<number, MotorObservation> {
  return new Map(QUAD_X.motors.map(m => [m.testOrder, { position: m.position, spin: m.spin }]))
}

describe('motorFunctionId', () => {
  it('maps mixer index to SERVOn_FUNCTION value', () => {
    expect(motorFunctionId(0)).toBe(33) // Motor1
    expect(motorFunctionId(7)).toBe(40) // Motor8
    expect(motorFunctionId(8)).toBe(82) // Motor9
    expect(motorFunctionId(11)).toBe(85) // Motor12
  })
})

describe('computeCorrections', () => {
  it('reports all-clear for a correctly wired drone', () => {
    const c = computeCorrections(QUAD_X, correctObservations(), DEFAULT_CHANNELS)
    expect(c.inconsistent).toBe(false)
    expect(c.orderOk).toBe(true)
    expect(c.directionOk).toBe(true)
    expect(c.remap).toEqual([])
    expect(c.reverseChannels).toEqual([])
  })

  it('remaps a swapped pair without touching direction', () => {
    // Front-right and front-left motors physically swapped (each keeps its
    // own intrinsic spin). FR=ccw lives at channel 3, FL=cw at channel 1.
    const obs = correctObservations()
    obs.set(1, { position: 'front-left', spin: 'cw' }) // ch1 (Motor1/FR) drove the FL motor
    obs.set(4, { position: 'front-right', spin: 'ccw' }) // ch3 (Motor3/FL) drove the FR motor

    const c = computeCorrections(QUAD_X, obs, DEFAULT_CHANNELS)
    expect(c.inconsistent).toBe(false)
    expect(c.directionOk).toBe(true)
    expect(c.reverseChannels).toEqual([])
    expect(c.orderOk).toBe(false)
    // ch1 should now drive Motor3's role (FL = function 35); ch3 → FR (33).
    const byChannel = new Map(c.remap.map(r => [r.channel, r.toFunction]))
    expect(byChannel.get(1)).toBe(35)
    expect(byChannel.get(3)).toBe(33)
    expect(c.remap).toHaveLength(2)
  })

  it('flags a reversed motor without remapping', () => {
    // FR motor (channel 1) spins the wrong way.
    const obs = correctObservations()
    obs.set(1, { position: 'front-right', spin: 'cw' }) // should be ccw

    const c = computeCorrections(QUAD_X, obs, DEFAULT_CHANNELS)
    expect(c.inconsistent).toBe(false)
    expect(c.orderOk).toBe(true)
    expect(c.remap).toEqual([])
    expect(c.directionOk).toBe(false)
    expect(c.reverseChannels).toEqual([1])
  })

  it('handles a swap and a reversal together', () => {
    const obs = correctObservations()
    // Swap FR/FL...
    obs.set(1, { position: 'front-left', spin: 'cw' })
    obs.set(4, { position: 'front-right', spin: 'ccw' })
    // ...and the rear-right motor (channel 4) spins the wrong way.
    obs.set(2, { position: 'rear-right', spin: 'ccw' }) // should be cw

    const c = computeCorrections(QUAD_X, obs, DEFAULT_CHANNELS)
    expect(c.inconsistent).toBe(false)
    expect(c.orderOk).toBe(false)
    expect(c.directionOk).toBe(false)
    expect(c.reverseChannels).toEqual([4])
    expect(c.remap).toHaveLength(2)
  })

  it('marks inconsistent observations (two motors at one spot)', () => {
    const obs = correctObservations()
    obs.set(1, { position: 'rear-left', spin: 'ccw' }) // duplicate of T3
    const c = computeCorrections(QUAD_X, obs, DEFAULT_CHANNELS)
    expect(c.inconsistent).toBe(true)
    expect(c.remap).toEqual([])
    expect(c.reverseChannels).toEqual([])
  })
})

describe('isMotorFunction', () => {
  it('accepts the motor function ranges and rejects others', () => {
    expect(isMotorFunction(33)).toBe(true) // Motor1
    expect(isMotorFunction(40)).toBe(true) // Motor8
    expect(isMotorFunction(82)).toBe(true) // Motor9
    expect(isMotorFunction(85)).toBe(true) // Motor12
    expect(isMotorFunction(0)).toBe(false) // Disabled
    expect(isMotorFunction(32)).toBe(false) // RCPassThru-ish, below k_motor1
    expect(isMotorFunction(41)).toBe(false) // gap above Motor8
    expect(isMotorFunction(86)).toBe(false) // above Motor12
  })
})

describe('servoFunctionParam', () => {
  it('names the SERVOn_FUNCTION param for a channel', () => {
    expect(servoFunctionParam(1)).toBe('SERVO1_FUNCTION')
    expect(servoFunctionParam(12)).toBe('SERVO12_FUNCTION')
  })
})

describe('collectMotorChannels', () => {
  it('keeps only the channels carrying a motor function', () => {
    // ch1..4 motors (33..36); ch5 a servo (e.g. gripper, function 28); ch6 unset.
    const fns = new Map([[1, 33], [2, 34], [3, 35], [4, 36], [5, 28]])
    const motors = collectMotorChannels(ch => fns.get(ch))
    expect([...motors.entries()]).toEqual([[1, 33], [2, 34], [3, 35], [4, 36]])
  })
})

describe('remapParamEdits', () => {
  it('turns remap entries into SERVOn_FUNCTION writes', () => {
    const edits = remapParamEdits([
      { channel: 1, fromFunction: 33, toFunction: 35 },
      { channel: 3, fromFunction: 35, toFunction: 33 },
    ])
    expect(edits).toEqual([
      { name: 'SERVO1_FUNCTION', value: 35 },
      { name: 'SERVO3_FUNCTION', value: 33 },
    ])
  })
})

describe('applyReverseMask', () => {
  it('sets the bit for a channel (bit 0 = channel 1)', () => {
    expect(applyReverseMask(0, [1])).toBe(0b0001)
    expect(applyReverseMask(0, [3])).toBe(0b0100)
    expect(applyReverseMask(0, [1, 4])).toBe(0b1001)
  })

  it('toggles rather than sets — reapplying clears the bit', () => {
    // Channel 2 already reversed; reversing it again unreverses it.
    expect(applyReverseMask(0b0010, [2])).toBe(0)
  })

  it('preserves bits for channels it does not touch', () => {
    // Channel 1 already reversed; only flip channel 4.
    expect(applyReverseMask(0b0001, [4])).toBe(0b1001)
  })
})

describe('spinForPosition', () => {
  it('gives the props-in spins and flips them for props-out', () => {
    // props-in (ArduPilot X): FR/RL ccw, FL/RR cw.
    expect(spinForPosition('front-right', false)).toBe('ccw')
    expect(spinForPosition('rear-left', false)).toBe('ccw')
    expect(spinForPosition('front-left', false)).toBe('cw')
    expect(spinForPosition('rear-right', false)).toBe('cw')
    // props-out is the mirror.
    expect(spinForPosition('front-right', true)).toBe('cw')
    expect(spinForPosition('front-left', true)).toBe('ccw')
  })
})

describe('wiringIsDefault', () => {
  it('is true for SERVOn = Motor n and false otherwise', () => {
    expect(wiringIsDefault(new Map([[1, 33], [2, 34], [3, 35], [4, 36]]))).toBe(true)
    expect(wiringIsDefault(new Map([[1, 35], [2, 34], [3, 33], [4, 36]]))).toBe(false)
    expect(wiringIsDefault(new Map())).toBe(false)
  })
})

describe('planCorrection (quad X current frame, default wiring)', () => {
  const VARIANTS = frameVariants(1)

  it('reports nothing to do for a correctly-wired props-in drone', () => {
    const p = planCorrection(QUAD_X, correctObservations(), DEFAULT_CHANNELS, false, VARIANTS)
    expect(p.kind).toBe('none')
  })

  it('switches to the props-out layout (H) when the operator builds props-out', () => {
    // Same positions, every spin flipped — operator confirms props-out.
    const obs = new Map([
      [1, { position: 'front-right' as const, spin: 'cw' as const }],
      [2, { position: 'rear-right' as const, spin: 'ccw' as const }],
      [3, { position: 'rear-left' as const, spin: 'cw' as const }],
      [4, { position: 'front-left' as const, spin: 'ccw' as const }],
    ])
    const p = planCorrection(QUAD_X, obs, DEFAULT_CHANNELS, true, VARIANTS)
    expect(p.kind).toBe('frame-type')
    if (p.kind === 'frame-type') {
      expect(p.frameType).toBe(3) // MOTOR_FRAME_TYPE_H
      expect(p.reverseChannels).toEqual([])
    }
  })

  it('switches to the Betaflight layout when the wiring matches it', () => {
    // Observed wiring = Betaflight order, props-in.
    const obs = new Map([
      [1, { position: 'rear-right' as const, spin: 'cw' as const }],
      [2, { position: 'front-left' as const, spin: 'cw' as const }],
      [3, { position: 'front-right' as const, spin: 'ccw' as const }],
      [4, { position: 'rear-left' as const, spin: 'ccw' as const }],
    ])
    const p = planCorrection(QUAD_X, obs, DEFAULT_CHANNELS, false, VARIANTS)
    expect(p.kind).toBe('frame-type')
    if (p.kind === 'frame-type') {
      expect(p.frameType).toBe(12) // MOTOR_FRAME_TYPE_BF_X
      expect(p.reverseChannels).toEqual([])
    }
  })

  it('reverses a single backwards motor without changing the frame', () => {
    const obs = correctObservations()
    obs.set(1, { position: 'front-right', spin: 'cw' }) // should be ccw
    const p = planCorrection(QUAD_X, obs, DEFAULT_CHANNELS, false, VARIANTS)
    // Direction-only fix: a remap with no reorder, just the reverse.
    expect(p.kind).toBe('remap')
    if (p.kind === 'remap') {
      expect(p.remap).toEqual([])
      expect(p.reverseChannels).toEqual([1])
    }
  })

  it('falls back to an output remap for a non-standard swap', () => {
    const obs = correctObservations()
    obs.set(1, { position: 'front-left', spin: 'cw' }) // ch1 drives the FL motor
    obs.set(4, { position: 'front-right', spin: 'ccw' }) // ch3 drives the FR motor
    const p = planCorrection(QUAD_X, obs, DEFAULT_CHANNELS, false, VARIANTS)
    expect(p.kind).toBe('remap')
    if (p.kind === 'remap') {
      expect(p.remap).toHaveLength(2)
      expect(p.reverseChannels).toEqual([])
    }
  })

  it('flags inconsistent observations', () => {
    const obs = correctObservations()
    obs.set(1, { position: 'rear-left', spin: 'ccw' }) // duplicate of T3
    expect(planCorrection(QUAD_X, obs, DEFAULT_CHANNELS, false, VARIANTS).kind).toBe('inconsistent')
  })
})
