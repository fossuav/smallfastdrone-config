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

// Desktop view for the IMU noise check wizard. Walks the operator
// from "is scripting on?" through "press start → upload applet →
// arm via control param → watch NAMED_VALUE_FLOAT progress + result
// → cleanup" and renders a verdict ("Quiet" / "Normal" /
// "Noticeable" / "High") with the raw rad/s value.
//
// All FC interaction goes through useLuaEngine() — see
// docs/WIZARDS.md "Lua engine" and src/workflow/lua-engine.ts.

import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useSessionStore } from '../../stores/session'
import { useWizardProgressStore } from '../../stores/wizardProgress'
import { useLuaEngine } from '../../workflow/lua-engine'
// Vite handles ?raw imports as inline UTF-8 strings — bundles the Lua
// source into the JS bundle so we can ship it via FTP at runtime.
import APPLET_SOURCE from './applet.lua?raw'

const WIZARD_ID = 'imu-noise'
const CONTROL_PARAM = 'WIZ_NOISE_ACTIVE'
const PROGRESS_NVF = 'wn_prog'
const RESULT_NVF = 'wn_max'

const session = useSessionStore()
const wizardProgress = useWizardProgressStore()
const lua = useLuaEngine()
const router = useRouter()
const route = useRoute()

// Bringup meta passes returnTo=/wizard/bringup; standalone runs default
// to the wizard library.
const returnTo = computed(() => String(route.query.returnTo ?? '/wizard'))

type Phase = 'checking' | 'scripting-off' | 'ready' | 'preparing' | 'sampling' | 'done' | 'error'
const phase = ref<Phase>('checking')
const errorMessage = ref<string | null>(null)
const progress = ref(0)
const result = ref<number | null>(null)

let unsubProgress: (() => void) | null = null
let unsubResult: (() => void) | null = null

// rad/s thresholds calibrated against typical multicopter behaviour:
// SITL with no vibration reports ~1e-4; a clean real-world hover sits
// well under 0.01; vibrating airframes climb past 0.05 quickly.
function verdict(maxRads: number): { label: string, tone: 'success' | 'info' | 'warning' | 'error' } {
  if (maxRads < 0.01)
    return { label: `Quiet (${maxRads.toFixed(4)} rad/s) — looks great.`, tone: 'success' }
  if (maxRads < 0.05)
    return { label: `Normal (${maxRads.toFixed(3)} rad/s).`, tone: 'info' }
  if (maxRads < 0.15)
    return { label: `Noticeable (${maxRads.toFixed(3)} rad/s) — check mounting / props.`, tone: 'warning' }
  return { label: `High (${maxRads.toFixed(3)} rad/s) — investigate isolation before flying.`, tone: 'error' }
}

// Check scripting capability + advance to the start-affordance state.
// Surfaces scripting-off as its own state so the operator gets an
// actionable explanation rather than a generic error.
async function checkAndPrepare() {
  phase.value = 'checking'
  errorMessage.value = null
  try {
    const status = await lua.checkScripting()
    if (!status.available) {
      phase.value = 'scripting-off'
      errorMessage.value = 'This drone\'s firmware doesn\'t expose ArduPilot scripting — the wizard needs a build with SCR_ENABLE compiled in.'
      return
    }
    if (!status.enabled) {
      phase.value = 'scripting-off'
      errorMessage.value = null
      return
    }
    phase.value = 'ready'
  }
  catch (e) {
    phase.value = 'error'
    errorMessage.value = e instanceof Error ? e.message : String(e)
  }
}

onMounted(() => {
  if (!session.connected || session.sysid === null) {
    phase.value = 'error'
    errorMessage.value = 'Please connect to your drone first, then come back.'
    return
  }
  checkAndPrepare()
})

// Best-effort cleanup if the operator navigates away mid-sample. The
// applet self-disables when ACTIVE goes back to 0 but won't see that
// unless we write it.
onUnmounted(() => {
  unsubProgress?.()
  unsubResult?.()
  if (phase.value === 'sampling' || phase.value === 'preparing') {
    lua.setParam(CONTROL_PARAM, 0).catch(() => {})
  }
})

// The big "Start" action. Uploads the applet (overwriting any prior
// copy), subscribes to progress + result, then flips ACTIVE=1. The
// applet does the actual sampling; we just listen.
async function start() {
  phase.value = 'preparing'
  errorMessage.value = null
  progress.value = 0
  result.value = null
  try {
    await lua.uploadApplet(WIZARD_ID, APPLET_SOURCE)

    // Subscribe before flipping ACTIVE so we don't miss the first
    // progress emit.
    unsubProgress = lua.subscribeNamedValue(PROGRESS_NVF, (value) => {
      progress.value = Math.max(0, Math.min(100, value))
    })
    unsubResult = lua.subscribeNamedValue(RESULT_NVF, (value) => {
      result.value = value
      complete()
    })

    const ack = await lua.setParam(CONTROL_PARAM, 1)
    if (!ack.acked) {
      throw new Error('Drone didn\'t acknowledge the control parameter — the wizard applet probably isn\'t loaded. Try rebooting your drone and starting again.')
    }
    phase.value = 'sampling'
  }
  catch (e) {
    phase.value = 'error'
    errorMessage.value = e instanceof Error ? e.message : String(e)
    teardown()
  }
}

