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

// Wizard phase progress rail — the "where am I in this flow" indicator
// docs/UX.md asks every multi-phase wizard to carry. A horizontal row of
// numbered steps: completed steps go green with a tick (matching the "Done"
// badges across the app), the current step is primary, upcoming steps muted. Labels
// hide on narrow screens, leaving the numbered dots. Purely presentational
// — the owning wizard maps its internal phase to a step index and passes
// it in, so this component knows nothing about any particular wizard.

import { computed } from 'vue'

const props = defineProps<{
  // Step labels in order. Operator-facing — no parameter names / jargon.
  steps: string[]
  // 0-based index of the active step. Steps before it read as done.
  current: number
}>()

type State = 'done' | 'active' | 'upcoming'

function stateOf(i: number): State {
  if (i < props.current)
    return 'done'
  if (i === props.current)
    return 'active'
  return 'upcoming'
}

// Tint idiom matches SystemStatus.vue (text-x + bg-x/10) so we never depend
// on a contrasting-foreground token. Verbose switch so Tailwind's scan
// picks up every class.
function circleClass(i: number): string {
  switch (stateOf(i)) {
    case 'done': return 'border-success/50 bg-success/15 text-success'
    case 'active': return 'border-primary bg-primary/10 text-primary'
    default: return 'border-default text-muted'
  }
}

function labelClass(i: number): string {
  return stateOf(i) === 'active' ? 'text-highlighted font-medium' : 'text-muted'
}

// Connector to the right of a step: green once that step is done.
function lineClass(i: number): string {
  return i < props.current ? 'bg-success/40' : 'bg-muted'
}

const lastIndex = computed(() => props.steps.length - 1)
</script>

<template>
  <ol class="flex items-center gap-1 sm:gap-2" aria-label="Progress through this wizard">
    <li
      v-for="(label, i) in steps"
      :key="i"
      class="flex items-center gap-1 sm:gap-2"
      :class="i < lastIndex ? 'flex-1' : ''"
    >
      <div class="flex items-center gap-1.5" :aria-current="i === current ? 'step' : undefined">
        <span
          class="flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-medium transition-colors"
          :class="circleClass(i)"
        >
          <UIcon v-if="i < current" name="i-lucide-check" class="size-3.5" />
          <template v-else>{{ i + 1 }}</template>
        </span>
        <span class="hidden text-xs sm:inline" :class="labelClass(i)">{{ label }}</span>
      </div>
      <span v-if="i < lastIndex" class="h-px min-w-2 flex-1 rounded" :class="lineClass(i)" />
    </li>
  </ol>
</template>
