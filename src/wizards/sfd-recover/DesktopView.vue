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

// The exit ceremony's view - the customer's way back out of SmallFastDrone.
// docs/SECURITY.md is explicit that this must be as polished as the way in,
// because a door you cannot leave by is not a door.
//
// The ordering and its guarantees live in workflow/sfd-recover.ts, which is
// pure and unit-tested; this supplies the I/O behind its RecoveryDriver and
// the operator prompts. The two gates the ceremony blocks on - "have you
// really saved the file" and "is the drone in update mode" - are promises
// this view resolves from button clicks, which is what keeps the decision
// with the operator rather than with a timeout.
//
// Three things here that are easy to get wrong:
//
//   - The unlock resets the chip the moment it succeeds, so the DFU handle
//     from before it is dead. The device has to be re-acquired before the
//     flash, which needs no fresh permission prompt because it was already
//     authorised.
//   - The chip comes back blank *including its bootloader*, so the image
//     has to be a `_with_bl.hex`. An .apj would leave a drone that cannot
//     start.
//   - The drone's identity dies here and a new one would be a different
//     identity. Anything SmallFastDrone sent for this airframe stops
//     working, so the operator is told that before they start, not after.

import type { ParsedHex } from '../../protocol/intel-hex'
import type { OpenedDfuDevice } from '../../transport/webusb'
import type { RecoverOutcome, RecoverPhase, RecoveryDriver } from '../../workflow/sfd-recover'
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { MavFtp } from '../../protocol/ftp'
import { parseIntelHex } from '../../protocol/intel-hex'
import { buildForceSaveCalibration } from '../../protocol/mavlink'
import { changedParamNames, parseParamPack } from '../../protocol/param-pack'
import { isParamReadOnly } from '../../protocol/params'
import { useParamsStore } from '../../stores/params'
import { useSessionStore } from '../../stores/session'
import { useWizardProgressStore } from '../../stores/wizardProgress'
import { listAuthorisedDfuDevices, openDfuDevice, requestDfuDevice } from '../../transport/webusb'
import { downloadText } from '../../ui/download'
import { useFirmwareFlash } from '../../workflow/firmware'
import {
  backupFilename,
  planRestore,
  restoreTouchesCalibration,
  serializeBackup,
} from '../../workflow/param-backup'
import { useSettingsBackup } from '../../workflow/settings-backup'
import { hasUnfinishedBusiness, RecoverError, runExitCeremony } from '../../workflow/sfd-recover'
import RecoverySteps from './RecoverySteps.vue'

const COMP_ID_AUTOPILOT = 1
const PARAM_PACK_PATH = '@PARAM/param.pck?withdefaults=1'

const session = useSessionStore()
const params = useParamsStore()
const wizardProgress = useWizardProgressStore()
const router = useRouter()
const route = useRoute()
const { capture } = useSettingsBackup()
const { flashDfu, unlockDfu, phase: flashPhase, progress: flashProgress } = useFirmwareFlash()

const returnTo = computed(() => String(route.query.returnTo ?? '/wizard'))

const phase = ref<RecoverPhase | 'idle'>('idle')
const outcome = ref<RecoverOutcome | null>(null)
const stopped = ref<RecoverError | null>(null)
const running = computed(() => phase.value !== 'idle' && phase.value !== 'done' && stopped.value === null)

// Operator-supplied image. Must carry a bootloader: the chip is blank.
const image = ref<{ hex: ParsedHex, filename: string } | null>(null)
const imageError = ref<string | null>(null)

const savedFilename = ref<string | null>(null)
const dfuError = ref<string | null>(null)

// The two operator gates, held as resolvers the buttons complete.
let resolveSaved: ((ok: boolean) => void) | null = null
let resolveDfu: ((ok: boolean) => void) | null = null
let resolveDrone: ((ok: boolean) => void) | null = null
let opened: OpenedDfuDevice | null = null

async function chooseImage(event: Event): Promise<void> {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file)
    return
  imageError.value = null
  try {
    const parsed = parseIntelHex(await file.text())
    image.value = { hex: parsed, filename: file.name }
  }
  catch (e) {
    image.value = null
    imageError.value = e instanceof Error ? e.message : 'That file couldn\'t be read.'
  }
}

