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

// Where the operator is in an irreversible process, and which step is the
// one they cannot come back from.
//
// This is the wizard's visual, and it earns that by being the thing an
// operator most needs on screen: a five-minute sequence that wipes their
// drone in the middle is frightening in proportion to how little you can
// see of it. The destructive step is marked before it runs, not after.

import type { RecoverPhase } from '../../workflow/sfd-recover'
import { computed } from 'vue'

const props = defineProps<{
  phase: RecoverPhase | 'idle'
  // Set once something irreversible has happened, so a stopped run can
  // show the operator that the drone is mid-way rather than untouched.
  destructive?: boolean
  failed?: boolean
}>()

// The order the silicon forces. `wipes` marks where the drone is erased.
const STEPS: Array<{ phases: RecoverPhase[], label: string, icon: string, wipes?: boolean }> = [
  { phases: ['backing-up', 'awaiting-save'], label: 'Save your settings', icon: 'i-lucide-save' },
  { phases: ['awaiting-dfu'], label: 'Put the drone in update mode', icon: 'i-lucide-usb' },
  { phases: ['unlocking'], label: 'Wipe the drone', icon: 'i-lucide-eraser', wipes: true },
  { phases: ['flashing'], label: 'Install fresh software', icon: 'i-lucide-download' },
  { phases: ['reconnecting', 'restoring'], label: 'Put your settings back', icon: 'i-lucide-rotate-ccw' },
]

const activeIndex = computed(() => {
  if (props.phase === 'idle')
    return -1
  if (props.phase === 'done')
    return STEPS.length
  return STEPS.findIndex(s => s.phases.includes(props.phase as RecoverPhase))
})

function state(i: number): 'done' | 'current' | 'pending' {
  if (activeIndex.value > i)
    return 'done'
  return activeIndex.value === i ? 'current' : 'pending'
}
</script>

<template>
  <ol class="space-y-2">
    <li
      v-for="(step, i) in STEPS"
      :key="step.label"
      class="flex items-center gap-3"
    >
      <span
        class="flex size-7 shrink-0 items-center justify-center rounded-full border"
        :class="{
          'border-primary bg-primary/10 text-primary': state(i) === 'current' && !props.failed,
          'border-error bg-error/10 text-error': state(i) === 'current' && props.failed,
          'border-success bg-success/10 text-success': state(i) === 'done',
          'border-default text-muted': state(i) === 'pending',
        }"
      >
        <UIcon
          :name="state(i) === 'done' ? 'i-lucide-check' : step.icon"
          class="size-4"
          :class="state(i) === 'current' && !props.failed ? 'animate-pulse' : ''"
        />
      </span>
      <div class="min-w-0">
        <p
          class="text-sm"
          :class="state(i) === 'pending' ? 'text-muted' : 'text-default font-medium'"
        >
          {{ step.label }}
        </p>
        <p v-if="step.wipes" class="text-xs" :class="props.destructive ? 'text-error' : 'text-muted'">
          {{ props.destructive
            ? 'This has happened — your drone needs the rest finishing.'
            : 'Everything on the drone is erased here. There is no going back past this.' }}
        </p>
      </div>
    </li>
  </ol>
</template>
