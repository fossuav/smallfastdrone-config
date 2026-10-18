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

// Unit tests for reading the props-on motor probe. The signs are the
// dangerous part: a bearing read the wrong way round, or a yaw sign
// flipped, would send the correction planner to remap a correctly-wired
// drone - and nothing about a wrong sign looks wrong on a bench.

import type { PROBE_FIELDS, ProbeMotorResult } from '../../src/workflow/motor-probe'
import { describe, expect, it } from 'vitest'
import { frameGeometry } from '../../src/workflow/motor-geometry'
import {
  angleDiff,
  PROBE_ABORT_TEXT,
  probeResult,
  probeValueName,
  readProbe,
  spinFromYaw,
  suggestSpin,
} from '../../src/workflow/motor-probe'
import { storageProblemText } from '../../src/workflow/script-storage'

// Quad X, test order: T1 front-right 45° ccw, T2 rear-right 135° cw,
// T3 rear-left 225° ccw, T4 front-left 315° cw.
const QUAD_X = frameGeometry(1, 1)!

// A motor result with sensible defaults, overridden per test.
function result(over: Partial<ProbeMotorResult> & { testOrder: number }): ProbeMotorResult {
  return { start: 0.05, lift: 0.35, bearingDeg: null, tiltDeg: 2, yawDeg: 0, rpm: 9000, output: null, ...over }
}

// The values the applet would send for one motor.
function sent(t: number, v: Record<string, number>): Map<string, number> {
  return new Map(Object.entries(v).map(([k, x]) => [probeValueName(t, k as typeof PROBE_FIELDS[number]), x]))
}

describe('probeResult', () => {
  it('waits until every field has arrived', () => {
    const partial = sent(1, { START: 0.05, LIFT: 0.3, BRG: 45 })
    expect(probeResult(1, partial)).toBeNull()
  })

  it('turns the applet\'s "never" markers into nulls', () => {
    const values = sent(2, { START: -1, LIFT: -1, BRG: -1, TILT: 0, YAW: 0, RPM: 0, CH: 0 })
    expect(probeResult(2, values)).toEqual({
      testOrder: 2,
      start: null,
      lift: null,
      bearingDeg: null,
      tiltDeg: 0,
      yawDeg: 0,
      rpm: null,
      output: null,
    })
  })

  it('reads a motor that lifted', () => {
    const values = sent(3, { START: 0.06, LIFT: 0.4, BRG: 226, TILT: 2.5, YAW: 1.2, RPM: 12000, CH: 2 })
    expect(probeResult(3, values)).toEqual({
      testOrder: 3,
      start: 0.06,
      lift: 0.4,
      bearingDeg: 226,
      tiltDeg: 2.5,
      yawDeg: 1.2,
      rpm: 12000,
      output: 2,
    })
  })

  it('ignores a bearing on a motor that never lifted', () => {
    const values = sent(1, { START: 0.05, LIFT: -1, BRG: 90, TILT: 0.4, YAW: 0, RPM: 8000, CH: 1 })
    expect(probeResult(1, values)!.bearingDeg).toBeNull()
  })
})

describe('angleDiff', () => {
  it('takes the short way round', () => {
    expect(angleDiff(350, 10)).toBe(20)
    expect(angleDiff(10, 350)).toBe(-20)
    expect(angleDiff(45, 47)).toBe(2)
  })

  it('calls opposite sides 180, not -180', () => {
    expect(angleDiff(0, 180)).toBe(180)
    expect(angleDiff(90, 270)).toBe(180)
  })
})

describe('spinFromYaw', () => {
  // The rotor kicks the frame the other way, and the firmware counts
  // clockwise-from-above as positive yaw.
  it('reads a frame turning anticlockwise as a motor turning clockwise', () => {
    expect(spinFromYaw(-1.5)).toBe('cw')
  })

  it('reads a frame turning clockwise as a motor turning anticlockwise', () => {
    expect(spinFromYaw(1.5)).toBe('ccw')
  })

  it('won\'t call a twitch too small to tell from noise', () => {
    expect(spinFromYaw(0.1)).toBeNull()
    expect(spinFromYaw(-0.1)).toBeNull()
  })
})

describe('readProbe', () => {
  it('passes a motor that lifted where expected, turning the expected way', () => {
    // T1 is front-right and turns anticlockwise, so the frame turns clockwise.
    const r = readProbe(QUAD_X, result({ testOrder: 1, bearingDeg: 47, yawDeg: 2 }))
    expect(r.found?.testOrder).toBe(1)
    expect(r.placeOk).toBe(true)
    expect(r.spin).toBe('ccw')
    expect(r.spinOk).toBe(true)
  })

  it('finds a motor wired to the wrong corner', () => {
    // The motor the frame calls front-right lifted the front-left corner.
    const r = readProbe(QUAD_X, result({ testOrder: 1, bearingDeg: 312, yawDeg: 2 }))
    expect(r.expected?.position).toBe('front-right')
    expect(r.found?.position).toBe('front-left')
    expect(r.placeOk).toBe(false)
  })

  it('flags a motor turning the wrong way', () => {
    // T2 is rear-right and should turn clockwise; the frame turned clockwise too.
    const r = readProbe(QUAD_X, result({ testOrder: 2, bearingDeg: 136, yawDeg: 1.4 }))
    expect(r.placeOk).toBe(true)
    expect(r.spin).toBe('ccw')
    expect(r.spinOk).toBe(false)
  })

  it('says nothing about place or direction for a corner that never lifted', () => {
    const r = readProbe(QUAD_X, result({ testOrder: 3, lift: null, bearingDeg: null, yawDeg: 3 }))
    expect(r.found).toBeNull()
    expect(r.placeOk).toBeNull()
    expect(r.spin).toBeNull()
    expect(r.spinOk).toBeNull()
  })

  it('doesn\'t guess a direction from a turn too small to call', () => {
    const r = readProbe(QUAD_X, result({ testOrder: 4, bearingDeg: 318, yawDeg: 0.1 }))
    expect(r.placeOk).toBe(true)
    expect(r.spin).toBeNull()
    expect(r.spinOk).toBeNull()
  })
})

describe('suggestSpin', () => {
  it('sets spin-arm a margin above the slowest motor, and spin-min above that', () => {
    const results = [0.05, 0.07, 0.055, 0.06].map((start, i) => result({ testOrder: i + 1, start }))
    expect(suggestSpin(results)).toEqual({ slowest: 0.07, arm: 0.09, min: 0.12 })
  })

  it('suggests nothing unless every motor reported where it starts', () => {
    expect(suggestSpin([result({ testOrder: 1 }), result({ testOrder: 2, start: null })])).toBeNull()
    expect(suggestSpin([])).toBeNull()
  })
})

describe('operator copy', () => {
  it('has words for every reason the applet can stop', () => {
    for (let code = 1; code <= 10; code++)
      expect(PROBE_ABORT_TEXT[code], `abort ${code}`).toBeTruthy()
  })

  it('says nothing when there is somewhere to put the test', () => {
    expect(storageProblemText('ok')).toBeNull()
    expect(storageProblemText('no-card')).toMatch(/SD card/)
  })
})
