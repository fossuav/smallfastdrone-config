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

// The drone from above: hub, one arm per motor at its true airframe
// angle, nose pointing up. The motor under test is lit and carries a
// curved arrow showing which way it is turning; in review each motor is
// green or red by result.
//
// This replaced a three.js scene (a vendored quad-X mesh, a procedural
// hub-and-arms model for every other frame, a spinning prop, and HTML
// labels positioned by projecting world coordinates through a camera
// whose parameters had to be kept in sync by hand). The schematic says
// the same things and says them better on a bench: it is unambiguous
// from any angle, it is frame-agnostic by construction rather than by a
// second code path, and the labels sit in the drawing rather than being
// projected onto it. Simpler was also more accurate. ArduConfigurator's
// motor map is the reference for the idiom; the flat frame thumbnails
// in the frame-select wizard are where it already lived here.
//
// Colour carries state and nothing else, so a motor's meaning survives
// a theme change - every colour comes from a semantic token via
// currentColor.

import type { Spin } from '../../workflow/motor-geometry'
import { computed } from 'vue'
import { motorTopdownXY } from '../../workflow/motor-geometry'
import { outwardDeg, spinArcPath, spinArcTip } from './spin-arc'

export interface MotorVisual {
  // Stable key (the motor's test order).
  key: number
  // Airframe angle, firmware convention (0 = forward, +cw from above).
  angleDeg: number
  // The way this motor is turning, as the operator has it.
  spin: Spin
  // What the drawing should say about this motor.
  state: 'idle' | 'active' | 'done' | 'mismatch'
  // Operator-facing position ("Front left"), drawn under the motor.
  label: string
  // Motor number as the operator counts them, drawn inside the ring.
  number: number
}

const props = defineProps<{ motors: MotorVisual[] }>()

// Drawing constants, in viewBox units. The box is wider than the frame
// so a label under the rearmost motor and an arc over the foremost both
// stay inside it.
const ARM = 74
const RING = 15
const ARC = RING + 10

// State is the only thing colour says. Idle is the frame's own muted
// tone so the live motor is the one thing that stands out.
const STATE_CLASS = {
  idle: 'text-muted',
  active: 'text-warning',
  done: 'text-success',
  mismatch: 'text-error',
} as const

const nodes = computed(() => props.motors.map((m) => {
  const { x, y } = motorTopdownXY(m.angleDeg)
  const cx = x * ARM
  const cy = y * ARM
  return {
    key: m.key,
    label: m.label,
    number: m.number,
    cx,
    cy,
    active: m.state === 'active',
    stateClass: STATE_CLASS[m.state],
    arc: spinArcPath(cx, cy, ARC, m.spin, outwardDeg(cx, cy)),
    tip: spinArcTip(cx, cy, ARC, m.spin, outwardDeg(cx, cy)),
    // The label goes below the motor, except for a motor at the very
    // bottom of the frame, where below is off the edge.
    labelY: cy > ARM * 0.8 ? cy - RING - 12 : cy + RING + 16,
  }
}))

// Just clear of the frontmost motor, whichever that is. Pinned to the
// top of the box instead, it read as a stray triangle rather than the
// nose of this drone - and on a Plus frame, where a motor points
// straight forward, the gap would have been twice as large again.
const noseY = computed(() => {
  const top = Math.min(...nodes.value.map(n => n.cy), 0)
  return top - RING - 14
})
</script>

<template>
  <svg
    viewBox="-118 -118 236 236"
    class="text-muted h-full w-full"
    role="img"
    aria-label="Your drone seen from above, with each motor in its place"
  >
    <!-- Nose, so there is never a question which way is forward. -->
    <polygon
      :points="`0,${noseY - 13} -7,${noseY} 7,${noseY}`"
      class="fill-primary"
    />

    <!-- Frame: arms out to each motor, then the hub over them. One
         opacity on the group, so the overlap at the hub doesn't stack
         into a darker cross than the arms it is made of. -->
    <g opacity="0.4">
      <line
        v-for="n in nodes"
        :key="`arm-${n.key}`"
        :x1="0"
        :y1="0"
        :x2="n.cx"
        :y2="n.cy"
        stroke="currentColor"
        stroke-width="7"
        stroke-linecap="round"
      />
      <rect x="-16" y="-16" width="32" height="32" rx="5" fill="currentColor" />
    </g>

    <g v-for="n in nodes" :key="n.key" :class="n.stateClass">
      <!-- A filled disc only under the live motor, so it reads first. -->
      <circle v-if="n.active" :cx="n.cx" :cy="n.cy" :r="RING" fill="currentColor" opacity="0.18" />
      <circle
        :cx="n.cx"
        :cy="n.cy"
        :r="RING"
        fill="none"
        stroke="currentColor"
        :stroke-width="n.active ? 3.5 : 2.5"
      />
      <text
        :x="n.cx"
        :y="n.cy"
        text-anchor="middle"
        dominant-baseline="central"
        fill="currentColor"
        class="text-[15px] font-semibold"
      >
        {{ n.number }}
      </text>

      <!-- Which way it is turning. Only for the live motor: on the
           others it would be four more arrows saying nothing new. -->
      <template v-if="n.active">
        <path
          :d="n.arc"
          fill="none"
          stroke="currentColor"
          stroke-width="3"
          stroke-linecap="round"
          stroke-dasharray="9 7"
          class="motor-map__spin"
        />
        <polygon
          points="0,-5 9,0 0,5"
          fill="currentColor"
          :transform="`translate(${n.tip.x} ${n.tip.y}) rotate(${n.tip.angleDeg})`"
        />
      </template>

      <text
        :x="n.cx"
        :y="n.labelY"
        text-anchor="middle"
        dominant-baseline="central"
        fill="currentColor"
        class="text-[11px] font-medium"
      >
        {{ n.label }}
      </text>
    </g>
  </svg>
</template>

<style scoped>
/*
  The dashes travel along the arc, which is drawn in the direction of
  travel - so the motion and the arrowhead always agree, without the
  component having to know which way round it is.
*/
.motor-map__spin {
  animation: motor-map-spin 0.9s linear infinite;
}

@keyframes motor-map-spin {
  to {
    stroke-dashoffset: -16;
  }
}

@media (prefers-reduced-motion: reduce) {
  .motor-map__spin {
    animation: none;
  }
}
</style>
