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

// The drone, in 3D. It does two jobs, and which one depends on whether
// it is given an attitude.
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
// The airframe is Betaflight Configurator's quad-X mesh (GPLv3, credited
// in src/assets/models/CREDITS.md) - the same model an operator will
// have seen there, which is the point: this view is a convention people
// already know how to read, and a shape built out of boxes and cylinders
// reads as a diagram rather than as their drone.
//
// Two details that make an attitude readable:
//
//   - It is seen from behind, nose away, so screen-right is the drone's
//     right. From the front every roll reads backwards.
//   - Yaw is shown relative to wherever the drone was pointing when the
//     picture went live, not as a compass heading. Absolute heading is
//     true but unhelpful on a desk: the model would sit pointing north
//     while the drone points at the operator. Relative yaw still answers
//     the question being asked - turn it, does the picture turn - and
//     needs no "reset" button to make sense of.

import type { Object3D } from 'three'
import type { AttitudeSample } from '../../workflow/attitude'
import { TresCanvas } from '@tresjs/core'
import { useRafFn } from '@vueuse/core'
import { Box3, Vector3 } from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { computed, onMounted, ref, shallowRef, watch } from 'vue'
import modelUrl from '../../assets/models/quad_x.gltf?url'
import { sceneRotation } from '../../workflow/attitude'

const props = defineProps<{
  // The drone's own estimate, in radians. Null (or absent) parks the
  // model in its idle rotation.
  attitude?: AttitudeSample | null
}>()

// How much of the canvas the airframe fills once normalised.
const MODEL_SPAN = 2.2
// The mesh flies down its own -Z; our attitude convention has the nose
// along +X. Measured by rendering the thing from above and looking at
// which way its green props and its printed arrow pointed, rather than
// assumed - a quarter turn either way is the kind of error that makes
// every roll read as a pitch.
const MODEL_YAW = -Math.PI / 2

// The airframe, once loaded, centred on the origin and scaled to a known
// size so the camera framing doesn't depend on the file's own units.
const body = shallowRef<Object3D | null>(null)
onMounted(() => {
  new GLTFLoader().load(modelUrl, (gltf) => {
    const scene = gltf.scene
    const box = new Box3().setFromObject(scene)
    const centre = box.getCenter(new Vector3())
    const size = box.getSize(new Vector3())
    const scale = MODEL_SPAN / (Math.max(size.x, size.z) || 1)
    scene.scale.setScalar(scale)
    scene.position.set(-centre.x * scale, -centre.y * scale, -centre.z * scale)
    body.value = scene
  })
})

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
    <TresPerspectiveCamera :position="[-1.6, 1.15, 0.8]" :look-at="[0, 0, 0]" />
    <TresAmbientLight :intensity="0.6" />
    <TresDirectionalLight :position="[3, 5, 2]" :intensity="0.9" />

    <!--
      Yaw, then pitch, then roll, nested rather than given as one Euler
      triple: that is the order an aircraft's attitude composes in, and
      three's default XYZ order is not it. Nesting makes the order the
      structure of the scene instead of a convention to remember.

      Nose is +X, up is +Y, so +Z is the aircraft's right (right =
      forward x up, and X x Y = Z here). The angles themselves come from
      sceneRotation, which is where that convention is written down and
      tested.
    -->
    <TresGroup :rotation-y="following ? yaw : idleYaw">
      <TresGroup :rotation-z="following ? pitch : 0">
        <TresGroup :rotation-x="following ? roll : 0">
          <!-- The airframe. Turned once so its nose lies along +X,
               which is what the attitude convention above assumes. -->
          <TresGroup v-if="body" :rotation-y="MODEL_YAW">
            <primitive :object="body" />
          </TresGroup>
        </TresGroup>
      </TresGroup>
    </TresGroup>
  </TresCanvas>
</template>
