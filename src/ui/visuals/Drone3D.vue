<script setup lang="ts">
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

// An X-quad built from primitives, in the FOSS UAV palette. It does two
// jobs, and which one depends on whether it is given an attitude.
//
// Without one it turns slowly on the spot: the Connect splash, something
// alive to look at while the operator plugs in.
//
// With one it mirrors the drone. This is the case that earns 3D under
// decision 45 - the answer genuinely depends on depth, because the
// operator is comparing a picture against an object in their hands. Tip
// the drone, the picture tips; turn it, the picture turns. If it doesn't,
// or it leans the wrong way, they have learned in one second that the
// board is mounted at an angle the firmware doesn't know about, or that
// the IMU isn't healthy - without a wizard, a parameter, or a question.
//
// Two details that make it readable:
//
//   - It has a nose. The frame is four-fold symmetric, so without one
//     roll and pitch look identical and yaw is invisible.
//   - Yaw is shown relative to wherever the drone was pointing when the
//     picture went live, not as a compass heading. Absolute heading is
//     true but unhelpful on a desk: the model would sit pointing north
//     while the drone points at the operator. Relative yaw still answers
//     the question being asked - turn it, does the picture turn - and
//     needs no "reset" button to make sense of.

import type { AttitudeSample } from '../../workflow/attitude'
import { TresCanvas } from '@tresjs/core'
import { useRafFn } from '@vueuse/core'
import { computed, ref, watch } from 'vue'
import { sceneRotation } from '../../workflow/attitude'

const props = defineProps<{
  // The drone's own estimate, in radians. Null (or absent) parks the
  // model in its idle rotation.
  attitude?: AttitudeSample | null
}>()

const ARM_END = 0.35 // half-diagonal length where motors sit
const Y_PROP = 0.05 // prop disc height above motor
const NOSE = 0.5 // length of the nose cone, along +X

const PURPLE = '#4A1E80'
const GOLD = '#C9A35F'
// Front and back are told apart by colour as well as by the nose, which
// is what makes an attitude readable in a thumbnail: at this size a
// single spike is easy to miss, two gold arms are not. It is the same
// trick as coloured front props on a real airframe.
const FRONT = '#E0B978'

// Motors on the diagonals of an X, nose (+X) between the front pair.
const motors = [
  { x: ARM_END, z: ARM_END, front: true },
  { x: ARM_END, z: -ARM_END, front: true },
  { x: -ARM_END, z: ARM_END, front: false },
  { x: -ARM_END, z: -ARM_END, front: false },
].map(m => ({
  ...m,
  // A box built along +X, swung round to point at this motor. Rotation
  // about +Y takes +X toward -Z, hence the sign.
  rotationY: -Math.atan2(m.z, m.x),
  position: [m.x, 0.02, m.z] as [number, number, number],
  propPosition: [m.x, Y_PROP, m.z] as [number, number, number],
}))

const following = computed(() => props.attitude != null)

// Where the drone was pointing when the picture went live. Everything
// yaw-shaped is measured from here, and it is re-taken whenever the
// picture stops and starts again - a reconnect should not leave the
// model facing a direction the operator can't account for.
const yawReference = ref<number | null>(null)
watch(following, (now) => {
  if (!now)
    yawReference.value = null
})

// Shortest way round: yaw wraps at +/-pi, and easing through the long
// way makes a drone that turned five degrees spin most of a circle.
function wrap(rad: number): number {
  return Math.atan2(Math.sin(rad), Math.cos(rad))
}

const roll = ref(0)
const pitch = ref(0)
const yaw = ref(0)
// Idle spin, used only when there is no attitude to show.
const idleYaw = ref(0)

// Ease toward the reported attitude rather than snapping to it. At 20 Hz
// snapping is watchable but stepped, and the easing also covers a packet
// that arrives late without the model stuttering.
const EASE_PER_SEC = 12