// Gate 1. The operator has the file in their hands, not merely offered.
function confirmSaved(): void {
  resolveSaved?.(true)
  resolveSaved = null
}

// Gate 2. WebUSB's picker must run inside the click, so the request is
// here rather than inside the driver's promise.
async function connectInUpdateMode(): Promise<void> {
  dfuError.value = null
  try {
    const device = await requestDfuDevice()
    if (!device) {
      dfuError.value = 'No drone in update mode was picked.'
      return
    }
    opened = await openDfuDevice(device)
    resolveDfu?.(true)
    resolveDfu = null
  }
  catch (e) {
    dfuError.value = e instanceof Error ? e.message : 'Couldn\'t open the drone in update mode.'
  }
}

// Gate 3. Reconnecting after the flash needs a gesture too (the browser
// asks for the serial port), so it is a button rather than a poll.
async function reconnectDrone(): Promise<void> {
  await session.connect().catch(() => {})
  if (session.connected) {
    await params.load()
    resolveDrone?.(true)
    resolveDrone = null
  }
}

// The ceremony blocks on these until the operator acts, which is what
// keeps an irreversible decision with a person rather than a timeout.
function gate(assign: (r: (ok: boolean) => void) => void): Promise<boolean> {
  return new Promise<boolean>(resolve => assign(resolve))
}

function awaitSavedGate(): Promise<boolean> {
  return gate((r) => {
    resolveSaved = r
  })
}

function awaitDfuGate(): Promise<boolean> {
  return gate((r) => {
    resolveDfu = r
  })
}

function awaitDroneGate(): Promise<boolean> {
  return gate((r) => {
    resolveDrone = r
  })
}

// The chip resets itself the instant readout protection drops, so the
// handle we unlocked through is gone. It stays authorised, though, so it
// can be reopened without another permission prompt.
async function reacquireDfu(timeoutMs = 30_000): Promise<OpenedDfuDevice> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = await listAuthorisedDfuDevices()
    if (found.length > 0) {
      try {
        return await openDfuDevice(found[0]!.device)
      }
      catch {
        // Still settling after the reset; fall through and retry.
      }
    }
    if (Date.now() >= deadline)
      throw new Error('Your drone didn\'t come back in update mode after being wiped.')
    await new Promise(r => setTimeout(r, 500))
  }
}

const driver: RecoveryDriver = {
  captureBackup: capture,
  confirmBackupSaved: async (backup) => {
    const text = serializeBackup(backup)
    const filename = backupFilename(backup)
    downloadText(text, filename)
    savedFilename.value = filename
    return awaitSavedGate()
  },
  awaitDfuDevice: awaitDfuGate,
  unlock: async () => {
    if (!opened)
      throw new Error('Lost track of the drone in update mode.')
    await unlockDfu(opened)
  },
  flashWithBootloader: async () => {
    const chosen = image.value
    if (!chosen)
      throw new Error('No firmware file was chosen.')
    opened = await reacquireDfu()
    await flashDfu({ kind: 'hex', hex: chosen.hex, filename: chosen.filename }, opened, { eraseStrategy: 'mass' })
  },
  awaitDrone: awaitDroneGate,
  restore: async (backup) => {
    const sysid = session.sysid
    if (sysid === null)
      throw new Error('Your drone isn\'t connected.')
    // Re-read what the fresh firmware considers changed: the plan has to
    // be against the drone as it is now, not as it was before the wipe.
    const ftp = new MavFtp(session.sendMessage, session.subscribeMessages, sysid, COMP_ID_AUTOPILOT)
    await ftp.resetSessions()
    const changed = changedParamNames(parseParamPack(await ftp.downloadFile(PARAM_PACK_PATH)))
    const plan = planRestore(backup, params.params, { changed, isReadOnly: isParamReadOnly })

    for (const item of plan.toWrite)
      params.setEdit(item.name, item.backupValue)
    if (plan.toWrite.length > 0) {
      await params.apply()
      if (params.applyError !== null)
        throw new Error(params.applyError)
    }

    // The drone was wiped, so anything it knew about its own calibration
    // went with it. The values are back now, but the sensor ids that make
    // them count are not in a backup - tell it they are good, or it comes
    // out of the ceremony refusing to arm.
    if (restoreTouchesCalibration(plan))
      await session.sendMessage(buildForceSaveCalibration(sysid, COMP_ID_AUTOPILOT)).catch(() => {})

    return plan
  },
}

