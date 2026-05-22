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

// Drone settings — operator-facing feature toggles that map to FC
// parameters. v1 ships one toggle (Lua scripting) so the orchestration
// pattern is exercised end-to-end before more toggles land. The
// hardcoded scripting card promotes into a registry-driven loop when a
// second toggle motivates the refactor.
//
// State machine per toggle:
//
//   checking      — params loading, can't show anything yet
//   unavailable   — not connected OR param missing on this firmware
//   idle          — connected, no pending change, switch reflects FC
//   pending       — operator flipped the switch; not yet written
//   applying      — PARAM_SET in flight, waiting for echo
//   needs-reboot  — wrote OK; for reboot-required params the operator
//                   sees a Restart button instead of a "done" badge
//   rebooting     — Restart clicked; reboot command sent. Subdivides
//                   on session.connected (still up vs dropped) so the
//                   UI tells the operator to wait vs click Reconnect.
//   reconnecting  — operator clicked Reconnect; waiting for first
//                   post-reboot heartbeat
//
// Settles back to idle once the new value is confirmed by the
// post-reboot param re-fetch.

import type { ParamValue } from 'mavlink-mappings/dist/lib/common'
import { computed, onMounted, ref, watch } from 'vue'
import { buildParamSet, MSGID_PARAM_VALUE } from '../protocol/params'
import { useParamsStore } from '../stores/params'
import { useSessionStore } from '../stores/session'

// Hardcoded scripting toggle. When a second toggle lands this lifts
// into a FeatureToggle interface + a manifest registry; for one entry
// the inline shape is clearer.
const SCRIPTING_PARAM = 'SCR_ENABLE'
const MAV_PARAM_TYPE_INT8 = 2
const COMP_ID_AUTOPILOT = 1
const PARAM_ACK_TIMEOUT_MS = 1500

const session = useSessionStore()
const params = useParamsStore()

type Phase
  = | 'checking'
    | 'unavailable'
    | 'idle'
    | 'pending'
    | 'applying'
    | 'needs-reboot'
    | 'rebooting'
    | 'reconnecting'
const phase = ref<Phase>('checking')
const errorMessage = ref<string | null>(null)
const pendingValue = ref<number | null>(null)

// Latest FC-reported value of SCR_ENABLE — undefined until params load,
// null when the param doesn't exist on this firmware at all. Read fresh
// from the store on every access so a post-reboot re-load reflects.
const fcValue = computed<number | null>(() => {
  const p = params.params.get(SCRIPTING_PARAM)
  return p ? Math.trunc(p.value) : null
})
const isOn = computed(() => fcValue.value === 1)

// What the switch shows. While pending, displays the operator's
// chosen value; otherwise mirrors the FC.
const switchValue = computed({
  get: () => pendingValue.value !== null ? pendingValue.value === 1 : isOn.value,
  set: v => setPending(v),
})

const isBusy = computed(() =>
  phase.value === 'applying' || phase.value === 'rebooting' || phase.value === 'reconnecting',
)

// Mount logic: bail to unavailable if disconnected, otherwise load
// params and decide between idle (param present) and unavailable
// (vehicle doesn't expose SCR_ENABLE).
onMounted(async () => {
  if (!session.connected || session.sysid === null) {
    phase.value = 'unavailable'
    errorMessage.value = 'Connect to your drone first, then come back.'
    return
  }
  if (params.count === 0 && !params.loading)
    await params.load()
  else if (params.loading)
    await waitForLoadComplete()

  if (params.error) {
    phase.value = 'unavailable'
    errorMessage.value = `Couldn't load your drone's settings: ${params.error}`
    return
  }
  if (!params.params.has(SCRIPTING_PARAM)) {
    phase.value = 'unavailable'
    errorMessage.value = `This drone's firmware doesn't expose ${SCRIPTING_PARAM} — Lua scripting may not be compiled in for this build.`
    return
  }
  phase.value = 'idle'
})

// Wait until paramsStore.loading flips false — for the rare case the
// SettingsView mounts while another store consumer is mid-fetch.
function waitForLoadComplete(): Promise<void> {
  return new Promise((resolve) => {
    const stop = watch(() => params.loading, (loading) => {
      if (!loading) {
        stop()
        resolve()
      }
    })
  })
}

// Operator flipped the switch (or programmatic equivalent). Drop the
// pending state if the new choice matches the FC's current value —
// no point queuing a no-op write.
function setPending(on: boolean) {
  const wanted = on ? 1 : 0
  if (wanted === fcValue.value) {
    pendingValue.value = null
    phase.value = 'idle'
  }
  else {
    pendingValue.value = wanted
    phase.value = 'pending'
  }
}