useRafFn(({ delta }) => {
  const dt = Math.min(delta / 1000, 0.1)
  const a = props.attitude
  if (!a) {
    // ~0.4 rad/s = gentle, not dizzying.
    idleYaw.value += dt * 0.4
    return
  }
  if (yawReference.value === null)
    yawReference.value = a.yaw

  // Measured from where the drone was pointing when the picture went
  // live, then turned into scene rotations - which is where the yaw sign
  // is dealt with, once, next to its tests.
  const target = sceneRotation({ ...a, yaw: wrap(a.yaw - yawReference.value) })
  const k = 1 - Math.exp(-EASE_PER_SEC * dt)
  roll.value += wrap(target.x - roll.value) * k
  pitch.value += wrap(target.z - pitch.value) * k
  yaw.value += wrap(target.y - yaw.value) * k
})
</script>

<template>
  <TresCanvas clear-color="#00000000" :alpha="true">
    <!--
      Behind the drone and a little above, the way an operator stands
      when they hold one nose-away. That is what makes screen-right the
      aircraft's right: the camera's right vector works out as +Z, which
      is the right wing. Viewed from the front, every roll would read
      backwards.
    -->
    <TresPerspectiveCamera :position="[-1.0, 0.75, 0.5]" :look-at="[0, 0, 0]" />
    <TresAmbientLight :intensity="0.6" />
    <TresDirectionalLight :position="[3, 5, 2]" :intensity="0.9" />

    <!--
      Yaw, then pitch, then roll, nested rather than given as one Euler
      triple: that is the order an aircraft's attitude composes in, and
      three's default XYZ order is not it. Nesting makes the order the
      structure of the scene instead of a convention to remember.

      Nose is +X, up is +Y, so +Z is the aircraft's left. Hence pitch
      about Z (nose toward up) and roll about X (left side toward up).
    -->
    <TresGroup :rotation-y="following ? yaw : idleYaw">
      <TresGroup :rotation-z="following ? pitch : 0">
        <TresGroup :rotation-x="following ? roll : 0">
          <!-- Centre body -->
          <TresMesh>
            <TresBoxGeometry :args="[0.28, 0.08, 0.28]" />
            <TresMeshStandardMaterial :color="PURPLE" :metalness="0.3" :roughness="0.45" />
          </TresMesh>

          <!-- Nose. Without it the frame is four-fold symmetric and an
               attitude is unreadable: roll and pitch look the same and
               yaw looks like nothing at all. -->
          <TresMesh :position="[NOSE / 2 + 0.09, 0.01, 0]" :rotation="[0, 0, -Math.PI / 2]">
            <TresConeGeometry :args="[0.1, NOSE, 4]" />
            <TresMeshStandardMaterial :color="FRONT" :metalness="0.5" :roughness="0.35" />
          </TresMesh>

          <!-- One arm per motor, so the front pair can be its own colour. -->
          <TresGroup v-for="(m, i) in motors" :key="`a-${i}`" :rotation-y="m.rotationY">
            <TresMesh :position="[ARM_END / 2, 0.01, 0]">
              <TresBoxGeometry :args="[ARM_END, 0.045, 0.045]" />
              <TresMeshStandardMaterial
                :color="m.front ? FRONT : PURPLE"
                :metalness="0.3"
                :roughness="0.5"
              />
            </TresMesh>
          </TresGroup>

          <!-- Motors (gold cylinders) at the four corners -->
          <TresMesh
            v-for="(m, i) in motors"
            :key="`m-${i}`"
            :position="m.position"
          >
            <TresCylinderGeometry :args="[0.08, 0.08, 0.05, 24]" />
            <TresMeshStandardMaterial :color="GOLD" :metalness="0.75" :roughness="0.25" />
          </TresMesh>

          <!-- Translucent props above motors -->
          <TresMesh
            v-for="(m, i) in motors"
            :key="`p-${i}`"
            :position="m.propPosition"
          >
            <TresCylinderGeometry :args="[0.19, 0.19, 0.005, 32]" />
            <TresMeshStandardMaterial
              :color="m.front ? FRONT : PURPLE"
              :metalness="0.1"
              :roughness="0.7"
              :transparent="true"
              :opacity="0.55"
            />
          </TresMesh>
        </TresGroup>
      </TresGroup>
    </TresGroup>
  </TresCanvas>
</template>
