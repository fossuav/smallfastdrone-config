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

// Horizontal tab ribbon for a wizard's areas — the interactive sibling of
// WizardSteps. Where the rail passively shows position within one wizard,
// the ribbon is clickable navigation across a journey's areas, each with a
// done-state (gold tick) and an active underline. The owning view supplies
// the tabs + binds the selection via v-model and renders the selected
// area's config + content beneath. Same tint idiom as WizardSteps /
// SystemStatus so it needs no contrasting-foreground token.

export interface RibbonTab {
  id: string
  label: string
  // Completed on this drone — shows a gold tick instead of a number.
  done: boolean
}

const props = defineProps<{
  tabs: RibbonTab[]
  modelValue: string
}>()
const emit = defineEmits<{ 'update:modelValue': [string] }>()

function select(id: string) {
  emit('update:modelValue', id)
}

function markClass(t: RibbonTab): string {
  if (t.done)
    return 'border-secondary/40 bg-secondary/10 text-secondary'
  return t.id === props.modelValue ? 'border-primary text-primary' : 'border-default text-muted'
}
</script>

<template>
  <div role="tablist" class="border-default flex items-stretch gap-1 overflow-x-auto border-b">
    <button
      v-for="(t, i) in tabs"
      :key="t.id"
      type="button"
      role="tab"
      :aria-selected="t.id === modelValue"
      class="-mb-px flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm whitespace-nowrap transition-colors"
      :class="t.id === modelValue
        ? 'border-primary text-highlighted font-medium'
        : 'border-transparent text-muted hover:text-default'"
      @click="select(t.id)"
    >
      <span
        class="flex size-5 shrink-0 items-center justify-center rounded-full border text-xs"
        :class="markClass(t)"
      >
        <UIcon v-if="t.done" name="i-lucide-check" class="size-3" />
        <template v-else>{{ i + 1 }}</template>
      </span>
      {{ t.label }}
    </button>
  </div>
</template>
