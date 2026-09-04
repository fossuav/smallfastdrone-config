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

// ESC-setup phase of the "Set up motors" wizard — the step before the
// motor order/direction check. Opinionated: for SmallFastDrone we want
// DShot600 with RPM telemetry (bidirectional DShot), so the default path is
// a single "set it up" click; an expert disclosure lets the operator pick
// another protocol or turn telemetry off.
//
// ESC config params are reboot-required, so applying writes them, restarts
// the drone, and auto-reconnects (shared useReconnect), then emits `done`
// to advance to the check. If the FC is already configured as we'd
// recommend, Continue just advances with no write/reboot.
//
// Pure protocol/edit logic is in src/workflow/esc-setup.ts.

import type { EscConfig } from '../../workflow/esc-setup'
import { computed, onMounted, ref } from 'vue'
import { useParamsStore } from '../../stores/params'
import { useSessionStore } from '../../stores/session'
import {
  BIDIR_MASK_PARAM,
  ESC_PROTOCOLS,

  escParamEdits,
  isDshot,
  isRecommendedConfig,
  MOT_PWM_TYPE_PARAM,
  protocolLabel,
  RECOMMENDED_PROTOCOL,
} from '../../workflow/esc-setup'
import { collectMotorChannels, servoFunctionParam } from '../../workflow/motor-check'
import { sleep, STORAGE_SETTLE_MS, useReconnect } from '../../workflow/reconnect'

const emit = defineEmits<{ done: [] }>()

const session = useSessionStore()
const params = useParamsStore()
const { reconnectAndReload } = useReconnect()

type Phase = 'checking' | 'idle' | 'applying' | 'restarting' | 'reconnect-failed' | 'error'
const phase = ref<Phase>('checking')
const errorMessage = ref<string | null>(null)
const expert = ref(false)

// The operator's chosen config (form model). Seeded from the FC on mount.
const config = ref<EscConfig>({ protocol: RECOMMENDED_PROTOCOL, bidir: true })

// Does the FC expose the BLHeli bidirectional-DShot param? (BLHeli builds
// only — absent on a plain SITL/firmware without serial RCOut.)
const bidirSupported = computed(() => params.params.has(BIDIR_MASK_PARAM))

function currentValue(name: string): number | undefined {
  const p = params.params.get(name)
  return p ? p.value : undefined
}

const currentProtocol = computed(() => {
  const v = currentValue(MOT_PWM_TYPE_PARAM)
  return v === undefined ? undefined : Math.trunc(v)
})

// FC already set up the way we'd recommend (DShot + telemetry where supported).
const alreadyGood = computed(() =>
  isRecommendedConfig(currentValue(MOT_PWM_TYPE_PARAM), currentValue(BIDIR_MASK_PARAM), bidirSupported.value),
)

// Bidir only applies to DShot; reflect that in the form.
const bidirApplicable = computed(() => isDshot(config.value.protocol) && bidirSupported.value)

onMounted(() => {
  if (params.count === 0) {
    // The parent loads params before mounting us; if somehow empty, bail to
    // the check rather than block.
    emit('done')
    return
  }
  // Seed the form: keep a sensible current DShot setup, else recommend.
  const cur = currentProtocol.value
  config.value = cur !== undefined && isDshot(cur)
    ? { protocol: cur, bidir: Math.trunc(currentValue(BIDIR_MASK_PARAM) ?? 0) > 0 }
    : { protocol: RECOMMENDED_PROTOCOL, bidir: true }
  phase.value = 'idle'
})

// Motor output channels, from the live SERVOn_FUNCTION assignments.
function motorChannels(): number[] {
  return [...collectMotorChannels(channel => currentValue(servoFunctionParam(channel))).keys()]
}

// Apply the given config: write only what differs, reboot if anything
// changed, reconnect, reload params, then advance. No changes → just advance.
async function applyConfig(cfg: EscConfig) {
  const edits = escParamEdits(cfg, motorChannels(), currentValue, bidirSupported.value)
  if (edits.length === 0) {
    emit('done')
    return
  }
  phase.value = 'applying'
  errorMessage.value = null
  params.discardAll()
  for (const e of edits)
    params.setEdit(e.name, e.value)
  await params.apply()
  if (params.lastApplyFailed > 0) {
    params.discardAll()
    phase.value = 'idle'
    errorMessage.value = 'We couldn\'t save the ESC settings to your drone. Check the connection and try again.'
    return
  }
  phase.value = 'restarting'
  await sleep(STORAGE_SETTLE_MS)
  await session.reboot()
  await reconnect()
}

async function reconnect() {
  phase.value = 'restarting'
  const outcome = await reconnectAndReload()
  if (outcome !== 'ok') {
    phase.value = 'reconnect-failed'
    errorMessage.value = outcome === 'no-drone'
      ? 'Your drone restarted but we couldn\'t reconnect. Make sure it\'s powered, then try again.'
      : 'Your drone restarted but we couldn\'t read its settings back. Make sure it\'s powered, then try again.'
    return
  }
  emit('done')
}

function retryReconnect() {
  void reconnect()
}

