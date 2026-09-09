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

// The drone's attitude, and what it means to a scene.
//
// Pure, and separate from the composable that fetches it (use-attitude.ts),
// for the usual reason in this codebase - but also a specific one: the
// convention below was wrong once, and a pure module is one that can be
// tested rather than eyeballed.

// Radians, as the firmware reports them: roll positive right-wing-down,
// pitch positive nose-up, yaw positive clockwise from north seen from
// above.
export interface AttitudeSample {
  roll: number
  pitch: number
  yaw: number
}

/*
  The drone's attitude as rotations of a scene, in the convention the
  3D model is built in: nose along +X, up along +Y, and therefore the
  aircraft's right wing along +Z (because right = forward x up, and
  X x Y = Z in a right-handed scene).

  Two of the three are the identity and one is not, which is exactly why
  this is a function with tests rather than three angles typed into a
  template. Yaw is the odd one: MAVLink counts it clockwise seen from
  above, and a positive rotation about +Y in a right-handed scene turns
  the nose the other way.

  The caller must apply these as yaw, then pitch, then roll - the order
  an aircraft's attitude composes in, and not three's default XYZ Euler
  order. In the model that ordering is the nesting of three groups.
*/
export interface SceneRotation {
  // About +X (the nose axis): positive drops the right wing.
  x: number
  // About +Y (up): positive turns the nose to the aircraft's left.
  y: number
  // About +Z (the right wing axis): positive lifts the nose.
  z: number
}

export function sceneRotation(a: AttitudeSample): SceneRotation {
  return { x: a.roll, y: -a.yaw, z: a.pitch }
}
