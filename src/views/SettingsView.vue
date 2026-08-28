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
// Two flows, chosen by the toggle's `rebootRequired` flag:
//
//   reboot-required (scripting): flip the switch → `pending` (operator
//     confirms with Apply) → `applying` (PARAM_SET + echo) →
//     `restarting` (reboot + automatic reconnect with retries through
//     the FC's restart window) → `idle` with the new value. Apply does
//     the whole thing — write, reboot, reconnect — with no further
//     operator action.
//
//   no-reboot (future toggles): flipping the switch writes the param
//     immediately (`applying` → `idle`). No Apply step — the change
//     just takes effect.
//
// Other phases: `checking` (params loading), `unavailable` (not
// connected / param absent), `reconnect-failed` (auto-reconnect gave
// up; manual Reconnect offered as a fallback).

import type { ParamValue } from 'mavlink-mappings/dist/lib/common'
import { computed, onMounted, ref, watch } from 'vue'
import { MavFtp } from '../protocol/ftp'
import { changedParamNames, parseParamPack } from '../protocol/param-pack'
import { buildParamSet, isParamReadOnly, MSGID_PARAM_VALUE } from '../protocol/params'
import { useParamsStore } from '../stores/params'
import { useSessionStore } from '../stores/session'
import {
  backupFilename,
  backupParamCount,
  buildBackup,
  serializeBackup,
} from '../workflow/param-backup'
import { sleep, STORAGE_SETTLE_MS, useReconnect } from '../workflow/reconnect'

// Hardcoded scripting toggle. When a second toggle lands this lifts
// into a FeatureToggle interface + a registry; for one entry the inline
// shape is clearer. `rebootRequired` drives which flow the toggle uses.
const TOGGLE = {
  param: 'SCR_ENABLE',
  type: 2, // MAV_PARAM_TYPE_INT8
  rebootRequired: true,
} as const
const COMP_ID_AUTOPILOT = 1
const PARAM_ACK_TIMEOUT_MS = 1500
// Packed parameter file, asked for with defaults so the firmware tells us
// which parameters it considers changed. See src/protocol/param-pack.ts.
const PARAM_PACK_PATH = '@PARAM/param.pck?withdefaults=1'

const session = useSessionStore()
const params = useParamsStore()
const { autoReconnect } = useReconnect()

type Phase
  = | 'checking'
    | 'unavailable'
    | 'idle'
    | 'pending'
    | 'applying'
    | 'restarting'
    | 'reconnect-failed'
const phase = ref<Phase>('checking')
const errorMessage = ref<string | null>(null)
const pendingValue = ref<number | null>(null)

// Latest FC-reported value — null when the param isn't in the store
// (not loaded, or absent on this firmware). Read fresh each access so a
// post-reboot reload reflects.
const fcValue = computed<number | null>(() => {
  const p = params.params.get(TOGGLE.param)
  return p ? Math.trunc(p.value) : null
})
const isOn = computed(() => fcValue.value === 1)

// What the switch shows. While pending, the operator's chosen value;
// otherwise the FC's.
const switchValue = computed({
  get: () => pendingValue.value !== null ? pendingValue.value === 1 : isOn.value,
  set: v => onToggle(v),
})

// The switch + idle states are interactive; the rest are mid-operation.
const isBusy = computed(() =>
  phase.value === 'applying' || phase.value === 'restarting',
)

// Mount: bail to unavailable if disconnected, else load params and
// decide idle (param present) vs unavailable (firmware lacks it).
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
  if (!params.params.has(TOGGLE.param)) {
    phase.value = 'unavailable'
    errorMessage.value = 'This drone\'s firmware doesn\'t expose Lua scripting — it may not be compiled into this build.'
    return
  }
  phase.value = 'idle'
})

// Wait until paramsStore.loading flips false — for the rare case the
// view mounts while another store consumer is mid-fetch.
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

// Operator flipped the switch. Reboot-required toggles stage a pending
// change for the operator to confirm with Apply; no-reboot toggles
// write immediately. Flipping back to the current FC value is a no-op.
function onToggle(on: boolean) {
  const wanted = on ? 1 : 0
  if (wanted === fcValue.value) {
    pendingValue.value = null
    if (phase.value === 'pending')
      phase.value = 'idle'
    return
  }
  if (TOGGLE.rebootRequired) {
    pendingValue.value = wanted
    phase.value = 'pending'
  }
  else {
    void applyImmediate(wanted)
  }
}

