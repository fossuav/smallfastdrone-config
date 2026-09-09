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

// Unit tests for the spin-direction arrow on the motor map. The arrow is
// the whole point of the graphic - an operator reads which way a motor
// should be turning off it - so the two things that could silently be
// wrong are pinned here: the sweep direction, and where the arc sits
// relative to the hub.

import { describe, expect, it } from 'vitest'
import { outwardDeg, spinArcPath, spinArcTip } from '../../src/ui/visuals/spin-arc'

// Pull the numbers back out of "M x y A r r 0 0 f x y". The path rounds
// to two decimals - it is drawing instructions, not a measurement - so
// every comparison here is to that precision.
function parse(d: string) {
  const n = d.match(/-?\d+(?:\.\d+)?/g)!.map(Number)
  return { start: { x: n[0], y: n[1] }, sweep: n[6], end: { x: n[7], y: n[8] } }
}

describe('spinArcPath', () => {
  it('sweeps clockwise on screen for a clockwise motor', () => {
    expect(parse(spinArcPath(0, 0, 25, 'cw', 90)).sweep).toBe(1)
    expect(parse(spinArcPath(0, 0, 25, 'ccw', 90)).sweep).toBe(0)
  })

  it('mirrors: the two directions swap ends', () => {
    const cw = parse(spinArcPath(40, -60, 25, 'cw', 90))
    const ccw = parse(spinArcPath(40, -60, 25, 'ccw', 90))
    expect(cw.start.x).toBeCloseTo(ccw.end.x, 2)
    expect(cw.start.y).toBeCloseTo(ccw.end.y, 2)
    expect(cw.end.x).toBeCloseTo(ccw.start.x, 2)
    expect(cw.end.y).toBeCloseTo(ccw.start.y, 2)
  })

  it('opens away from the hub, so the glyph never sits over the arm', () => {
    // A front-left motor: both ends of the arc are further from the hub
    // than the motor itself, because the arc domes outward.
    const cx = -60
    const cy = -60
    const hub = (p: { x: number, y: number }) => Math.hypot(p.x, p.y)
    const { start, end } = parse(spinArcPath(cx, cy, 25, 'cw', outwardDeg(cx, cy)))
    expect(hub(start)).toBeGreaterThan(hub({ x: cx, y: cy }))
    expect(hub(end)).toBeGreaterThan(hub({ x: cx, y: cy }))
  })

  it('stays on the circle it was asked for', () => {
    const { start, end } = parse(spinArcPath(10, 20, 25, 'ccw', 0))
    expect(Math.hypot(start.x - 10, start.y - 20)).toBeCloseTo(25, 2)
    expect(Math.hypot(end.x - 10, end.y - 20)).toBeCloseTo(25, 2)
  })
})

describe('spinArcTip', () => {
  it('sits on the end of the arc it describes', () => {
    for (const spin of ['cw', 'ccw'] as const) {
      const tip = spinArcTip(40, -60, 25, spin, 90)
      const { end } = parse(spinArcPath(40, -60, 25, spin, 90))
      expect(tip.x).toBeCloseTo(end.x, 2)
      expect(tip.y).toBeCloseTo(end.y, 2)
    }
  })

  it('heads the way the arc was travelling, so the two directions mirror', () => {
    // Arc centred over the top: the clockwise one finishes on the right
    // heading down-right, the anticlockwise one on the left heading
    // down-left. Mirror images about the vertical, which is 90 degrees
    // in SVG's clockwise-from-+x, y-down convention.
    const cw = spinArcTip(0, 0, 25, 'cw', 90)
    const ccw = spinArcTip(0, 0, 25, 'ccw', 90)
    expect(cw.x).toBeCloseTo(-ccw.x, 2)
    expect(cw.y).toBeCloseTo(ccw.y, 2)
    expect(cw.angleDeg + ccw.angleDeg).toBeCloseTo(180, 2)
  })

  it('points along the ring, not at it', () => {
    // The heading is perpendicular to the radius at the tip - that is
    // what makes an arrowhead read as travel rather than as a spoke.
    const tip = spinArcTip(0, 0, 25, 'cw', 90)
    const radial = (Math.atan2(tip.y, tip.x) * 180) / Math.PI
    const between = Math.abs(((tip.angleDeg - radial + 540) % 360) - 180)
    expect(between).toBeCloseTo(90, 2)
  })
})

describe('outwardDeg', () => {
  it('points up for a motor in front of the hub (y is down in SVG)', () => {
    expect(outwardDeg(0, -50)).toBeCloseTo(90, 2)
  })

  it('points down for a motor behind it', () => {
    expect(outwardDeg(0, 50)).toBeCloseTo(-90, 2)
  })

  it('points right for a motor out to the right', () => {
    expect(outwardDeg(50, 0)).toBeCloseTo(0, 2)
  })

  it('falls back to up for a motor on the hub, where outward is undefined', () => {
    expect(outwardDeg(0, 0)).toBe(90)
  })
})
