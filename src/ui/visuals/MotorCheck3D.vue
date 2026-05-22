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
// model (vendored, see src/assets/models/CREDITS.md) shown in a standard
// orientation: nose pointing AWAY from the operator, as if they're stood
// behind the drone. The model is a single mesh, so we can't recolour an
// individual motor; instead we overlay a glowing ring on each motor
// position and light up the one the wizard is talking about.
//
// Purely presentational — owns no flow state, emits nothing. Motor
// selection is done with labelled buttons in the wizard view (clearer +
// accessible + testable than clicking a WebGL mesh).

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
  // Expected prop spin (kept for parity with the procedural version; not
  // animated on the static GLTF body).
  spin: Spin
  // Drives the ring colour + glow.
  state: 'idle' | 'active' | 'done' | 'mismatch'
}

const props = defineProps<{
  motors: MotorVisual[]
  // Extra yaw (deg) applied to the body only — the vendored model is an
  // X-frame; a Plus frame rotates it 45° so its arms line up with the
  // cardinal motor rings.
  bodyYawDeg?: number
}>()

// Ring placement radius + height, tuned to the recentred/scaled model.
const RING_R = 1.05
const RING_Y = 0.12
// Native yaw correction to point the model's nose at -Z (away). Tuned
// against the vendored model's export orientation.
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

// Loaded + normalised model (recentred to origin, scaled to a known size).
const body = shallowRef<Object3D | null>(null)
onMounted(() => {
  const loader = new GLTFLoader()
  loader.load(modelUrl, (gltf) => {
    const scene = gltf.scene
    const box = new Box3().setFromObject(scene)
    const center = box.getCenter(new Vector3())
    const size = box.getSize(new Vector3())
    const maxXZ = Math.max(size.x, size.z) || 1
    const s = 2.4 / maxXZ // fit the footprint into ~2.4 units across
    scene.scale.setScalar(s)
    scene.position.set(-center.x * s, -center.y * s, -center.z * s)
    body.value = scene
  })
})

const bodyYaw = computed(() => MODEL_BASE_YAW + ((props.bodyYawDeg ?? 0) * Math.PI) / 180)

// Glow pulse for the active ring.
const pulse = ref(0)
useRafFn(({ delta }) => {
  pulse.value = (pulse.value + (delta / 1000) * 1.8) % (Math.PI * 2)
})

function emissive(state: MotorVisual['state']): number {
  if (state === 'active')
    return 0.4 + 0.4 * (0.5 + 0.5 * Math.sin(pulse.value))
  return state === 'idle' ? 0.05 : 0.35
}

// Per-ring render data (world position from airframe angle).
const rings = computed(() => props.motors.map((m) => {
  const { x, y } = motorTopdownXY(m.angleDeg)
  return {
    key: m.key,
    state: m.state,
    color: ringColor(m.state),
    // motorTopdownXY: y is screen-down; map to world +Z (toward camera) so
    // angle 0 (front) lands at -Z (away). x → world X.
    pos: [x * RING_R, RING_Y, y * RING_R] as [number, number, number],
  }
}))
</script>

<template>
  <TresCanvas clear-color="#00000000" :alpha="true">
    <TresPerspectiveCamera :position="[0, 2.1, 2.5]" :look-at="[0, 0, 0]" />
    <TresAmbientLight :intensity="0.85" />
    <TresDirectionalLight :position="[2, 5, 3]" :intensity="1.1" />
    <TresDirectionalLight :position="[-2, 3, -2]" :intensity="0.4" />

    <!-- Vendored airframe body, oriented nose-away -->
    <TresGroup :rotation-y="bodyYaw">
      <primitive v-if="body" :object="body" />
    </TresGroup>

    <!-- Highlight rings, one per motor position -->
    <TresMesh
      v-for="r in rings"
      :key="r.key"
      :position="r.pos"
      :rotation="[-Math.PI / 2, 0, 0]"
    >
      <TresTorusGeometry :args="[0.26, 0.05, 16, 40]" />
      <TresMeshStandardMaterial
        :color="r.color"
        :emissive="r.color"
        :emissive-intensity="emissive(r.state)"
        :metalness="0.2"
        :roughness="0.5"
        :transparent="true"
        :opacity="r.state === 'idle' ? 0.5 : 0.95"
      />
    </TresMesh>
  </TresCanvas>
</template>
