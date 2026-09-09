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

// Which way a motor turns, drawn the way people sketch it on a frame: a
// curved arrow hooked around the outside of the motor, opening toward
// the hub. Pure string maths, so the shape can be unit-tested rather
// than eyeballed.
//
// The approach is borrowed from ArduConfigurator's `motor-spin-arc.ts`
// (GPLv3, same licence), which arrived at the outward-centred arc after
// trying a full ring: a ring wrapping the motor reads as decoration,
// while an arc sitting clear of the hub reads as a direction.

import type { Spin } from '../../workflow/motor-geometry'

// Where an arc drawn by spinArcPath ends, and which way it is heading
// when it gets there.
export interface ArcTip {
  x: number
  y: number
  // Heading in SVG rotate() degrees - clockwise from +x, y down - so a
  // marker drawn pointing along +x can just be rotated by it.
  angleDeg: number
}

// Half-span of the arc, in degrees. 80 each side gives a 160-degree
// sweep - enough to read as a curve, with a wide enough gap on the hub
// side that the glyph never collides with the arm.
const HALF_SPAN_DEG = 80

// The arc as an SVG path, centred on `outwardDeg` - the direction from
// the hub out through this motor - so a front motor's arrow domes above
// it and a rear motor's below. Drawn in the direction of travel, which
// is what puts the arrowhead on the right end and makes a dash
// animation along the path move the way the prop turns.
//
// Angles are screen-space: degrees anticlockwise from +x, with y down,
// which is the convention motorTopdownXY already produces.
export function spinArcPath(cx: number, cy: number, r: number, spin: Spin, outwardDeg: number): string {
  const startDeg = outwardDeg + (spin === 'cw' ? HALF_SPAN_DEG : -HALF_SPAN_DEG)
  const endDeg = outwardDeg + (spin === 'cw' ? -HALF_SPAN_DEG : HALF_SPAN_DEG)
  const at = (deg: number) => {
    const rad = (deg * Math.PI) / 180
    return `${(cx + r * Math.cos(rad)).toFixed(2)} ${(cy - r * Math.sin(rad)).toFixed(2)}`
  }
  // Sweep flag 1 is clockwise on screen, which is what 'cw' means to an
  // operator looking down at the drone.
  return `M ${at(startDeg)} A ${r} ${r} 0 0 ${spin === 'cw' ? 1 : 0} ${at(endDeg)}`
}

// The outward direction for a motor at (x, y) relative to the hub, in
// the same screen-space degrees spinArcPath expects. A motor sitting on
// the hub has no outward direction; call it straight up.
export function outwardDeg(x: number, y: number): number {
  if (x === 0 && y === 0)
    return 90
  return (Math.atan2(-y, x) * 180) / Math.PI
}

// The far end of the arc, with the heading to point an arrowhead along.
// Drawn inline by the caller rather than as an SVG <marker>: a marker
// cannot take its colour from the element that referenced it in every
// browser (`context-stroke` is not universally supported), and an
// arrowhead in the wrong colour on a coloured arc is worse than none.
export function spinArcTip(cx: number, cy: number, r: number, spin: Spin, outward: number): ArcTip {
  const endDeg = outward + (spin === 'cw' ? -HALF_SPAN_DEG : HALF_SPAN_DEG)
  const rad = (endDeg * Math.PI) / 180
  // Travelling with decreasing angle (cw on screen) or increasing (ccw).
  const dx = spin === 'cw' ? Math.sin(rad) : -Math.sin(rad)
  const dy = spin === 'cw' ? Math.cos(rad) : -Math.cos(rad)
  return {
    x: cx + r * Math.cos(rad),
    y: cy - r * Math.sin(rad),
    angleDeg: (Math.atan2(dy, dx) * 180) / Math.PI,
  }
}
