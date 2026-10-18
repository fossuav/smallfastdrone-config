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

// Port probe. Says which ports the drone will listen on and which it
// leaves alone, runs the two-restart flow, shows each port live while it
// listens, then what was found and what each port will become - and, once
// applied, whether the receiver and GPS ArduPilot now drives are working.
// Expert-only until proven on hardware (PLAN decision 49).

import type { PortOutcome, PortRole } from '../../workflow/port-probe'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useParamsStore } from '../../stores/params'
import { useSessionStore } from '../../stores/session'
import { findingLabel, portsToProbe } from '../../workflow/port-probe'
import { protocolLabel } from '../../workflow/serial-protocols'
import { readRoles, usePortProbe } from '../../workflow/use-port-probe'
import appletSource from './applet.lua?raw'

const params = useParamsStore()
const session = useSessionStore()
const router = useRouter()
const route = useRoute()
const { phase, error, probed, results, plan, applied, trying, start, finish, detach } = usePortProbe(appletSource)

// Back path: the catalogue by default.
const returnTo = computed(() => String(route.query.returnTo ?? '/recipes'))

onMounted(async () => {
  if (!params.loadedAt)
    await params.load()
})
// Leaving mid-run: the ports stay handed over, and the next visit offers
// to put them back.
onBeforeUnmount(detach)

// Scripts must exist in this firmware; the run turns them on if they're off.
const scriptingAvailable = computed(() => params.params.has('SCR_ENABLE'))

// What the drone says is working now.
function subsystem(key: 'rc' | 'gps') {
  return session.subsystems.find(s => s.key === key)?.state ?? 'off'
}

// The ports as they are now, and the ones a run would listen on.
const currentRoles = computed(() => readRoles(name => params.params.get(name)?.value))
const toProbe = computed(() => portsToProbe(currentRoles.value, {
  receiverWorking: subsystem('rc') === 'ok',
  gpsWorking: subsystem('gps') === 'ok',
}))
const leftAlone = computed(() => [...currentRoles.value.keys()].filter(n => !toProbe.value.includes(n)))

// A port's role in words.
function roleText(r: PortRole | undefined): string {
  if (!r || r.protocol <= 0)
    return 'No role'
  return protocolLabel(r.protocol)
}

const busy = computed(() => ['preparing', 'restarting', 'probing', 'applying'].includes(phase.value))
const statusLine = computed(() => {
  switch (phase.value) {
    case 'preparing': return 'Handing the ports over to the test…'
    case 'restarting': return 'Restarting your drone…'
    case 'probing': return 'Listening on each port…'
    case 'applying': return 'Saving each port\'s role…'
    default: return ''
  }
})

// One port's line while listening or once found.
function liveText(serial: number): string {
  const r = results.value.get(serial)
  if (r)
    return findingLabel(r.finding)
  const baud = trying(serial)
  return baud ? `Listening at ${baud.toLocaleString()}` : 'Waiting'
}

// Icon for what a port was found to have.
function findingIcon(serial: number): string {
  const r = results.value.get(serial)
  if (!r)
    return 'i-lucide-loader-circle'
  if (r.finding === 'crsf' || r.finding === 'ghost' || r.finding === 'ibus')
    return 'i-lucide-radio-receiver'
  if (r.finding === 'nmea' || r.finding === 'ubx')
    return 'i-lucide-satellite'
  if (r.finding === 'traffic')
    return 'i-lucide-activity'
  return 'i-lucide-circle-off'
}

// What applying will do to a port, in words.
function outcomeText(o: PortOutcome): string {
  if (o.kind === 'receiver')
    return 'Set up as your radio receiver'
  if (o.kind === 'gps')
    return `Set up as a GPS (${o.baud.toLocaleString()})`
  const back = `Put back: ${roleText(o.role).toLowerCase()}`
  if (o.why === 'second-receiver')
    return `${back} — you already have a receiver set up`
  if (o.why === 'third-gps')
    return `${back} — two GPS are already set up`
  return back
}

const found = computed(() => plan.value.filter(o => o.kind !== 'restore'))

// After applying: are the devices ArduPilot now drives working?
const receiverSet = computed(() => applied.value.some(o => o.kind === 'receiver'))
const gpsSet = computed(() => applied.value.some(o => o.kind === 'gps'))

// Start a run on the ports listed.
const starting = ref(false)
async function run() {
  starting.value = true
  await start(toProbe.value)
  starting.value = false
}

// Finished: leave.
function done() {
  router.push(returnTo.value)
}
</script>

