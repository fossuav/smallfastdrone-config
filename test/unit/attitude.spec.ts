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

// Does the model actually lean the way the drone leaned?
//
// This is the whole value of the live view - an operator tips their
// drone and trusts what the picture does - and it is a convention that
// is easy to get backwards without anything looking obviously wrong. It
// was backwards once already: yaw, because MAVLink counts it clockwise
// from above and a positive rotation about the scene's up axis turns the
// nose the other way.
//
// So rather than assert the three numbers (which would only restate the
// code), these rotate the aircraft's own landmarks - nose, right wing,
// belly - and ask where they ended up.

import type { AttitudeSample } from '../../src/workflow/attitude'
import { Euler, Quaternion, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import { sceneRotation } from '../../src/workflow/attitude'

const NOSE = new Vector3(1, 0, 0)
const RIGHT_WING = new Vector3(0, 0, 1)
const UP = new Vector3(0, 1, 0)

// Where a body-frame landmark ends up in the world, composing the
// rotations the way the model nests them: yaw, then pitch, then roll.
function place(landmark: Vector3, a: AttitudeSample): Vector3 {
  const r = sceneRotation(a)
  const q = new Quaternion()
    .setFromEuler(new Euler(0, r.y, 0))
    .multiply(new Quaternion().setFromEuler(new Euler(0, 0, r.z)))
    .multiply(new Quaternion().setFromEuler(new Euler(r.x, 0, 0)))
  return landmark.clone().applyQuaternion(q)
}

const LEVEL: AttitudeSample = { roll: 0, pitch: 0, yaw: 0 }
const DEG = Math.PI / 180

describe('sceneRotation', () => {
  it('leaves a level drone level', () => {
    const nose = place(NOSE, LEVEL)
    expect(nose.x).toBeCloseTo(1, 6)
    expect(nose.y).toBeCloseTo(0, 6)
    expect(place(UP, LEVEL).y).toBeCloseTo(1, 6)
  })

  it('drops the right wing on a positive roll', () => {
    const wing = place(RIGHT_WING, { ...LEVEL, roll: 30 * DEG })
    expect(wing.y).toBeLessThan(0)
    // ...and the left wing goes up by as much.
    expect(place(RIGHT_WING.clone().negate(), { ...LEVEL, roll: 30 * DEG }).y)
      .toBeCloseTo(-wing.y, 6)
  })

  it('lifts the nose on a positive pitch', () => {
    const nose = place(NOSE, { ...LEVEL, pitch: 20 * DEG })
    expect(nose.y).toBeGreaterThan(0)
    expect(nose.y).toBeCloseTo(Math.sin(20 * DEG), 6)
  })

  it('swings the nose toward the right wing on a positive yaw', () => {
    // MAVLink yaw is clockwise seen from above, so the nose turns the way
    // the right wing was pointing.
    const nose = place(NOSE, { ...LEVEL, yaw: 45 * DEG })
    expect(nose.z).toBeGreaterThan(0)
    expect(nose.y).toBeCloseTo(0, 6)
  })

  it('keeps yaw level - a turn is not a lean', () => {
    const up = place(UP, { ...LEVEL, yaw: 90 * DEG })
    expect(up.y).toBeCloseTo(1, 6)
  })

  it('rolls about the nose, so a roll does not move the nose', () => {
    const nose = place(NOSE, { ...LEVEL, roll: 40 * DEG })
    expect(nose.x).toBeCloseTo(1, 6)
  })

  it('composes a bank and a climb without the two cancelling', () => {
    const a = { roll: 25 * DEG, pitch: 15 * DEG, yaw: 0 }
    expect(place(NOSE, a).y).toBeGreaterThan(0)
    expect(place(RIGHT_WING, a).y).toBeLessThan(0)
  })
})
