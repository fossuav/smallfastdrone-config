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

// Per-wizard "On the radio" toggle — lives in the wizard runner's header so
// flipping a wizard onto / off the radio is right there with the wizard, no
// detour to the Field tools page for the common case. State + install/remove
// ride the shared useFieldToolsStore, so this toggle, the catalogue, the
// library card, and the header badge all stay in sync. Field tools (the
// page) remains the central home for the full catalogue, paid Pro entries,
// custom applets, and scripting management.

import type { FieldTool } from '../../workflow/field-tools'
import { computed } from 'vue'
import { useFieldToolsStore } from '../../stores/fieldTools'
import { useSessionStore } from '../../stores/session'
import { installableTools } from '../../workflow/field-tools'

const props = defineProps<{
  // The wizard id; we look up the matching field tool in the catalogue.
  wizardId: string
}>()

const session = useSessionStore()
const field = useFieldToolsStore()

// Resolve the wizard to its catalogue entry. If there isn't one (a wizard
// that declared field_capable but has no installable applet — shouldn't
// happen with the built-in registry, but be defensive), render nothing.
const tool = computed<FieldTool | undefined>(() =>
  installableTools().find(t => t.id === props.wizardId),
)
const isOn = computed(() => field.isInstalled(props.wizardId))
const busy = computed(() => field.busy === props.wizardId)

// Why the toggle is unactionable, in operator terms. Null when usable.
const disabledReason = computed<string | null>(() => {
  if (!session.connected || !session.hasHeartbeat)
    return 'Connect your drone first'
  if (field.scripting === 'unavailable')
    return 'Your drone\'s firmware doesn\'t support scripting'
  if (field.scripting === 'off')
    return 'Turn on scripting in Field tools first'
  return null
})

function onToggle(val: boolean | undefined) {
  if (!tool.value || busy.value)
    return
  if (val)
    void field.install(tool.value)
  else
    void field.remove(tool.value)
}
</script>

<template>
  <UTooltip v-if="tool" :text="disabledReason ?? ''" :disabled="!disabledReason">
    <div class="flex items-center gap-2" :class="{ 'opacity-60': !!disabledReason }">
      <UIcon name="i-lucide-radio" class="text-info size-4" />
      <span class="text-default text-sm">On the radio</span>
      <USwitch
        :model-value="isOn"
        :loading="busy"
        :disabled="!!disabledReason || busy"
        color="info"
        size="sm"
        aria-label="On the radio"
        @update:model-value="onToggle"
      />
    </div>
  </UTooltip>
</template>
