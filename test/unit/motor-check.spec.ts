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
import { expectedSpin, flipSpin, frameGeometry, frameVariants } from '../../src/workflow/motor-geometry'

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

describe('flipSpin / expectedSpin', () => {
  it('flips a spin direction', () => {
    expect(flipSpin('cw')).toBe('ccw')
    expect(flipSpin('ccw')).toBe('cw')
  })

  it('returns the frame spin for the same orientation and flips for the other', () => {
    const m = QUAD_X.motors[0]! // front-right, ccw, props-in frame
    expect(expectedSpin(m, false, QUAD_X)).toBe('ccw') // props-in matches frame
    expect(expectedSpin(m, true, QUAD_X)).toBe('cw') // props-out flips
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

describe('hexa / octa geometry', () => {
  const FRAMES = [
    { name: 'hexa X', cls: 2, type: 1, count: 6 },
    { name: 'hexa +', cls: 2, type: 0, count: 6 },
    { name: 'octa X', cls: 3, type: 1, count: 8 },
    { name: 'octa +', cls: 3, type: 0, count: 8 },
  ]

  for (const { name, cls, type, count } of FRAMES) {
    it(`${name}: ${count} motors, contiguous test order + indices, unique positions`, () => {
      const geo = frameGeometry(cls, type)
      expect(geo).toBeTruthy()
      const seq = Array.from({ length: count }, (_, i) => i + 1)
      expect(geo!.motors.map(m => m.testOrder).sort((a, b) => a - b)).toEqual(seq)
      expect(geo!.motors.map(m => m.motorIndex).sort((a, b) => a - b)).toEqual(seq.map(n => n - 1))
      // Unique positions are required — the operator identifies motors by them.
      expect(new Set(geo!.motors.map(m => m.position)).size).toBe(count)
    })
  }

  it('hexa X matches the firmware (spot checks)', () => {
    const byOrder = new Map(frameGeometry(2, 1)!.motors.map(m => [m.testOrder, m]))
    expect(byOrder.get(1)).toMatchObject({ angleDeg: 30, position: 'front-right', spin: 'ccw' })
    expect(byOrder.get(2)).toMatchObject({ angleDeg: 90, position: 'right', spin: 'cw' })
  })

  it('octa X labels its 22.5°-offset motors with the side positions', () => {
    const byOrder = new Map(frameGeometry(3, 1)!.motors.map(m => [m.testOrder, m]))
    expect(byOrder.get(1)).toMatchObject({ angleDeg: 22.5, position: 'front-right' })
    expect(byOrder.get(2)).toMatchObject({ angleDeg: 67.5, position: 'right-front' })
  })
})

describe('planCorrection on hexa X', () => {
  const HEXA_X = frameGeometry(2, 1)!
  const HEXA_CHANNELS = new Map([[1, 33], [2, 34], [3, 35], [4, 36], [5, 37], [6, 38]])
  const VARIANTS = frameVariants(2)

  function correct(): Map<number, MotorObservation> {
    return new Map(HEXA_X.motors.map(m => [m.testOrder, { position: m.position, spin: m.spin }]))
  }

  it('reports nothing to do for a correctly wired hexa X', () => {
    expect(planCorrection(HEXA_X, correct(), HEXA_CHANNELS, false, VARIANTS).kind).toBe('none')
  })

  it('reverses a single backwards motor (direction-only)', () => {
    const t1 = HEXA_X.motors.find(m => m.testOrder === 1)!
    const channel = [...HEXA_CHANNELS].find(([, fn]) => fn === motorFunctionId(t1.motorIndex))![0]
    const obs = correct()
    obs.set(1, { position: t1.position, spin: flipSpin(t1.spin) })
    const p = planCorrection(HEXA_X, obs, HEXA_CHANNELS, false, VARIANTS)
    expect(p.kind).toBe('remap')
    if (p.kind === 'remap') {
      expect(p.remap).toEqual([])
      expect(p.reverseChannels).toEqual([channel])
    }
  })
})