// Operator clicked Apply. Send PARAM_SET, wait for the FC's
// PARAM_VALUE echo, transition based on success.
async function apply() {
  if (pendingValue.value === null || session.sysid === null)
    return
  phase.value = 'applying'
  errorMessage.value = null
  const target = pendingValue.value
  const ok = await writeParamWithEcho(SCRIPTING_PARAM, target, MAV_PARAM_TYPE_INT8)
  if (!ok) {
    phase.value = 'pending'
    errorMessage.value = 'The drone didn\'t acknowledge the change. Try again.'
    return
  }
  // ArduPilot's PARAM_SET handler auto-saves to EEPROM via a
  // batched timer tick; on SITL the write completes in milliseconds
  // but the OS file buffer doesn't sync until the FD closes. A reboot
  // immediately after PARAM_SET races the flush. Wait ~1.5s before
  // letting the operator hit Restart — empirically enough for SITL,
  // imperceptible on real hardware where the save is already done by
  // the time the operator reads the prompt.
  await new Promise(resolve => setTimeout(resolve, 1500))
  // Scripting changes require a reboot. Stay in needs-reboot until
  // the operator clicks Restart (or Cancel reverts).
  phase.value = 'needs-reboot'
}

// Send PARAM_SET + wait for the FC's PARAM_VALUE echo for that name.
// Returns true if the echoed value matches the requested value within
// float epsilon.
async function writeParamWithEcho(name: string, value: number, type: number): Promise<boolean> {
  if (session.sysid === null)
    return false
  const targetSys = session.sysid
  return new Promise<boolean>((resolve) => {
    let unsubscribe: (() => void) | null = null
    const timer = setTimeout(() => {
      unsubscribe?.()
      resolve(false)
    }, PARAM_ACK_TIMEOUT_MS)
    unsubscribe = session.subscribeMessages((msg) => {
      if (msg.msgid !== MSGID_PARAM_VALUE)
        return
      const pv = msg.data as ParamValue
      if (pv.paramId.replace(/\0.*$/, '') !== name)
        return
      clearTimeout(timer)
      unsubscribe?.()
      // Update the cached store value so other consumers (e.g. the
      // param browser) see the new value without a full reload.
      const existing = params.params.get(name)
      if (existing)
        params.params.set(name, { ...existing, value: pv.paramValue })
      resolve(Math.abs(pv.paramValue - value) < 1e-6)
    })
    session.sendMessage(buildParamSet(targetSys, COMP_ID_AUTOPILOT, name, value, type)).catch(() => {
      clearTimeout(timer)
      unsubscribe?.()
      resolve(false)
    })
  })
}

// Operator clicked Restart. Fire the reboot via the session store;
// transition to rebooting. The transport drop happens asynchronously
// when the FC actually exits — we watch session.connected to render
// the right copy (still up vs dropped).
async function restart() {
  phase.value = 'rebooting'
  errorMessage.value = null
  await session.reboot()
}

// Resolve once a fresh heartbeat sets session.sysid, or after a
// timeout. session.connect() resolves on transport-open, which is
// before the FC's first heartbeat — and params.load() bails when
// sysid is still null, so we must wait for the heartbeat before
// loading. resetParsed() in connect() nulls sysid, so an immediate
// non-null check would only pass for a pre-existing connection.
function waitForHeartbeat(timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (session.sysid !== null) {
      resolve(true)
      return
    }
    let stop: (() => void) | null = null
    const timer = setTimeout(() => {
      stop?.()
      resolve(false)
    }, timeoutMs)
    stop = watch(() => session.sysid, (sysid) => {
      if (sysid !== null) {
        clearTimeout(timer)
        stop?.()
        resolve(true)
      }
    })
  })
}

// Operator clicked Reconnect after the drone came back. Re-open the
// transport, wait for the post-reboot heartbeat (which also clears
// session.rebooting), then reload params so the new SCR_ENABLE shows.
// If the drone isn't fully back yet — transport opens but no heartbeat,
// or the bridge can't reach a still-rebooting SITL — drop back to the
// rebooting state so the operator can try again.
async function reconnect() {
  phase.value = 'reconnecting'
  errorMessage.value = null
  await session.connect()
  if (!session.connected) {
    phase.value = 'rebooting'
    errorMessage.value = 'Couldn\'t reconnect yet. Give it a moment and try again.'
    return
  }
  const gotHeartbeat = await waitForHeartbeat(8000)
  if (!gotHeartbeat || session.sysid === null) {
    phase.value = 'rebooting'
    errorMessage.value = 'Connected, but your drone hasn\'t said hello yet. Give it a moment and try again.'
    return
  }
  // Force a fresh fetch so the post-reboot SCR_ENABLE value reaches
  // the store (the cache from before reboot is stale).
  params.clear()
  await params.load()
  pendingValue.value = null
  phase.value = 'idle'
}