<template>
  <div class="space-y-4">
    <!-- A run that didn't finish left ports handed over: offer to undo it. -->
    <UAlert
      v-if="phase === 'interrupted'"
      color="warning"
      variant="subtle"
      icon="i-lucide-undo-2"
      title="A previous run didn't finish"
      description="Some of this drone's connections are still handed over to the test. Put them back before doing anything else — the drone restarts once."
    >
      <template #actions>
        <UButton color="warning" @click="finish(false)">
          Put the connections back
        </UButton>
      </template>
    </UAlert>

    <!-- Before a run. -->
    <template v-if="phase === 'idle'">
      <p class="text-muted">
        The drone listens on its own connections and works out what's plugged into each one — a radio receiver or a GPS, for now — so it can set each one up without asking you.
      </p>
      <UAlert
        v-if="!scriptingAvailable"
        color="error"
        variant="subtle"
        icon="i-lucide-circle-x"
        title="This drone can't run the test"
        description="Its firmware can't run scripts, and the listening runs as a script on the drone."
      />
      <template v-else>
        <div class="border-default space-y-3 rounded-md border p-4">
          <p class="text-highlighted font-medium">
            Before you start
          </p>
          <ul class="text-muted space-y-1.5 text-sm">
            <li class="flex gap-2">
              <UIcon name="i-lucide-radio" class="mt-0.5 size-4 shrink-0" />Switch on your transmitter — a receiver with no link stays silent
            </li>
            <li class="flex gap-2">
              <UIcon name="i-lucide-battery-full" class="mt-0.5 size-4 shrink-0" />Plug in the flight battery, so everything on the drone has power
            </li>
            <li class="flex gap-2">
              <UIcon name="i-lucide-rotate-cw" class="mt-0.5 size-4 shrink-0" />The drone restarts twice: once to listen, once to set the connections up
            </li>
          </ul>
        </div>

        <div class="border-default rounded-md border">
          <div v-for="n in toProbe" :key="n" class="border-default flex items-center justify-between gap-3 border-b px-4 py-2 text-sm last:border-b-0">
            <span class="inline-flex items-center gap-2">
              <UIcon name="i-lucide-ear" class="text-primary size-4" />
              <span class="text-highlighted font-medium">Port {{ n }}</span>
            </span>
            <span class="text-muted">Listen · now: {{ roleText(currentRoles.get(n)) }}</span>
          </div>
          <p v-if="toProbe.length === 0" class="text-muted px-4 py-3 text-sm">
            Every connection already has a working role, or one this test can't recognise yet.
          </p>
        </div>
        <p v-if="leftAlone.length > 0" class="text-muted text-xs">
          Left alone: {{ leftAlone.map(n => n === 0 ? 'USB' : `port ${n} (${roleText(currentRoles.get(n)).toLowerCase()})`).join(', ') }}.
        </p>
      </template>
    </template>

    <!-- While it works: each port, live. -->
    <template v-if="busy || phase === 'results'">
      <p v-if="busy" class="text-highlighted flex items-center gap-2 font-medium">
        <UIcon name="i-lucide-loader-circle" class="size-4 animate-spin" />
        {{ statusLine }}
      </p>
      <div class="border-default rounded-md border">
        <div v-for="n in probed" :key="n" class="border-default flex items-center justify-between gap-3 border-b px-4 py-2 text-sm last:border-b-0">
          <span class="inline-flex items-center gap-2">
            <UIcon
              :name="findingIcon(n)"
              class="size-4"
              :class="results.get(n) ? 'text-primary' : 'text-muted animate-spin'"
            />
            <span class="text-highlighted font-medium">Port {{ n }}</span>
          </span>
          <span class="text-right">
            <span class="block">{{ liveText(n) }}</span>
            <span v-if="phase === 'results'" class="text-muted block text-xs">
              {{ outcomeText(plan.find(o => o.serial === n)!) }}
            </span>
          </span>
        </div>
      </div>
      <p v-if="phase === 'results' && found.length === 0" class="text-muted text-sm">
        Nothing was recognised. Check the transmitter is on and bound, and the battery is in — then put the connections back and try again.
      </p>
    </template>

    <!-- After: what was set, and whether it's working now. -->
    <template v-if="phase === 'done'">
      <div class="border-default space-y-2 rounded-md border p-4">
        <p class="text-highlighted font-medium">
          Connections set up
        </p>
        <ul class="text-muted space-y-1 text-sm">
          <li v-for="o in applied" :key="o.serial" class="flex gap-2">
            <UIcon :name="o.kind === 'restore' ? 'i-lucide-undo-2' : 'i-lucide-check'" class="mt-0.5 size-4 shrink-0" :class="o.kind === 'restore' ? '' : 'text-success'" />
            Port {{ o.serial }}: {{ outcomeText(o) }}
          </li>
        </ul>
        <p v-if="receiverSet" class="flex items-center gap-2 text-sm">
          <UIcon :name="subsystem('rc') === 'ok' ? 'i-lucide-check' : 'i-lucide-loader-circle'" :class="subsystem('rc') === 'ok' ? 'text-success' : 'text-muted animate-spin'" class="size-4" />
          {{ subsystem('rc') === 'ok' ? 'Your receiver is sending' : 'Waiting to hear your receiver' }}
        </p>
        <p v-if="gpsSet" class="flex items-center gap-2 text-sm">
          <UIcon :name="subsystem('gps') === 'ok' ? 'i-lucide-check' : 'i-lucide-loader-circle'" :class="subsystem('gps') === 'ok' ? 'text-success' : 'text-muted animate-spin'" class="size-4" />
          {{ subsystem('gps') === 'ok' ? 'Your GPS is working' : 'Waiting for your GPS' }}
        </p>
      </div>
    </template>

    <UAlert v-if="error" color="error" variant="subtle" icon="i-lucide-circle-x" :description="error" />

    <div v-if="!busy" class="flex justify-end gap-2 pt-2">
      <UButton
        v-if="phase === 'results' || (phase === 'failed' && probed.length > 0)"
        color="neutral"
        variant="outline"
        @click="finish(false)"
      >
        Put everything back
      </UButton>
      <UButton v-if="phase === 'results' && found.length > 0" color="primary" @click="finish(true)">
        Set these up
      </UButton>
      <UButton v-if="phase === 'idle' || phase === 'done' || phase === 'failed'" color="neutral" variant="ghost" @click="done">
        Done
      </UButton>
      <UButton
        v-if="phase === 'idle' && scriptingAvailable"
        color="primary"
        :disabled="toProbe.length === 0"
        :loading="starting"
        @click="run"
      >
        Find what's plugged in
      </UButton>
    </div>
  </div>
</template>