// Result NVF arrived → settle, record completion, transition to done.
async function complete() {
  teardown()
  // Defensive: applet self-disables but a packet could be in flight.
  await lua.setParam(CONTROL_PARAM, 0).catch(() => {})
  // Remove the applet file. The script stays loaded in FC memory
  // until the next reboot — this just keeps the scripts/ directory
  // clean. Errors swallowed because the file may already be gone
  // (E2E pre-place scenario, prior abort, etc).
  await lua.removeApplet(WIZARD_ID).catch(() => {})

  if (result.value !== null) {
    wizardProgress.markComplete(
      session.fcUid,
      WIZARD_ID,
      verdict(result.value).label,
    )
  }
  phase.value = 'done'
}

function teardown() {
  unsubProgress?.()
  unsubResult?.()
  unsubProgress = null
  unsubResult = null
}

async function cancel() {
  teardown()
  await lua.setParam(CONTROL_PARAM, 0).catch(() => {})
  router.push(returnTo.value)
}

function back() {
  router.push(returnTo.value)
}

async function retry() {
  await checkAndPrepare()
}
</script>

<template>
  <div class="space-y-4">
    <div v-if="phase === 'checking'" class="py-8 text-center text-muted">
      <UIcon name="i-lucide-loader-circle" class="size-6 animate-spin" />
      <p class="mt-2 text-sm">
        Checking your drone's scripting…
      </p>
    </div>

    <div v-else-if="phase === 'scripting-off'" class="space-y-3">
      <UAlert color="warning" :title="errorMessage ? 'Scripting unavailable' : 'Scripting isn\'t enabled'">
        <template #description>
          <template v-if="errorMessage">
            {{ errorMessage }}
          </template>
          <template v-else>
            This wizard needs ArduPilot scripting enabled on your drone.
            Open <em>Expert mode → Parameters</em>, set <code>SCR_ENABLE</code>
            to 1, reboot your drone, then come back.
          </template>
        </template>
      </UAlert>
      <div class="flex justify-end">
        <UButton color="neutral" variant="outline" @click="back">
          Back to library
        </UButton>
      </div>
    </div>

    <div v-else-if="phase === 'ready'" class="space-y-4">
      <p class="text-muted">
        Place your drone on a flat surface and keep it perfectly still.
        We'll sample the gyros for a few seconds and tell you how noisy
        the readings are — a basic vibration check.
      </p>
      <div class="flex justify-center py-4">
        <UIcon name="i-lucide-orbit" class="text-muted size-16 opacity-40" />
      </div>
      <div class="flex justify-end gap-2">
        <UButton color="neutral" variant="ghost" @click="back">
          Cancel
        </UButton>
        <UButton color="primary" @click="start">
          Start sampling
        </UButton>
      </div>
    </div>

    <div v-else-if="phase === 'preparing'" class="py-8 text-center">
      <UIcon name="i-lucide-loader-circle" class="text-primary size-6 animate-spin" />
      <p class="text-default mt-2 text-sm">
        Setting your drone up to sample…
      </p>
    </div>

    <div v-else-if="phase === 'sampling'" class="space-y-3">
      <p class="text-default text-center">
        Sampling — keep the drone perfectly still.
      </p>
      <UProgress :value="progress" />
      <p class="text-muted text-center text-xs">
        {{ progress }}%
      </p>
      <div class="flex justify-center pt-2">
        <UButton color="neutral" variant="ghost" size="sm" @click="cancel">
          Cancel
        </UButton>
      </div>
    </div>

    <div v-else-if="phase === 'done'" class="space-y-3 py-6 text-center">
      <UIcon name="i-lucide-circle-check" class="text-success mx-auto size-10" />
      <h2 class="text-highlighted text-lg font-semibold">
        Sample complete
      </h2>
      <p v-if="result !== null" class="text-default">
        {{ verdict(result).label }}
      </p>
      <p v-else class="text-warning text-sm">
        No reading captured — try running it again.
      </p>
      <UButton color="primary" @click="back">
        Back to library
      </UButton>
    </div>

    <div v-else-if="phase === 'error'" class="space-y-3 py-6 text-center">
      <UIcon name="i-lucide-circle-alert" class="text-error mx-auto size-10" />
      <h2 class="text-highlighted text-lg font-semibold">
        Couldn't finish the sample
      </h2>
      <p class="text-muted text-sm">
        {{ errorMessage }}
      </p>
      <div class="flex justify-center gap-2">
        <UButton color="primary" variant="outline" @click="retry">
          Retry
        </UButton>
        <UButton color="neutral" @click="back">
          Back to library
        </UButton>
      </div>
    </div>
  </div>
</template>
