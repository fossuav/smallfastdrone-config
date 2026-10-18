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

// Props-on motor probe. Checks the drone can run the test, walks the
// operator through a props-on safety gate, runs the applet, and shows what
// each motor measured against where the frame expects it - on the motor
// map while it runs, and as a table at the end. Expert-only: a measuring
// instrument for settling the thresholds on the bench (PLAN decision 48).
// It changes no setting the drone keeps.

import type { MotorVisual } from '../../ui/visuals/MotorMap.vue'
import type { ProbeReading } from '../../workflow/motor-probe'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useParamsStore } from '../../stores/params'
import MotorMap from '../../ui/visuals/MotorMap.vue'
import { useLuaEngine } from '../../workflow/lua-engine'
import { frameGeometry, positionLabel, spinLabel } from '../../workflow/motor-geometry'
import { readProbe, stageLabel, storageProblemText, suggestSpin } from '../../workflow/motor-probe'
import { useMotorProbe } from '../../workflow/use-motor-probe'
import appletSource from './applet.lua?raw'

const params = useParamsStore()
const lua = useLuaEngine()
const router = useRouter()
const route = useRoute()
const {
  phase,
  error,
  stage,
  motorCount,
  currentMotor,
  throttle,
  tiltDeg,
  abortText,
  results,
  start,
  stop,
  cleanup,
} = useMotorProbe(appletSource)

// Back path: the catalogue by default.
const returnTo = computed(() => String(route.query.returnTo ?? '/recipes'))

// Whether this drone can run the test at all, before anything spins.
type Readiness = 'checking' | 'no-scripting' | 'scripting-off' | 'enabling' | 'no-storage' | 'ready'
const readiness = ref<Readiness>('checking')
const storageText = ref<string | null>(null)
// The operator has done everything on the safety list.
const confirmed = ref(false)

// Work out whether the test can run: scripts available and on, and
// somewhere to put the applet.
async function checkReady() {
  readiness.value = 'checking'
  const scripting = await lua.checkScripting()
  if (!scripting.available) {
    readiness.value = 'no-scripting'
    return
  }
  if (!scripting.enabled) {
    readiness.value = 'scripting-off'
    return
  }
  storageText.value = storageProblemText(await lua.checkScriptStorage())
  readiness.value = storageText.value ? 'no-storage' : 'ready'
}

// Turn scripts on (a restart and an automatic reconnect), then look again.
async function turnOnScripting() {
  readiness.value = 'enabling'
  await lua.enableScripting()
  await checkReady()
}

onMounted(async () => {
  if (!params.loadedAt)
    await params.load()
  await checkReady()
})

// Unmounting can't wait, but the applet stops itself without us anyway.
onBeforeUnmount(() => {
  void cleanup()
})

// The frame the drone believes it has, to read the results against.
const geo = computed(() => {
  const cls = params.effectiveValue('FRAME_CLASS')
  const typ = params.effectiveValue('FRAME_TYPE')
  return cls !== undefined && typ !== undefined ? frameGeometry(Math.trunc(cls), Math.trunc(typ)) : null
})

const readings = computed<ProbeReading[]>(() =>
  geo.value ? results.value.map(r => readProbe(geo.value!, r)) : [],
)

const running = computed(() => phase.value === 'running' || phase.value === 'installing')
const hasResults = computed(() => results.value.length > 0)

// The motor map: the motor being tested lit, each measured one green if
// it lifted where expected and turns the expected way, red if not.
const motors = computed<MotorVisual[]>(() => (geo.value?.motors ?? []).map((m) => {
  const reading = readings.value.find(r => r.result.testOrder === m.testOrder)
  let state: MotorVisual['state'] = 'idle'
  if (phase.value === 'running' && currentMotor.value === m.testOrder)
    state = 'active'
  else if (reading)
    state = reading.placeOk && reading.spinOk !== false ? 'done' : 'mismatch'
  return {
    key: m.testOrder,
    angleDeg: m.angleDeg,
    spin: reading?.spin ?? m.spin,
    state,
    label: positionLabel(m.position),
    number: m.motorIndex + 1,
  }
}))

// A throttle fraction as the percentage an operator reads.
function pct(f: number): string {
  return `${Math.round(f * 100)}%`
}

