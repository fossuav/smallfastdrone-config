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
import { computeCorrections, motorFunctionId } from '../../src/workflow/motor-check'
import { frameGeometry } from '../../src/workflow/motor-geometry'

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
