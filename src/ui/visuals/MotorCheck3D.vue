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

// Hero visual for the motor-check wizard — a near-top-down drone built
// from Tres primitives, with one motor highlighted at a time. Frame-
// agnostic: it draws an arm + motor + prop for each entry in `motors`,
// rotated to the motor's airframe angle (nose points to the top of the
// canvas). The active motor's prop spins in its expected direction and
// glows; identified motors go green, mismatches red.
//
// Purely presentational — it owns no flow state and emits nothing. The
// clickable "which motor spun?" targets are accessible HTML hotspots in
// the wizard view, layered over this canvas, so the interaction works
// for keyboard + screen-reader users and is E2E-testable (a WebGL mesh
// is neither).

import type { Spin } from '../../workflow/motor-geometry'
import { TresCanvas } from '@tresjs/core'
import { useRafFn } from '@vueuse/core'
import { computed, ref } from 'vue'

export interface MotorVisual {
  // Stable key (the motor's test order).
  key: number
  // Airframe angle, firmware convention (0 = forward, +cw from above).
  angleDeg: number
  // Expected prop spin — drives the active-motor animation direction.
  spin: Spin
  // Drives colour + glow.
  state: 'idle' | 'active' | 'done' | 'mismatch'
}

const props = defineProps<{ motors: MotorVisual[] }>()

const ARM_R = 0.72 // radius from centre to each motor
const PROP_Y = 0.07

// FOSS palette + state colours.
const COLOR = {
  frame: '#4A1E80',
  motorIdle: '#C9A35F',
  active: '#f59e0b',
  done: '#22c55e',
  mismatch: '#ef4444',
} as const

function motorColor(state: MotorVisual['state']): string {
  switch (state) {
    case 'active': return COLOR.active
    case 'done': return COLOR.done
    case 'mismatch': return COLOR.mismatch
    default: return COLOR.motorIdle
  }
}

// rotation-y that maps the local -Z axis (canvas "up"/forward) onto the
// motor's airframe angle. Derived so angle 0 sits at top, +cw to the
// right (see motor-geometry angle convention).
function armRotationY(angleDeg: number): number {
  return -(angleDeg * Math.PI) / 180
}

// Animation clocks: a 0..1 pulse for the active glow, and a spin angle
// for the active prop. Both advance off RAF delta.
const pulse = ref(0)
const spin = ref(0)
useRafFn(({ delta }) => {
  const dt = delta / 1000
  pulse.value = (pulse.value + dt * 1.6) % (Math.PI * 2)
  spin.value += dt * 14 // fast enough to read as "spinning"
})

// Emissive intensity for a motor — the active one breathes, the rest are flat.
function emissive(state: MotorVisual['state']): number {
  if (state === 'active')
    return 0.35 + 0.35 * (0.5 + 0.5 * Math.sin(pulse.value))
  return state === 'idle' ? 0 : 0.25
}

// Prop spin for a motor: only the active one turns, in its expected
// direction (cw = negative rotation-y viewed from above).
function propSpin(m: MotorVisual): number {
  if (m.state !== 'active')
    return 0
  return m.spin === 'cw' ? -spin.value : spin.value
}

// Per-motor render data, memoised off the prop list.
const rendered = computed(() => props.motors.map(m => ({
  ...m,
  rotY: armRotationY(m.angleDeg),
  color: motorColor(m.state),
})))
</script>

<template>
  <TresCanvas clear-color="#00000000" :alpha="true">
    <TresPerspectiveCamera :position="[0, 2.4, 0.85]" :look-at="[0, 0, 0]" />
    <TresAmbientLight :intensity="0.7" />
    <TresDirectionalLight :position="[2, 5, 2]" :intensity="0.9" />

    <!-- Centre body -->
    <TresMesh>
      <TresBoxGeometry :args="[0.34, 0.1, 0.34]" />
      <TresMeshStandardMaterial :color="COLOR.frame" :metalness="0.3" :roughness="0.45" />
    </TresMesh>

    <!-- Forward marker: a small nose wedge at the front so the operator
         can orient the model against their real drone. -->
    <TresMesh :position="[0, 0.06, -0.26]" :rotation="[Math.PI / 2, 0, 0]">
      <TresConeGeometry :args="[0.07, 0.16, 3]" />
      <TresMeshStandardMaterial :color="COLOR.frame" :metalness="0.2" :roughness="0.6" />
    </TresMesh>

    <!-- One arm + motor + prop per motor, rotated to its airframe angle -->
    <TresGroup
      v-for="m in rendered"
      :key="m.key"
      :rotation-y="m.rotY"
    >
      <!-- Arm from centre out to the motor (extends along -Z) -->
      <TresMesh :position="[0, 0, -ARM_R / 2]">
        <TresBoxGeometry :args="[0.05, 0.04, ARM_R]" />
        <TresMeshStandardMaterial :color="COLOR.frame" :metalness="0.3" :roughness="0.5" />
      </TresMesh>

      <!-- Motor -->
      <TresMesh :position="[0, 0.02, -ARM_R]">
        <TresCylinderGeometry :args="[0.09, 0.09, 0.06, 24]" />
        <TresMeshStandardMaterial
          :color="m.color"
          :metalness="0.7"
          :roughness="0.3"
          :emissive="m.color"
          :emissive-intensity="emissive(m.state)"
        />
      </TresMesh>

      <!-- Prop disc (spins when active) -->
      <TresMesh :position="[0, PROP_Y, -ARM_R]" :rotation-y="propSpin(m)">
        <TresBoxGeometry :args="[0.42, 0.006, 0.05]" />
        <TresMeshStandardMaterial
          :color="m.color"
          :metalness="0.1"
          :roughness="0.7"
          :transparent="true"
          :opacity="m.state === 'active' ? 0.85 : 0.5"
        />
      </TresMesh>
    </TresGroup>
  </TresCanvas>
</template>