// Cancel a pending or needs-reboot change before committing the reboot.
// The pending PARAM_SET (if already sent) has technically landed but
// since we haven't rebooted, the FC's in-memory value will revert on
// next reboot anyway — and most operators expect Cancel = "forget I
// touched anything", so we just clear the pending state.
function cancel() {
  pendingValue.value = null
  errorMessage.value = null
  phase.value = 'idle'
}
</script>

<template>
  <div class="mx-auto w-full max-w-2xl space-y-6">
    <header class="flex items-center gap-3">
      <UIcon name="i-lucide-sliders-horizontal" class="text-primary size-7" />
      <div>
        <h1 class="text-highlighted text-2xl font-semibold">
          Drone settings
        </h1>
        <p class="text-muted text-sm">
          Toggle features on your drone. Some changes need a restart to take effect — we'll walk you through it.
        </p>
      </div>
    </header>

    <UCard>
      <template #header>
        <div class="flex items-center justify-between gap-3">
          <div class="flex items-center gap-3">
            <UIcon name="i-lucide-code-2" class="text-primary size-6" />
            <h2 class="text-highlighted text-lg font-semibold">
              Lua scripting
            </h2>
          </div>
          <USwitch
            v-if="phase !== 'checking' && phase !== 'unavailable'"
            v-model="switchValue"
            color="primary"
            :disabled="isBusy"
            :aria-label="`Lua scripting — currently ${isOn ? 'on' : 'off'}`"
          />
        </div>
      </template>

      <p class="text-muted text-sm">
        Run Lua applets on your drone — needed for some wizards and recipes,
        and for any custom in-flight automation you want to add later.
      </p>

      <!-- checking -->
      <div v-if="phase === 'checking'" class="text-muted mt-4 flex items-center gap-2 text-sm">
        <UIcon name="i-lucide-loader-circle" class="size-4 animate-spin" />
        Checking your drone's settings…
      </div>

      <!-- unavailable -->
      <div v-else-if="phase === 'unavailable'" class="mt-4">
        <UAlert color="warning" :title="errorMessage ?? 'Setting unavailable'" />
      </div>

      <!-- idle: applied state -->
      <p
        v-else-if="phase === 'idle'"
        class="text-muted mt-4 flex items-center gap-2 text-sm"
      >
        <UIcon name="i-lucide-circle-check" class="text-success size-4" />
        Currently {{ isOn ? 'on' : 'off' }}.
      </p>

      <!-- pending: operator flipped, not yet applied -->
      <div v-else-if="phase === 'pending'" class="mt-4 space-y-3">
        <UAlert
          color="warning"
          :title="`Will turn ${pendingValue === 1 ? 'on' : 'off'}`"
          description="Your drone needs to restart for this to take effect."
        />
        <div class="flex justify-end gap-2">
          <UButton color="neutral" variant="ghost" @click="cancel">
            Cancel
          </UButton>
          <UButton color="primary" @click="apply">
            Apply
          </UButton>
        </div>
      </div>

      <!-- applying: waiting for PARAM_SET echo -->
      <div v-else-if="phase === 'applying'" class="text-muted mt-4 flex items-center gap-2 text-sm">
        <UIcon name="i-lucide-loader-circle" class="size-4 animate-spin" />
        Saving the change to your drone…
      </div>

      <!-- needs-reboot: write landed, awaiting Restart -->
      <div v-else-if="phase === 'needs-reboot'" class="mt-4 space-y-3">
        <UAlert
          color="warning"
          title="Restart needed"
          description="Your drone has the new setting saved, but won't actually use it until it restarts. Restarting takes a few seconds; we'll prompt you to reconnect when it's back."
        />
        <div class="flex justify-end gap-2">
          <UButton color="neutral" variant="ghost" @click="cancel">
            Cancel
          </UButton>
          <UButton color="primary" @click="restart">
            Restart drone now
          </UButton>
        </div>
      </div>

      <!-- rebooting: reboot sent, waiting for transport drop or reconnect -->
      <div v-else-if="phase === 'rebooting'" class="mt-4 space-y-3">
        <UAlert
          color="info"
          icon="i-lucide-loader-circle"
          :title="session.connected ? 'Restarting your drone…' : 'Your drone is restarting'"
          :description="session.connected
            ? 'Hold tight — the connection will drop for a few seconds.'
            : 'When it\'s back up, click Reconnect.'"
        />
        <div class="flex justify-end gap-2">
          <UButton
            color="primary"
            :disabled="session.connected"
            @click="reconnect"
          >
            Reconnect
          </UButton>
        </div>
        <p v-if="errorMessage" class="text-warning text-sm">
          {{ errorMessage }}
        </p>
      </div>

      <!-- reconnecting: connect() in flight after restart -->
      <div v-else-if="phase === 'reconnecting'" class="text-muted mt-4 flex items-center gap-2 text-sm">
        <UIcon name="i-lucide-loader-circle" class="size-4 animate-spin" />
        Reconnecting to your drone…
      </div>
    </UCard>
  </div>
</template>