// "Set up DShot600 + telemetry" — the recommended one-click path.
function applyRecommended() {
  void applyConfig({ protocol: RECOMMENDED_PROTOCOL, bidir: bidirSupported.value })
}
// Expert "Apply" — whatever's in the form.
function applyChosen() {
  void applyConfig({ ...config.value })
}
// Leave ESC config as-is and go straight to the check.
function skip() {
  emit('done')
}
</script>

<template>
  <div class="space-y-4">
    <div>
      <h2 class="text-highlighted text-lg font-semibold">
        Set up your ESCs
      </h2>
      <p class="text-muted text-sm">
        How the flight controller talks to your motors. We'll get this right
        before checking motor direction — it's what lets us fix a backwards
        motor in software.
      </p>
    </div>

    <!-- checking -->
    <div v-if="phase === 'checking'" class="text-muted flex items-center gap-2 py-4 text-sm">
      <UIcon name="i-lucide-loader-circle" class="size-4 animate-spin" />
      Reading your ESC settings…
    </div>

    <!-- idle: recommend / already-good / expert -->
    <template v-else-if="phase === 'idle'">
      <UAlert
        v-if="alreadyGood && !expert"
        color="success"
        icon="i-lucide-circle-check"
        title="Your ESCs are set up well"
        :description="`${protocolLabel(currentProtocol ?? RECOMMENDED_PROTOCOL)}${bidirSupported ? ' with RPM telemetry' : ''} — good to go.`"
      />
      <UAlert
        v-else-if="!expert"
        color="primary"
        icon="i-lucide-wand-2"
        title="We'll set your ESCs to DShot600"
        :description="bidirSupported
          ? 'DShot600 with RPM telemetry — the recommended setup for small fast drones. The RPM readings help smooth out vibration in flight. Your drone restarts briefly.'
          : 'DShot600 — the recommended setup for small fast drones. Your drone restarts briefly.'"
      />

      <!-- expert disclosure: pick protocol + telemetry -->
      <div v-if="expert" class="border-default space-y-3 rounded-lg border p-3">
        <div class="space-y-2">
          <div>
            <span class="text-default text-sm font-medium">Output protocol</span>
            <p class="text-muted text-xs">
              How throttle is sent to the ESCs. DShot is digital and recommended.
            </p>
          </div>
          <div class="flex flex-wrap gap-2">
            <UButton
              v-for="p in ESC_PROTOCOLS"
              :key="p.value"
              :color="config.protocol === p.value ? 'primary' : 'neutral'"
              :variant="config.protocol === p.value ? 'solid' : 'outline'"
              size="sm"
              @click="config.protocol = p.value"
            >
              {{ p.label }}
            </UButton>
          </div>
        </div>
        <div class="flex items-center justify-between gap-3">
          <div>
            <span class="text-default text-sm font-medium">RPM telemetry</span>
            <p class="text-muted text-xs">
              ESCs report motor RPM back — this helps the drone smooth out vibration in flight.
              {{ bidirSupported ? '' : 'Not available on this firmware build.' }}
            </p>
          </div>
          <USwitch v-model="config.bidir" color="primary" :disabled="!bidirApplicable" aria-label="RPM telemetry" />
        </div>
      </div>

      <UAlert v-if="errorMessage" color="warning" :description="errorMessage" />

      <div class="flex items-center justify-between gap-2">
        <UButton color="neutral" variant="ghost" size="sm" @click="expert = !expert">
          {{ expert ? 'Use the recommended setup' : 'Choose myself' }}
        </UButton>
        <div class="flex gap-2">
          <UButton v-if="alreadyGood || expert" color="neutral" variant="ghost" @click="skip">
            Leave as is
          </UButton>
          <UButton v-if="expert" color="primary" icon="i-lucide-arrow-right" @click="applyChosen">
            Apply &amp; continue
          </UButton>
          <UButton v-else-if="alreadyGood" color="primary" icon="i-lucide-arrow-right" @click="skip">
            Continue
          </UButton>
          <UButton v-else color="primary" icon="i-lucide-arrow-right" @click="applyRecommended">
            Set up &amp; continue
          </UButton>
        </div>
      </div>
    </template>

    <!-- applying -->
    <div v-else-if="phase === 'applying'" class="text-muted flex items-center gap-2 py-4 text-sm">
      <UIcon name="i-lucide-loader-circle" class="size-4 animate-spin" />
      Saving the ESC settings to your drone…
    </div>

    <!-- restarting -->
    <div v-else-if="phase === 'restarting'">
      <UAlert
        color="info"
        icon="i-lucide-loader-circle"
        title="Restarting your drone…"
        description="ESC changes need a restart. The connection drops for a few seconds — we'll reconnect automatically and move on to the motor check."
      />
    </div>

    <!-- reconnect-failed -->
    <div v-else-if="phase === 'reconnect-failed'" class="space-y-3">
      <UAlert color="warning" title="Couldn't reconnect automatically">
        <template #description>
          {{ errorMessage }}
        </template>
      </UAlert>
      <div class="flex justify-end">
        <UButton color="primary" @click="retryReconnect">
          Reconnect
        </UButton>
      </div>
    </div>

    <!-- error -->
    <div v-else class="space-y-3">
      <UAlert color="warning" :description="errorMessage ?? 'Something went wrong setting up the ESCs.'" />
      <div class="flex justify-end">
        <UButton color="neutral" @click="skip">
          Skip to motor check
        </UButton>
      </div>
    </div>
  </div>
</template>
