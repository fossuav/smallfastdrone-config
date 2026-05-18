<script setup lang="ts">
import { TresCanvas } from '@tresjs/core'
import { useRafFn } from '@vueuse/core'
import { ref } from 'vue'

// First hero visual — a slowly rotating X-quad built from primitives, in
// the FOSS UAV palette. Replaces the static logo on the Connect splash;
// gives an "alive" feel while we wait for the operator to plug in / SITL
// to wake up. Real per-vehicle frame models come in later slices.

const ARM_END = 0.35 // half-diagonal length where motors sit
const Y_PROP = 0.05 // prop disc height above motor

const motorPositions: [number, number, number][] = [
  [ARM_END, 0.02, ARM_END],
  [ARM_END, 0.02, -ARM_END],
  [-ARM_END, 0.02, ARM_END],
  [-ARM_END, 0.02, -ARM_END],
]
const propPositions: [number, number, number][] = motorPositions.map(
  ([x, _y, z]) => [x, Y_PROP, z],
)

const rotationY = ref(0)
// useRafFn delta is in ms; ~0.4 rad/s = gentle, not dizzying.
useRafFn(({ delta }) => {
  rotationY.value += (delta / 1000) * 0.4
})
</script>

<template>
  <TresCanvas clear-color="#00000000" :alpha="true">
    <TresPerspectiveCamera :position="[1.4, 1.0, 1.4]" :look-at="[0, 0, 0]" />
    <TresAmbientLight :intensity="0.6" />
    <TresDirectionalLight :position="[3, 5, 2]" :intensity="0.9" />

    <TresGroup :rotation-y="rotationY">
      <!-- Centre body -->
      <TresMesh>
        <TresBoxGeometry :args="[0.28, 0.08, 0.28]" />
        <TresMeshStandardMaterial color="#4A1E80" :metalness="0.3" :roughness="0.45" />
      </TresMesh>

      <!-- X-frame arms: two thin crossed bars rotated 45° from world axes -->
      <TresMesh :rotation="[0, 0.7853981633974483, 0]">
        <TresBoxGeometry :args="[1.0, 0.04, 0.04]" />
        <TresMeshStandardMaterial color="#4A1E80" :metalness="0.3" :roughness="0.5" />
      </TresMesh>
      <TresMesh :rotation="[0, -0.7853981633974483, 0]">
        <TresBoxGeometry :args="[1.0, 0.04, 0.04]" />
        <TresMeshStandardMaterial color="#4A1E80" :metalness="0.3" :roughness="0.5" />
      </TresMesh>

      <!-- Motors (gold cylinders) at the four corners -->
      <TresMesh
        v-for="(p, i) in motorPositions"
        :key="`m-${i}`"
        :position="p"
      >
        <TresCylinderGeometry :args="[0.08, 0.08, 0.05, 24]" />
        <TresMeshStandardMaterial color="#C9A35F" :metalness="0.75" :roughness="0.25" />
      </TresMesh>

      <!-- Translucent props above motors -->
      <TresMesh
        v-for="(p, i) in propPositions"
        :key="`p-${i}`"
        :position="p"
      >
        <TresCylinderGeometry :args="[0.19, 0.19, 0.005, 32]" />
        <TresMeshStandardMaterial
          color="#C9A35F"
          :metalness="0.1"
          :roughness="0.7"
          :transparent="true"
          :opacity="0.55"
        />
      </TresMesh>
    </TresGroup>
  </TresCanvas>
</template>