// No-reboot path: write the param and settle straight back to idle.
async function applyImmediate(wanted: number) {
  phase.value = 'applying'
  errorMessage.value = null
  const ok = await writeParamWithEcho(TOGGLE.param, wanted, TOGGLE.type)
  pendingValue.value = null
  if (!ok) {
    phase.value = 'idle'
    errorMessage.value = 'The drone didn\'t acknowledge the change. Try again.'
    return
  }
  phase.value = 'idle'
}

// Reboot path: write the param, settle, reboot, then auto-reconnect
// and reload. One operator click (Apply) drives the whole sequence.
async function apply() {
  if (pendingValue.value === null || session.sysid === null)
    return
  phase.value = 'applying'
  errorMessage.value = null
  const ok = await writeParamWithEcho(TOGGLE.param, pendingValue.value, TOGGLE.type)
  if (!ok) {
    phase.value = 'pending'
    errorMessage.value = 'The drone didn\'t acknowledge the change. Try again.'
    return
  }
  await sleep(STORAGE_SETTLE_MS)
  phase.value = 'restarting'
  await session.reboot()
  await reconnectAndFinish()
}

// Send PARAM_SET, wait for the FC's PARAM_VALUE echo. Returns true if
// the echoed value matches within float epsilon. Updates the cached
// store value so the param browser reflects the change without a reload.
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

// Drive the post-reboot reconnect to completion: wait for the
// transport to drop, retry connect+heartbeat until the FC is back,
// reload params, settle to idle. Falls to reconnect-failed if the
// drone doesn't return within the budget (manual Reconnect offered).
async function reconnectAndFinish() {
  phase.value = 'restarting'
  errorMessage.value = null
  const back = await autoReconnect()
  if (!back) {
    phase.value = 'reconnect-failed'
    errorMessage.value = 'Couldn\'t reconnect to your drone automatically. Make sure it\'s powered, then try again.'
    return
  }
  // Fresh fetch — the pre-reboot cache is stale.
  params.clear()
  await params.load()
  pendingValue.value = null
  phase.value = 'idle'
}

// Manual fallback from the reconnect-failed state — re-run the
// reconnect loop on operator demand.
function retryReconnect() {
  void reconnectAndFinish()
}

// Cancel a pending change before it's applied — forget the operator
// touched the switch.
function cancel() {
  pendingValue.value = null
  errorMessage.value = null
  phase.value = 'idle'
}

// --- Settings backup -------------------------------------------------

type SaveState = 'idle' | 'saving' | 'saved' | 'error'

const saveState = ref<SaveState>('idle')
const savedFilename = ref<string | null>(null)
const savedCount = ref(0)
const saveError = ref<string | null>(null)

// Backing up needs a live drone: the vehicle block records which drone
// and which firmware the snapshot came from, and the session clears that
// detail on disconnect.
const canSave = computed(() =>
  session.connected && !params.loading && params.count > 0,
)

// Snapshot the operator's configuration and hand them a file.
//
// The drone is asked which of its parameters differ from its own factory
// defaults — `@PARAM/param.pck?withdefaults=1` over MAVLink-FTP, where the
// firmware attaches a default only to entries it has changed. That is the
// only authoritative source: defaults are board- and frame-specific, and
// the bundled metadata carries no defaults at all. Read-only parameters
// are dropped on top, from the metadata that does know about those.
//
// A plain download rather than the File System Access API: this is a
// one-shot export of a small document, and a save dialog would add a
// permission prompt for no benefit — the result line names the file so
// the operator knows what to look for.
async function saveSettings() {
  const sysid = session.sysid
  if (sysid === null)
    return

  saveState.value = 'saving'
  saveError.value = null
  try {
    const changed = await fetchChangedNames()

    const backup = buildBackup(
      params.params,
      {
        sysid,
        firmwareVersion: session.firmwareVersion,
        frameLabel: session.vehicleLabel,
        uid: session.fcUid,
      },
      new Date().toISOString(),
      { changed, isReadOnly: isParamReadOnly },
    )
    const filename = backupFilename(backup)
    downloadText(serializeBackup(backup), filename)
    savedFilename.value = filename
    savedCount.value = backupParamCount(backup)
    saveState.value = 'saved'
  }
  catch (err) {
    saveError.value = err instanceof Error ? err.message : 'Couldn\'t save your settings.'
    saveState.value = 'error'
  }
}