// One results row, in words.
function row(r: ProbeReading) {
  const lifted = r.result.lift !== null
  return {
    key: r.result.testOrder,
    motor: r.expected ? `Motor ${r.expected.motorIndex + 1}` : `Test ${r.result.testOrder}`,
    expectedAt: r.expected ? positionLabel(r.expected.position) : '—',
    lift: lifted ? pct(r.result.lift!) : 'Didn\'t lift',
    found: r.found ? positionLabel(r.found.position) : '—',
    placeOk: r.placeOk,
    spin: r.spin ? spinLabel(r.spin) : lifted ? 'Too small to tell' : '—',
    spinOk: r.spinOk,
    start: r.result.start !== null ? pct(r.result.start) : '—',
    rpm: r.result.rpm !== null ? Math.round(r.result.rpm).toLocaleString() : '—',
    output: r.result.output ?? '—',
  }
}
const rows = computed(() => readings.value.map(row))

// What the starts suggest for the drone's idle settings (shown only).
const spinSuggestion = computed(() => suggestSpin(results.value))

// Any motor whose corner never lifted - the case worth saying in words.
const anyNoLift = computed(() => results.value.some(r => r.lift === null))

// Finished with the test: take the applet back off the drone and leave.
async function done() {
  await cleanup()
  router.push(returnTo.value)
}
</script>

