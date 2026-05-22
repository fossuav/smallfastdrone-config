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

// Hero visual for the motor-check wizard — the Betaflight quad-X airframe
// model (vendored, see src/assets/models/CREDITS.md) seen from near-above
// with the nose pointing AWAY from the operator. Each motor gets a faint
// ring; the motor under test glows and a prop spins above it in its
// expected direction, mirroring what the operator sees on the bench.
//
// Near-top-down on purpose: motor screen positions then follow
// motorTopdownXY, so the wizard view can lay text labels precisely over
// each motor (see MOTOR_OVERLAY_RADIUS there). The model is a single mesh,
// so highlighting is overlaid rather than recolouring it.

import type { Object3D } from 'three'
import type { Spin } from '../../workflow/motor-geometry'
import { TresCanvas } from '@tresjs/core'
import { useRafFn } from '@vueuse/core'
import { Box3, Vector3 } from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { computed, onMounted, ref, shallowRef } from 'vue'
import modelUrl from '../../assets/models/quad_x.gltf?url'
import { motorTopdownXY } from '../../workflow/motor-geometry'

export interface MotorVisual {
  // Stable key (the motor's test order).
  key: number
  // Airframe angle, firmware convention (0 = forward, +cw from above).
  angleDeg: number
  // Expected prop spin — drives the active motor's spin animation.
  spin: Spin
  // Drives the ring colour + glow + whether the prop spins.
  state: 'idle' | 'active' | 'done' | 'mismatch'
}

const props = defineProps<{
  motors: MotorVisual[]
  // Extra yaw (deg) applied to the body only — the vendored model is an
  // X-frame; a Plus frame rotates it 45° so its arms line up with the rings.
  bodyYawDeg?: number
}>()

const RING_R = 1.05
const RING_Y = 0.12
const PROP_Y = 0.45
// Native yaw to point the model's nose at -Z (away from the camera).
const MODEL_BASE_YAW = 0

const COLOR = {
  idle: '#C9A35F',
  active: '#f59e0b',
  done: '#22c55e',
  mismatch: '#ef4444',
} as const

function ringColor(state: MotorVisual['state']): string {
  return COLOR[state]
}

const body = shallowRef<Object3D | null>(null)
onMounted(() => {
  const loader = new GLTFLoader()
  loader.load(modelUrl, (gltf) => {
    const scene = gltf.scene
    const box = new Box3().setFromObject(scene)
    const center = box.getCenter(new Vector3())
    const size = box.getSize(new Vector3())
    const maxXZ = Math.max(size.x, size.z) || 1
    const s = 2.4 / maxXZ
    scene.scale.setScalar(s)
    scene.position.set(-center.x * s, -center.y * s, -center.z * s)
    body.value = scene
  })
})

const bodyYaw = computed(() => MODEL_BASE_YAW + ((props.bodyYawDeg ?? 0) * Math.PI) / 180)

const pulse = ref(0)
const spin = ref(0)
useRafFn(({ delta }) => {
  const dt = delta / 1000
  pulse.value = (pulse.value + dt * 1.8) % (Math.PI * 2)
  spin.value += dt * 12
})

function emissive(state: MotorVisual['state']): number {
  if (state === 'active')
    return 0.4 + 0.4 * (0.5 + 0.5 * Math.sin(pulse.value))
  return state === 'idle' ? 0 : 0.3
}

// Idle rings are faint so the active one stands out.
function ringOpacity(state: MotorVisual['state']): number {
  return state === 'idle' ? 0.16 : 0.95
}

function motorPos(angleDeg: number, y: number): [number, number, number] {
  const { x, y: sy } = motorTopdownXY(angleDeg)
  return [x * RING_R, y, sy * RING_R]
}

const rings = computed(() => props.motors.map(m => ({
  key: m.key,
  state: m.state,
  color: ringColor(m.state),
  active: m.state === 'active',
  ringPos: motorPos(m.angleDeg, RING_Y),
  propPos: motorPos(m.angleDeg, PROP_Y),
  // cw spins negative about Y viewed from above.
  propSpin: m.spin === 'cw' ? -spin.value : spin.value,
})))
</script>

<template>
  <TresCanvas clear-color="#00000000" :alpha="true">
    <!-- fov/position kept in sync with the label projection in
         motor-check/DesktopView.vue (MOTOR_CAM_*). -->
    <TresPerspectiveCamera :fov="50" :position="[0, 3.25, 1.05]" :look-at="[0, 0, 0]" />
    <TresAmbientLight :intensity="0.9" />
    <TresDirectionalLight :position="[2, 6, 3]" :intensity="1.1" />
    <TresDirectionalLight :position="[-2, 3, -2]" :intensity="0.4" />

    <!-- Vendored airframe body, oriented nose-away -->
    <TresGroup :rotation-y="bodyYaw">
      <primitive v-if="body" :object="body" />
    </TresGroup>

    <template v-for="r in rings" :key="r.key">
      <!-- Highlight ring -->
      <TresMesh :position="r.ringPos" :rotation="[-Math.PI / 2, 0, 0]">
        <TresTorusGeometry :args="[0.26, 0.045, 16, 40]" />
        <TresMeshStandardMaterial
          :color="r.color"
          :emissive="r.color"
          :emissive-intensity="emissive(r.state)"
          :metalness="0.2"
          :roughness="0.5"
          :transparent="true"
          :opacity="ringOpacity(r.state)"
        />
      </TresMesh>

      <!-- Spinning prop above the motor under test -->
      <TresGroup v-if="r.active" :position="r.propPos" :rotation-y="r.propSpin">
        <TresMesh>
          <TresBoxGeometry :args="[0.52, 0.012, 0.08]" />
          <TresMeshStandardMaterial :color="r.color" :emissive="r.color" :emissive-intensity="0.5" />
        </TresMesh>
        <TresMesh :rotation-y="Math.PI / 2">
          <TresBoxGeometry :args="[0.52, 0.012, 0.08]" />
          <TresMeshStandardMaterial :color="r.color" :emissive="r.color" :emissive-intensity="0.5" />
        </TresMesh>
      </TresGroup>
    </template>
  </TresCanvas>
</template>
