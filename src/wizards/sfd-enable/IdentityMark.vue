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

// A drone's identity drawn as a small grid, plus its short fingerprint.
// The operator's use for it is comparison: does the file I saved belong to
// the drone in front of me? Two drones look obviously different; one drone
// looks identical every time. See src/workflow/identity-mark.ts.
//
// `pending` draws the same grid greyed and empty, so the shape of what is
// coming is on screen before the drone has been asked - the placeholder is
// the real thing, unfilled, rather than a spinner that tells you nothing.

import { computed } from 'vue'
import {
  identityFingerprint,
  identityMarkCells,
  MARK_COLUMNS,
  MARK_ROWS,
} from '../../workflow/identity-mark'

const props = withDefaults(defineProps<{
  publicKey?: Uint8Array | null
  pending?: boolean
}>(), { publicKey: null, pending: false })

const CELL = 14
const GAP = 3

const cells = computed(() => (props.publicKey ? identityMarkCells(props.publicKey) : []))
const fingerprint = computed(() => (props.publicKey ? identityFingerprint(props.publicKey) : ''))
const slots = computed(() => Array.from({ length: MARK_COLUMNS * MARK_ROWS }, (_, i) => i))

function x(i: number): number {
  return (i % MARK_COLUMNS) * (CELL + GAP)
}
function y(i: number): number {
  return Math.floor(i / MARK_COLUMNS) * (CELL + GAP)
}
</script>

<template>
  <figure class="flex flex-col items-center gap-2">
    <svg
      :width="MARK_COLUMNS * (CELL + GAP) - GAP"
      :height="MARK_ROWS * (CELL + GAP) - GAP"
      role="img"
      :aria-label="fingerprint ? `Identity mark, fingerprint ${fingerprint}` : 'Identity not yet created'"
    >
      <rect
        v-for="i in slots"
        :key="i"
        :x="x(i)"
        :y="y(i)"
        :width="CELL"
        :height="CELL"
        rx="3"
        :fill="cells[i] ? (cells[i]!.solid ? `hsl(${cells[i]!.hue} 62% 55%)` : 'transparent') : 'transparent'"
        :stroke="cells[i] ? `hsl(${cells[i]!.hue} 62% 55%)` : 'currentColor'"
        :stroke-width="cells[i] ? 2 : 1"
        :class="cells[i] ? '' : 'text-muted/40'"
      />
    </svg>
    <figcaption v-if="fingerprint" class="text-muted font-mono text-xs tracking-wide">
      {{ fingerprint }}
    </figcaption>
    <figcaption v-else-if="props.pending" class="text-muted text-xs">
      Your drone hasn't made its identity yet.
    </figcaption>
  </figure>
</template>