<template>
  <div class="space-y-4">
    <!-- The drone from above: always in view, because where each motor
         is and how it measured is the whole point. -->
    <div v-if="geo" class="border-default mx-auto aspect-square w-full max-w-72 rounded-md border bg-elevated/50 p-2">
      <MotorMap :motors="motors" />
    </div>
    <UAlert
      v-else
      color="warning"
      variant="subtle"
      icon="i-lucide-shapes"
      title="This frame can't be drawn"
      description="The test still runs; the results below show which way the drone tipped, in degrees from the nose."
    />

    <!-- Before the run. -->
    <template v-if="phase === 'idle' && !hasResults">
      <p class="text-muted">
        With its props on, the drone spins each motor in short bursts and feels which way it tips.
        That tells it where each motor is, which way it turns, and whether its prop is lifting.
        This is a measuring tool for now: it changes none of the drone's settings.
      </p>

      <p v-if="readiness === 'checking'" class="text-muted flex items-center gap-2 text-sm">
        <UIcon name="i-lucide-loader-circle" class="size-4 animate-spin" />
        Checking the drone can run the test…
      </p>
      <UAlert
        v-else-if="readiness === 'no-scripting'"
        color="error"
        variant="subtle"
        icon="i-lucide-circle-x"
        title="This drone can't run the test"
        description="Its firmware can't run scripts, and the test runs as a script on the drone."
      />
      <UAlert
        v-else-if="readiness === 'scripting-off' || readiness === 'enabling'"
        color="info"
        variant="subtle"
        icon="i-lucide-scroll-text"
        title="Scripts are off on this drone"
        description="The test runs as a script on the drone. Turning scripts on restarts the drone (a few seconds); we'll reconnect automatically."
      >
        <template #actions>
          <UButton :loading="readiness === 'enabling'" @click="turnOnScripting">
            {{ readiness === 'enabling' ? 'Restarting your drone…' : 'Turn on scripts' }}
          </UButton>
        </template>
      </UAlert>
      <UAlert
        v-else-if="readiness === 'no-storage'"
        color="warning"
        variant="subtle"
        icon="i-lucide-hard-drive"
        title="Nowhere to put the test"
        :description="storageText ?? ''"
      >
        <template #actions>
          <UButton color="neutral" variant="outline" @click="checkReady">
            Check again
          </UButton>
        </template>
      </UAlert>

      <div v-else class="border-default space-y-3 rounded-md border p-4">
        <p class="text-highlighted font-medium">
          Before you start
        </p>
        <ul class="text-muted space-y-1.5 text-sm">
          <li class="flex gap-2">
            <UIcon name="i-lucide-fan" class="mt-0.5 size-4 shrink-0" />Props on, and tight
          </li>
          <li class="flex gap-2">
            <UIcon name="i-lucide-battery-full" class="mt-0.5 size-4 shrink-0" />Flight battery plugged in
          </li>
          <li class="flex gap-2">
            <UIcon name="i-lucide-move-down" class="mt-0.5 size-4 shrink-0" />Flat on the floor, resting on its arms — not on a battery hanging underneath
          </li>
          <li class="flex gap-2">
            <UIcon name="i-lucide-navigation" class="mt-0.5 size-4 shrink-0" />Nose pointing away from you
          </li>
          <li class="flex gap-2">
            <UIcon name="i-lucide-users" class="mt-0.5 size-4 shrink-0" />Everyone at least two metres back
          </li>
        </ul>
        <div class="flex items-center gap-3 pt-1">
          <USwitch v-model="confirmed" color="error" aria-label="Ready, the motors will spin with props on" />
          <span class="text-sm">I've done all of this. The motors will spin with the props on.</span>
        </div>
        <p class="text-muted text-xs">
          The drone stops on its own if it tips too far, if it moves while a motor should only be idling, or if it loses this computer.
        </p>
      </div>
    </template>

    <!-- While it runs: what the drone is doing, and a stop that is always there. -->
    <div v-if="running" class="space-y-3">
      <p class="text-highlighted flex items-center gap-2 font-medium">
        <UIcon name="i-lucide-loader-circle" class="size-4 animate-spin" />
        <template v-if="phase === 'installing'">
          Putting the test on the drone…
        </template>
        <template v-else-if="motorCount > 0 && currentMotor > 0">
          Motor {{ currentMotor }} of {{ motorCount }}: {{ stageLabel(stage) }}
        </template>
        <template v-else>
          {{ stageLabel(stage) }}
        </template>
      </p>
      <div class="space-y-1">
        <div class="text-muted flex justify-between text-xs">
          <span>Motor power</span><span>{{ pct(throttle) }}</span>
        </div>
        <UProgress :model-value="Math.round(throttle * 100)" :max="100" color="warning" size="sm" />
        <p class="text-muted text-xs">
          Tipped {{ tiltDeg.toFixed(1) }}°
        </p>
      </div>
      <UButton color="error" size="lg" block icon="i-lucide-octagon-x" @click="stop">
        Stop now
      </UButton>
    </div>

    <UAlert
      v-if="phase === 'stopped'"
      color="warning"
      variant="subtle"
      icon="i-lucide-octagon-alert"
      title="The test stopped"
      :description="abortText ?? 'You stopped it.'"
    />
    <UAlert
      v-if="error"
      color="error"
      variant="subtle"
      icon="i-lucide-circle-x"
      :description="error"
    />

    <!-- What each motor measured. -->
    <div v-if="hasResults && !running" class="space-y-3">
      <div class="border-default overflow-x-auto rounded-md border">
        <table class="w-full text-sm">
          <thead class="text-muted bg-elevated/50 text-left text-xs">
            <tr>
              <th class="px-3 py-2 font-medium">
                Motor
              </th>
              <th class="px-3 py-2 font-medium">
                Lifted at
              </th>
              <th class="px-3 py-2 font-medium">
                Side that lifted
              </th>
              <th class="px-3 py-2 font-medium">
                Turns
              </th>
              <th class="px-3 py-2 font-medium">
                Starts at
              </th>
              <th class="px-3 py-2 font-medium">
                Top speed
              </th>
              <th class="px-3 py-2 font-medium">
                Output
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in rows" :key="r.key" class="border-default border-t">
              <td class="px-3 py-2">
                <span class="text-highlighted font-medium">{{ r.motor }}</span>
                <span class="text-muted block text-xs">{{ r.expectedAt }}</span>
              </td>
              <td class="px-3 py-2">
                {{ r.lift }}
              </td>
              <td class="px-3 py-2">
                <span class="inline-flex items-center gap-1">
                  {{ r.found }}
                  <UIcon v-if="r.placeOk === true" name="i-lucide-check" class="text-success size-4" aria-label="where expected" />
                  <UIcon v-else-if="r.placeOk === false" name="i-lucide-x" class="text-error size-4" aria-label="not where expected" />
                </span>
              </td>
              <td class="px-3 py-2">
                <span class="inline-flex items-center gap-1">
                  {{ r.spin }}
                  <UIcon v-if="r.spinOk === true" name="i-lucide-check" class="text-success size-4" aria-label="the expected way" />
                  <UIcon v-else-if="r.spinOk === false" name="i-lucide-x" class="text-error size-4" aria-label="not the expected way" />
                </span>
              </td>
              <td class="px-3 py-2">
                {{ r.start }}
              </td>
              <td class="px-3 py-2">
                {{ r.rpm }}
              </td>
              <td class="px-3 py-2">
                {{ r.output }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-if="anyNoLift" class="text-muted text-sm">
        A motor that didn't lift its corner may have a prop pushing down instead of up (the wrong prop for that motor, or one on upside down), or the test may have stopped short of the power it needed.
      </p>
      <p v-if="spinSuggestion" class="text-muted text-sm">
        The motors start turning by {{ pct(spinSuggestion.slowest) }}, which suggests idling at {{ pct(spinSuggestion.arm) }} when armed and never dropping below {{ pct(spinSuggestion.min) }} in flight.
      </p>
    </div>

    <div v-if="!running" class="flex justify-end gap-2 pt-2">
      <UButton color="neutral" variant="ghost" @click="done">
        Done
      </UButton>
      <UButton
        v-if="readiness === 'ready'"
        color="error"
        :disabled="!confirmed"
        @click="start"
      >
        {{ hasResults || phase === 'stopped' ? 'Run again' : 'Start' }}
      </UButton>
    </div>
  </div>
</template>
