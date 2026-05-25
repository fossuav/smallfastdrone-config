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

// Inline ESC quick-controls for the bringup ribbon's Motors config panel.
// Output protocol + RPM telemetry are simple, reversible settings a confident
// operator already understands, so they're edited in place rather than behind
// the wizard — using the Drone Settings reboot-pattern: change it, and (since
// both are reboot-required) the tool writes, restarts, and auto-reconnects
// with no further clicks. The motor order/direction CHECK stays a guided
// procedure (the wizard); only the settings live here. Pure ESC logic is in
// workflow/esc-setup.ts, shared with the wizard's ESC-setup phase.

import { computed, ref } from 'vue'
import { useParamsStore } from '../../stores/params'
import { useSessionStore } from '../../stores/session'
import {
  BIDIR_MASK_PARAM,
  ESC_PROTOCOLS,
  escParamEdits,
  isDshot,
  MOT_PWM_TYPE_PARAM,
} from '../../workflow/esc-setup'
import { collectMotorChannels, servoFunctionParam } from '../../workflow/motor-check'
import { sleep, STORAGE_SETTLE_MS, useReconnect } from '../../workflow/reconnect'

const session = useSessionStore()
const params = useParamsStore()
const { autoReconnect } = useReconnect()

type Phase = 'idle' | 'applying' | 'restarting' | 'error'
const phase = ref<Phase>('idle')
const errorMessage = ref<string | null>(null)

function val(name: string): number | undefined {
  return params.effectiveValue(name)
}

const protocol = computed(() => {
  const v = val(MOT_PWM_TYPE_PARAM)
  return v === undefined ? undefined : Math.trunc(v)
})
const bidirSupported = computed(() => params.params.has(BIDIR_MASK_PARAM))
const rpmOn = computed(() => Math.trunc(val(BIDIR_MASK_PARAM) ?? 0) > 0)
// RPM telemetry only applies to DShot on a BLHeli build.
const rpmApplicable = computed(() => bidirSupported.value && protocol.value !== undefined && isDshot(protocol.value))
const busy = computed(() => phase.value === 'applying' || phase.value === 'restarting')

// The motor output channels, from the live SERVOn_FUNCTION assignments.
function motorChannels(): number[] {
  return [...collectMotorChannels(ch => val(servoFunctionParam(ch))).keys()]
}

// Apply an ESC config change in place: write only what differs, reboot
// (both settings are reboot-required), auto-reconnect, reload. Mirrors the
// wizard's applyConfig but without the wizard framing.
async function apply(cfg: { protocol: number, bidir: boolean }) {
  const edits = escParamEdits(cfg, motorChannels(), val, bidirSupported.value)
  if (edits.length === 0)
    return
  phase.value = 'applying'
  errorMessage.value = null
  params.discardAll()
  for (const e of edits)
    params.setEdit(e.name, e.value)
  await params.apply()
  if (params.lastApplyFailed > 0) {
    params.discardAll()
    phase.value = 'error'
    errorMessage.value = 'Couldn\'t save the change — check the connection and try again.'
    return
  }
  phase.value = 'restarting'
  await sleep(STORAGE_SETTLE_MS)
  await session.reboot()
  const back = await autoReconnect()
  if (!back) {
    phase.value = 'error'
    errorMessage.value = 'Your drone restarted but we couldn\'t reconnect. Make sure it\'s powered, then reload.'
    return
  }
  params.clear()
  await params.load()
  phase.value = 'idle'
}

function setProtocol(p: number) {
  if (p !== protocol.value)
    void apply({ protocol: p, bidir: rpmOn.value })
}
function toggleRpm(on: boolean) {
  if (protocol.value !== undefined)
    void apply({ protocol: protocol.value, bidir: on })
}
</script>

<template>
  <div class="space-y-3">
    <!-- Output protocol -->
    <div class="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <span class="text-muted w-28 shrink-0 text-sm">Output protocol</span>
      <div class="flex flex-wrap gap-1.5">
        <UButton
          v-for="p in ESC_PROTOCOLS"
          :key="p.value"
          :color="protocol === p.value ? 'primary' : 'neutral'"
          :variant="protocol === p.value ? 'solid' : 'outline'"
          size="xs"
          :disabled="busy"
          @click="setProtocol(p.value)"
        >
          {{ p.label }}
        </UButton>
      </div>
    </div>

    <!-- RPM telemetry -->
    <div class="flex items-center gap-x-3">
      <span class="text-muted w-28 shrink-0 text-sm">RPM telemetry</span>
      <USwitch
        :model-value="rpmOn"
        :disabled="busy || !rpmApplicable"
        color="primary"
        aria-label="RPM telemetry"
        @update:model-value="toggleRpm"
      />
      <span v-if="!rpmApplicable" class="text-muted text-xs">
        {{ bidirSupported ? 'DShot only' : 'Not available on this firmware build' }}
      </span>
    </div>

    <!-- Reboot feedback -->
    <p v-if="busy" class="text-muted flex items-center gap-2 text-xs">
      <UIcon name="i-lucide-loader-circle" class="size-3.5 animate-spin" />
      {{ phase === 'restarting' ? 'Restarting your drone — reconnecting automatically…' : 'Saving…' }}
    </p>
    <p v-else-if="phase === 'error'" class="text-warning text-xs">
      {{ errorMessage }}
    </p>
  </div>
</template>