async function start(): Promise<void> {
  stopped.value = null
  outcome.value = null
  try {
    outcome.value = await runExitCeremony(driver, (p) => {
      phase.value = p
    })
  }
  catch (e) {
    stopped.value = e instanceof RecoverError
      ? e
      : new RecoverError('restore-failed', e instanceof Error ? e.message : String(e))
  }
}

// Re-offer the backup whenever the ceremony stopped holding one; an
// operator who lost the file has lost the drone's configuration.
function saveBackupAgain(): void {
  const backup = stopped.value?.backup ?? outcome.value?.backup
  if (backup)
    downloadText(serializeBackup(backup), backupFilename(backup))
}

const unfinished = computed(() => (outcome.value ? hasUnfinishedBusiness(outcome.value) : false))

function finish(): void {
  wizardProgress.markComplete(session.fcUid, 'sfd-recover', 'Your drone is back to ordinary firmware, with your settings put back.')
  router.push(returnTo.value)
}

function cancel(): void {
  router.push(returnTo.value)
}
</script>

<template>
  <div class="space-y-4">
    <div class="border-default rounded-md border bg-elevated/50 p-5">
      <RecoverySteps
        :phase="phase"
        :destructive="stopped?.destructive ?? (phase === 'flashing' || phase === 'reconnecting' || phase === 'restoring' || phase === 'done')"
        :failed="stopped !== null"
      />
    </div>

    <!-- Before anything: the cost, in full, while it is still avoidable. -->
    <div v-if="phase === 'idle'" class="space-y-3">
      <UAlert
        color="warning"
        icon="i-lucide-triangle-alert"
        title="This wipes your drone completely"
        description="Everything on it is erased — its software and its identity. Your drone can be given a new identity afterwards, but it won't be the same one, so anything SmallFastDrone sent for this drone will stop working. Your settings are saved first and put back at the end."
      />

      <div class="border-default space-y-2 rounded-md border p-4">
        <p class="text-default text-sm font-medium">
          Firmware to install afterwards
        </p>
        <p class="text-muted text-xs">
          The drone is wiped right down to the software that starts it, so this
          has to be a full install file (one ending <code>_with_bl.hex</code>).
        </p>
        <input type="file" accept=".hex" class="text-sm" @change="chooseImage">
        <p v-if="image" class="text-success text-xs">
          Ready: {{ image.filename }}
        </p>
        <p v-if="imageError" class="text-error text-xs">
          {{ imageError }}
        </p>
      </div>

      <UButton
        color="error"
        icon="i-lucide-shield-off"
        :disabled="!image || !session.connected"
        @click="start"
      >
        Start
      </UButton>
      <p v-if="!session.connected" class="text-muted text-xs">
        Connect your drone first — its settings are read before anything is erased.
      </p>
    </div>

    <!-- Gate 1: the backup is downloaded; the operator confirms they have it. -->
    <div v-else-if="phase === 'awaiting-save'" class="space-y-3">
      <UAlert
        color="primary"
        icon="i-lucide-save"
        title="Your settings have been saved to your computer"
        :description="`Check you have ${savedFilename ?? 'the file'} before going on. It is the only way to put this drone back the way it is now.`"
      />
      <div class="flex flex-wrap gap-2">
        <UButton color="primary" icon="i-lucide-check" @click="confirmSaved">
          I have the file — continue
        </UButton>
        <UButton color="neutral" variant="subtle" icon="i-lucide-download" @click="saveBackupAgain">
          Download it again
        </UButton>
      </div>
    </div>

    <!-- Gate 2: physical update mode. Signed firmware refuses to do this
         over the link by design, so it is the operator's hands. -->
    <div v-else-if="phase === 'awaiting-dfu'" class="space-y-3">
      <UAlert
        color="primary"
        icon="i-lucide-usb"
        title="Put your drone into update mode"
        description="Unplug it, hold its BOOT button (or bridge the BOOT pads), then plug it back in while holding. Secured drones won't switch to update mode on command — that's deliberate — so it has to be done by hand."
      />
      <UAlert v-if="dfuError" color="error" icon="i-lucide-triangle-alert" :description="dfuError" />
      <UButton color="primary" icon="i-lucide-plug" @click="connectInUpdateMode">
        My drone is in update mode
      </UButton>
    </div>

    <!-- Gate 3: back on the link after the flash. -->
    <div v-else-if="phase === 'reconnecting'" class="space-y-3">
      <UAlert
        color="primary"
        icon="i-lucide-plug"
        title="Reconnect your drone"
        description="The new software is installed. Unplug it and plug it back in normally, then reconnect so your settings can go back."
      />
      <UButton color="primary" icon="i-lucide-plug" @click="reconnectDrone">
        Reconnect
      </UButton>
    </div>

    <div v-else-if="running" class="text-muted flex items-center gap-2 text-sm">
      <UIcon name="i-lucide-loader-circle" class="size-4 animate-spin" />
      <span v-if="phase === 'backing-up'">Reading your drone's settings…</span>
      <span v-else-if="phase === 'unlocking'">Wiping your drone — don't unplug it.</span>
      <span v-else-if="phase === 'flashing'">
        Installing fresh software — don't unplug it.
        <template v-if="flashProgress !== null">{{ Math.round(flashProgress * 100) }}%</template>
        <template v-else-if="flashPhase">({{ flashPhase }})</template>
      </span>
      <span v-else>Putting your settings back…</span>
    </div>

    <!-- Stopped. Whether the drone was touched changes what to say. -->
    <div v-if="stopped" class="space-y-3">
      <UAlert
        color="error"
        icon="i-lucide-triangle-alert"
        :title="stopped.destructive ? 'Your drone needs finishing' : 'Stopped — your drone is untouched'"
        :description="stopped.message"
      />
      <div class="flex flex-wrap gap-2">
        <UButton v-if="stopped.backup" color="primary" icon="i-lucide-download" @click="saveBackupAgain">
          Save your settings file
        </UButton>
        <UButton color="neutral" variant="subtle" icon="i-lucide-rotate-ccw" @click="start">
          Start again
        </UButton>
      </div>
    </div>

    <!-- Done. An incomplete restore is not reported as a clean success. -->
    <div v-else-if="phase === 'done' && outcome" class="space-y-3">
      <UAlert
        :color="unfinished ? 'warning' : 'success'"
        :icon="unfinished ? 'i-lucide-shield-alert' : 'i-lucide-shield-check'"
        :title="unfinished ? 'Your drone is back, with some settings to check' : 'Your drone is back to ordinary firmware'"
        :description="unfinished
          ? 'Its software is fresh and most settings went back, but some couldn\'t. They are listed below — worth a look before you fly.'
          : 'Its software is fresh and your settings have been put back.'"
      />
      <div v-if="unfinished" class="border-default rounded-md border p-4 text-sm">
        <p v-if="outcome.restored.missing.length > 0" class="text-muted">
          <span class="text-default font-medium">{{ outcome.restored.missing.length }}</span>
          setting(s) don't exist on this firmware any more.
        </p>
        <p v-if="outcome.restored.notReverted.length > 0" class="text-muted">
          <span class="text-default font-medium">{{ outcome.restored.notReverted.length }}</span>
          setting(s) were changed after the backup was taken, so there was no saved value to go back to.
        </p>
      </div>
      <div class="flex flex-wrap gap-2">
        <UButton color="primary" trailing-icon="i-lucide-arrow-right" @click="finish">
          Done
        </UButton>
        <UButton color="neutral" variant="subtle" icon="i-lucide-download" @click="saveBackupAgain">
          Keep the settings file
        </UButton>
      </div>
    </div>

    <div v-if="phase === 'idle'" class="pt-2">
      <UButton color="neutral" variant="ghost" @click="cancel">
        Cancel
      </UButton>
    </div>
  </div>
</template>