// Ask the drone which of its parameters differ from its own factory
// defaults. Shared by save and restore — save uses it to decide what to
// write out, restore to spot changes the backup can't undo.
async function fetchChangedNames(): Promise<Set<string>> {
  const sysid = session.sysid
  if (sysid === null)
    throw new Error('Connect to your drone first.')
  const ftp = new MavFtp(session.sendMessage, session.subscribeMessages, sysid, COMP_ID_AUTOPILOT)
  // Clear any FTP slots a previous fetch left tied up; the firmware
  // doesn't free them on its own and a second fetch would fail on
  // OpenFileRO. Same reason useConnections() does it.
  await ftp.resetSessions()
  return changedParamNames(parseParamPack(await ftp.downloadFile(PARAM_PACK_PATH)))
}

// "1 setting" / "3 settings" — the counts below are frequently one.
function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

function downloadText(text: string, filename: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
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
          Toggle features on your drone. Some changes need a restart — we handle that for you.
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

      <!-- pending: reboot-required change staged, awaiting Apply -->
      <div v-else-if="phase === 'pending'" class="mt-4 space-y-3">
        <UAlert
          color="warning"
          :title="`Will turn ${pendingValue === 1 ? 'on' : 'off'}`"
          description="Applying this restarts your drone (a few seconds) — we'll reconnect automatically when it's back."
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

      <!-- applying: PARAM_SET in flight -->
      <div v-else-if="phase === 'applying'" class="text-muted mt-4 flex items-center gap-2 text-sm">
        <UIcon name="i-lucide-loader-circle" class="size-4 animate-spin" />
        Saving the change to your drone…
      </div>

      <!-- restarting: reboot + automatic reconnect -->
      <div v-else-if="phase === 'restarting'" class="mt-4">
        <UAlert
          color="info"
          icon="i-lucide-loader-circle"
          title="Restarting your drone…"
          description="The connection will drop for a few seconds while it restarts. We'll reconnect automatically — no need to do anything."
        />
      </div>

      <!-- reconnect-failed: auto-reconnect gave up, manual fallback -->
      <div v-else-if="phase === 'reconnect-failed'" class="mt-4 space-y-3">
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
    </UCard>

    <UCard>
      <template #header>
        <div class="flex items-center gap-3">
          <UIcon name="i-lucide-save" class="text-primary size-6" />
          <h2 class="text-highlighted text-lg font-semibold">
            Your drone's settings
          </h2>
        </div>
      </template>

      <p class="text-muted text-sm">
        Save a copy of everything that's been changed on your drone from how it
        left the factory — frame, motors, connections, tuning. If your drone ever
        gets wiped, this is what puts it back the way you had it.
      </p>

      <div class="mt-4 space-y-3">
        <UAlert
          v-if="saveState === 'saved'"
          color="success"
          icon="i-lucide-check"
          :title="`Saved ${plural(savedCount, 'setting')}`"
        >
          <template #description>
            Everything you've changed from the factory setup, in
            <span class="font-medium">{{ savedFilename }}</span> in your downloads.
          </template>
        </UAlert>

        <UAlert
          v-else-if="saveState === 'error'"
          color="warning"
          icon="i-lucide-triangle-alert"
          title="Couldn't save your settings"
        >
          <template #description>
            {{ saveError }}
          </template>
        </UAlert>

        <p v-else-if="!canSave" class="text-muted text-sm">
          <template v-if="!session.connected">
            Connect your drone to save its settings.
          </template>
          <template v-else>
            Reading your drone's settings…
          </template>
        </p>

        <div class="flex justify-end">
          <UButton
            color="primary"
            icon="i-lucide-download"
            :disabled="!canSave"
            :loading="saveState === 'saving'"
            @click="saveSettings"
          >
            {{ saveState === 'saving' ? 'Saving…' : 'Save to my computer' }}
          </UButton>
        </div>
      </div>
    </UCard>
  </div>
</template>
