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

// SFD enable wizard - the identity half of the ceremony in
// docs/SECURITY.md. The drone makes its own identity from its hardware
// random number generator, keeps the secret half forever, and hands back
// the public half; the operator leaves with the file that proves which
// drone it is.
//
// What the view is really for is telling the operator *which* of several
// situations they are in, because they need different things. A drone
// running ordinary ArduPilot cannot hold an identity at all. One part way
// through an upgrade needs its startup software updated first - and can be,
// from here. One that is ready needs a single button. One that already has
// an identity needs nothing but its file again. Those are driven off
// session.securityPosture, which is one GET_IDENTITY read (see
// src/workflow/drone-security.ts).
//
// Sealing is offered only *after* an identity exists and has been verified,
// never as part of the same action - docs/SECURITY.md, "Why this ordering is
// the security property". It is also the one thing here the tool cannot
// undo, so it sits behind a disclosure and a typed confirmation rather than
// beside the primary button, the way the DFU unlock does on the Firmware
// page.

import type { OwnerGrant } from '../../protocol/owner-grant'
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { grantMatchesFc, parseOwnerGrant } from '../../protocol/owner-grant'
import { useParamsStore } from '../../stores/params'
import { useSessionStore } from '../../stores/session'
import { useWizardProgressStore } from '../../stores/wizardProgress'
import { downloadText } from '../../ui/download'
import {
  describeBootloaderUpdateFailure,
  flashRomfsBootloader,
} from '../../workflow/bootloader-update'
import {
  isLockRequested,
  LOCK_PARAM,
  lockBlocker,
  withLockBit,
} from '../../workflow/drone-lock'
import { ownerFingerprint } from '../../workflow/owner-key'
import { useReconnect } from '../../workflow/reconnect'
import { useSfdEnable } from '../../workflow/use-sfd-enable'
import IdentityMark from './IdentityMark.vue'

const COMP_ID_AUTOPILOT = 1

const session = useSessionStore()
const params = useParamsStore()
const wizardProgress = useWizardProgressStore()
const router = useRouter()
const route = useRoute()
const {
  phase,
  busy,
  error,
  failure,
  outcome,
  run,
  ownerKey,
  ownerLabel,
  ownerError,
  applyGrant,
  grantError,
  loadOwnerKey,
  importOwnerKeyFile,
  forgetOwnerKey,
} = useSfdEnable()

// The operator's key file, picked from disk. Only the private half's
// import matters; the file is never kept, because it is their backup and
// the only copy that outlives this browser.
const ownerInput = ref<HTMLInputElement | null>(null)

/*
  Applying a permission SFD issued for this drone.

  The tool cannot check the signature — the key that does is in the
  drone's bootloader — so the check that matters here is a human one.
  The likely attack is not on the crypto but on the customer, relaying a
  file somebody sent them; so this shows the key the permission would
  install and asks them to confirm it is theirs before anything is sent.
*/
const grantInput = ref<HTMLInputElement | null>(null)
const pendingGrant = ref<OwnerGrant | null>(null)
const pendingGrantLabel = ref<string | null>(null)
const grantState = ref<'idle' | 'working' | 'done'>('idle')
const grantParseError = ref<string | null>(null)

const grantIsMine = computed(() => {
  const mine = ownerKey.value?.publicKey
  const theirs = pendingGrant.value?.publicKey
  if (!mine || !theirs)
    return false
  return mine.length === theirs.length && mine.every((b, i) => b === theirs[i])
})

async function chooseGrant(event: Event): Promise<void> {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (grantInput.value)
    grantInput.value.value = ''
  pendingGrant.value = null
  grantParseError.value = null
  grantState.value = 'idle'
  if (!file)
    return
  try {
    const grant = parseOwnerGrant(new Uint8Array(await file.arrayBuffer()))
    if (!grantMatchesFc(grant, session.fcUid))
      throw new Error(`That permission was issued for a different drone (${grant.uid.slice(0, 12)}…).`)
    pendingGrant.value = grant
    pendingGrantLabel.value = await ownerFingerprint(grant.publicKey)
  }
  catch (e) {
    grantParseError.value = e instanceof Error ? e.message : String(e)
  }
}

async function confirmGrant(): Promise<void> {
  if (!pendingGrant.value)
    return
  grantState.value = 'working'
  const ok = await applyGrant(pendingGrant.value)
  grantState.value = ok ? 'done' : 'idle'
  if (ok)
    pendingGrant.value = null
}

async function chooseOwnerKey(event: Event): Promise<void> {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file)
    return
  await importOwnerKeyFile(await file.text())
  if (ownerInput.value)
    ownerInput.value.value = ''
}
const { reconnectAndReload } = useReconnect()

const returnTo = computed(() => String(route.query.returnTo ?? '/wizard'))

// Updating the startup software is its own little job with its own
// failure, so it gets its own state rather than borrowing the ceremony's.
type UpdateState = 'idle' | 'writing' | 'restarting' | 'failed'
const updateState = ref<UpdateState>('idle')
const updateError = ref<string | null>(null)

const posture = computed(() => session.securityPosture)

// --- sealing (the one-way step) ------------------------------------
type SealState = 'idle' | 'writing' | 'restarting' | 'sealed' | 'failed'
const sealState = ref<SealState>('idle')
const sealError = ref<string | null>(null)
const showSeal = ref(false)
// Typed confirmation. A drone that cannot be un-sealed deserves more than
// a click that could be a mis-click.
const sealConfirmation = ref('')
const SEAL_PHRASE = 'SEAL'

// Sealing writes a parameter, so the set has to be loaded before the
// option can be offered - otherwise the button is there and does nothing.
onMounted(() => {
  if (session.connected && params.count === 0 && !params.loading)
    void params.load()
  // A key imported in an earlier session is still held by the browser.
  void loadOwnerKey()
})

const boardOptions = computed(() => params.params.get(LOCK_PARAM)?.value)
// Distinct from "not sealed": until the drone's settings are read we do
// not know, and must not offer a one-way action on a guess.
const sealKnown = computed(() => params.params.has(LOCK_PARAM))
const alreadySealed = computed(() => isLockRequested(boardOptions.value))
const sealBlocker = computed(() => (sealKnown.value
  ? lockBlocker({
      connected: session.connected,
      hasIdentity: posture.value === 'identified',
      options: boardOptions.value,
    })
  : 'not-connected'))
const canSeal = computed(() => sealBlocker.value === null && sealConfirmation.value.trim().toUpperCase() === SEAL_PHRASE)

/*
  What sealing settles about this drone's recordings, forever.

  After the seal the owner can never be changed, so whatever is true now
  is true for the life of the airframe. Three situations, and they are
  worth telling apart because two of them are losses an operator would
  not otherwise see coming:

    'matched'   — the drone is claimed, and the key loaded here opens it.
                  The operator demonstrably holds it at this moment,
                  which is the strongest thing this tool can honestly
                  check. It cannot see whether they have a backup, and
                  pretending to would be worse than saying nothing.
    'unclaimed' — nobody owns it, so it will record in the clear for
                  good.
    'mismatch'  — it is claimed to some other key. Whoever holds that key
                  can read its recordings and nobody else ever will.
 */
type SealOwnership = 'matched' | 'unclaimed' | 'mismatch'

const droneOwnerKey = computed(() => outcome.value?.ownerPublicKey ?? null)

const sealOwnership = computed<SealOwnership>(() => {
  const onDrone = droneOwnerKey.value
  if (onDrone === null)
    return 'unclaimed'
  const loaded = ownerKey.value?.publicKey
  if (loaded && loaded.length === onDrone.length && loaded.every((b, i) => b === onDrone[i]))
    return 'matched'
  return 'mismatch'
})

// Ask the drone to seal itself on its next start. The firmware refuses
// without a verified identity, so this mirrors that check rather than
// relying on it alone.
async function seal(): Promise<void> {
  const existing = params.params.get(LOCK_PARAM)
  if (!existing || sealBlocker.value !== null)
    return
  sealState.value = 'writing'
  sealError.value = null

  params.setEdit(LOCK_PARAM, withLockBit(existing.value))
  await params.apply()
  if (params.applyError !== null) {
    sealState.value = 'failed'
    sealError.value = 'Your drone didn\'t accept the change. Nothing has been sealed.'
    return
  }

  // Readout protection is raised at the next start, not now.
  sealState.value = 'restarting'
  await session.reboot()
  if (await reconnectAndReload() !== 'ok') {
    sealState.value = 'failed'
    sealError.value = 'Your drone was set to seal itself but didn\'t come back. Power-cycle it and reconnect to check.'
    return
  }
  sealState.value = isLockRequested(params.params.get(LOCK_PARAM)?.value) ? 'sealed' : 'failed'
  if (sealState.value === 'failed')
    sealError.value = 'The setting didn\'t stick. Your drone has not been sealed.'
}
const identity = computed(() => outcome.value?.identity ?? null)
const saved = ref(false)

// One of five situations, and they want different things said to them.
const situation = computed(() => {
  if (!session.connected || !session.hasHeartbeat)
    return 'disconnected'
  if (outcome.value)
    return 'done'
  if (phase.value === 'error')
    return 'stopped'
  if (busy.value)
    return 'working'
  if (updateState.value === 'writing' || updateState.value === 'restarting')
    return 'updating'
  return posture.value
})

// Ask the drone to install the startup software its firmware carries. The
// only route out of the part-way-upgraded state, and it needs no cable
// swap or DFU - see docs/SECURITY.md "Step 1 has two routes".
async function updateStartupSoftware(): Promise<void> {
  if (session.sysid === null)
    return
  updateState.value = 'writing'
  updateError.value = null

  const result = await flashRomfsBootloader(
    session.sendMessage,
    session.subscribeMessages,
    session.sysid,
    COMP_ID_AUTOPILOT,
  ).catch(() => null)

  if (result === null || !result.ok) {
    updateState.value = 'failed'
    updateError.value = result === null
      ? 'Your drone didn\'t answer. Check it\'s still plugged in, then try again.'
      : describeBootloaderUpdateFailure(result)
    return
  }

  // New startup software only takes effect on the next start, and the
  // posture is re-read automatically when the drone comes back.
  updateState.value = 'restarting'
  await session.reboot()
  const back = await reconnectAndReload()
  if (back !== 'ok') {
    updateState.value = 'failed'
    updateError.value = 'Your drone restarted but we couldn\'t reach it again. Check it\'s powered, then reconnect.'
    return
  }
  updateState.value = 'idle'
}

// Hand over the identity file. The operator keeps this; it holds the
// public half only, so nothing secret is in it.
function saveIdentityFile(): void {
  const result = outcome.value
  if (!result)
    return
  downloadText(result.text, result.filename)
  saved.value = true
}

function finish(): void {
  wizardProgress.markComplete(session.fcUid, 'sfd-enable', 'Your drone has its own identity, and you have the file that proves it.')
  router.push(returnTo.value)
}

function cancel(): void {
  router.push(returnTo.value)
}
</script>

<template>
  <div class="space-y-4">
    <!-- The visual is the identity itself: a mark derived from the drone's
         own key, so the operator can compare it against a saved file. It
         is drawn empty before there is one, so the shape of what's coming
         is on screen rather than a spinner that says nothing. -->
    <div class="border-default flex flex-col items-center gap-4 rounded-md border bg-elevated/50 p-6">
      <!-- "not made yet" only when that is actually true. A drone that
           already has an identity we simply haven't read yet gets an empty
           mark and no caption, rather than a caption contradicting the
           line right below it. -->
      <IdentityMark
        :public-key="identity?.publicKey ?? null"
        :pending="situation === 'secured'"
      />
    </div>

    <!-- Still checking, or nothing to say yet. -->
    <div v-if="situation === 'unknown'" class="text-muted flex items-center gap-2 text-sm">
      <UIcon name="i-lucide-loader-circle" class="size-4 animate-spin" />
      Checking what your drone can do…
    </div>

    <div v-else-if="situation === 'disconnected'">
      <UAlert
        color="neutral"
        icon="i-lucide-unplug"
        title="Connect your drone first"
        description="Plug it in and connect from the Connect page, then come back."
      />
    </div>

    <!-- Ordinary ArduPilot: nothing to do here, and say why. -->
    <div v-else-if="situation === 'unsecured'" class="space-y-3">
      <UAlert
        color="neutral"
        icon="i-lucide-shield-off"
        title="This drone can't have an identity yet"
        description="It isn't running SmallFastDrone's secured firmware. Install that first, then come back here."
      />
      <UButton to="/firmware" color="primary" icon="i-lucide-download">
        Go to firmware
      </UButton>
    </div>

    <!-- Part way through an upgrade. Actionable from right here. -->
    <div v-else-if="situation === 'bootloader-outdated'" class="space-y-3">
      <UAlert
        color="warning"
        icon="i-lucide-shield-alert"
        title="Your drone needs its startup software updated"
        description="It's running secured firmware, but the software that starts it is older and has nowhere to keep an identity. Your drone already carries the update — this takes a few seconds and restarts it once."
      />
      <UAlert
        v-if="updateState === 'failed' && updateError"
        color="error"
        icon="i-lucide-triangle-alert"
        :description="updateError"
      />
      <UButton color="primary" icon="i-lucide-refresh-cw" @click="updateStartupSoftware">
        Update startup software
      </UButton>
    </div>

    <div v-else-if="situation === 'updating'" class="text-muted flex items-center gap-2 text-sm">
      <UIcon name="i-lucide-loader-circle" class="size-4 animate-spin" />
      {{ updateState === 'writing'
        ? 'Updating your drone\'s startup software — don\'t unplug it.'
        : 'Restarting your drone…' }}
    </div>

    <!-- Ready, or already done and only the file is wanted. -->
    <div v-else-if="situation === 'secured' || situation === 'identified'" class="space-y-3">
      <UAlert
        v-if="situation === 'secured'"
        color="primary"
        icon="i-lucide-shield-check"
        title="Your drone is ready"
        description="It will make its own identity and keep the secret half for good — nobody, including us, can read it back out. This happens once and can't be redone."
      />
      <UAlert
        v-else
        color="primary"
        icon="i-lucide-shield-check"
        title="This drone already has its identity"
        description="It was given one before. You can save its file again — the identity itself won't change."
      />
      <!-- Who gets to read this drone's flight data. Optional on purpose:
           a drone can take its identity now and an owner later, right up
           until it is secured. -->
      <div class="border-default space-y-3 rounded-lg border p-4">
        <div class="flex items-start gap-3">
          <UIcon name="i-lucide-key-round" class="text-primary mt-0.5 size-5 shrink-0" />
          <div class="space-y-1">
            <p class="text-highlighted text-sm font-medium">
              Who can read this drone's flight data
            </p>
            <p class="text-muted text-sm">
              Load your key and this drone will scramble its flight recordings so only you can read them.
              Without one it records normally, and you can come back to this any time before you secure it.
            </p>
          </div>
        </div>

        <div v-if="ownerKey" class="flex flex-wrap items-center gap-3">
          <UBadge color="success" variant="subtle" icon="i-lucide-check">
            Your key is loaded
          </UBadge>
          <span class="text-muted font-mono text-xs">{{ ownerLabel }}</span>
          <UButton color="neutral" variant="ghost" size="xs" @click="forgetOwnerKey">
            Use a different one
          </UButton>
        </div>
        <div v-else class="space-y-2">
          <UButton color="neutral" variant="subtle" icon="i-lucide-folder-open" @click="ownerInput?.click()">
            Load your key
          </UButton>
          <p class="text-dimmed text-xs">
            Keep that file safe. It is the only copy, and once this drone is secured, nothing else will ever
            read what it records.
          </p>
        </div>
        <input
          ref="ownerInput"
          type="file"
          accept="application/json,.json"
          class="hidden"
          @change="chooseOwnerKey"
        >

        <!-- A permission SFD issued, for a drone nobody is standing next
             to. The confirmation is the point: this tool cannot check
             the signature, and the likely attack is on the person
             relaying the file, not on the crypto. -->
        <div class="border-default border-t pt-3">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <p class="text-muted text-xs">
              Sent a permission by SmallFastDrone? It can set this drone's owner without a bench.
            </p>
            <UButton color="neutral" variant="ghost" size="xs" icon="i-lucide-file-check" @click="grantInput?.click()">
              Open a permission…
            </UButton>
          </div>
          <input ref="grantInput" type="file" class="hidden" @change="chooseGrant">

          <div v-if="pendingGrant" class="border-default mt-2 space-y-2 rounded-md border p-3">
            <p class="text-highlighted text-sm font-medium">
              This would make {{ pendingGrantLabel }} the owner of this drone
            </p>
            <p class="text-muted text-xs">
              <template v-if="grantIsMine">
                That is the key you have loaded, so it is yours.
              </template>
              <template v-else>
                That is <strong>not</strong> the key you have loaded. Only whoever holds it will be able to
                read this drone's recordings. Don't go on unless you know it is yours.
              </template>
            </p>
            <div class="flex flex-wrap gap-2">
              <UButton
                :color="grantIsMine ? 'primary' : 'warning'"
                :loading="grantState === 'working'"
                size="sm"
                icon="i-lucide-check"
                @click="confirmGrant"
              >
                {{ grantIsMine ? 'Yes, that\'s my key' : 'Use it anyway' }}
              </UButton>
              <UButton color="neutral" variant="ghost" size="sm" @click="pendingGrant = null">
                Cancel
              </UButton>
            </div>
          </div>

          <UAlert
            v-if="grantParseError"
            class="mt-2"
            color="error"
            variant="subtle"
            icon="i-lucide-triangle-alert"
            :description="grantParseError"
          />
          <UAlert
            v-else-if="grantError"
            class="mt-2"
            color="error"
            variant="subtle"
            icon="i-lucide-triangle-alert"
            :description="grantError"
          />
          <UAlert
            v-else-if="grantState === 'done'"
            class="mt-2"
            color="success"
            variant="subtle"
            icon="i-lucide-check"
            description="This drone's owner is set. Recordings from now on are for that key."
          />
        </div>
        <UAlert
          v-if="ownerError"
          color="error"
          variant="subtle"
          icon="i-lucide-triangle-alert"
          :description="ownerError"
        />
      </div>

      <UButton color="primary" icon="i-lucide-shield-plus" @click="run">
        {{ situation === 'secured' ? 'Give this drone its identity' : 'Get its identity file' }}
      </UButton>
    </div>

    <div v-else-if="situation === 'working'" class="text-muted flex items-center gap-2 text-sm">
      <UIcon name="i-lucide-loader-circle" class="size-4 animate-spin" />
      {{ phase === 'generating'
        ? 'Your drone is making its identity — don\'t unplug it.'
        : phase === 'claiming'
          ? 'Telling your drone who to scramble its recordings for — don\'t unplug it.'
          : phase === 'verifying'
            ? 'Checking it came back the same…'
            : 'Asking your drone…' }}
    </div>

    <!-- Stopped. The ceremony names the reason; a missing identity region
         is the one with something to do about it, so offer that here too. -->
    <div v-else-if="situation === 'stopped'" class="space-y-3">
      <UAlert
        color="error"
        icon="i-lucide-triangle-alert"
        :title="failure === 'mismatch' ? 'Something didn\'t line up' : 'Couldn\'t finish'"
        :description="error ?? 'Your drone couldn\'t finish this.'"
      />
      <UButton
        v-if="failure === 'no-region'"
        color="primary"
        icon="i-lucide-refresh-cw"
        @click="updateStartupSoftware"
      >
        Update startup software
      </UButton>
      <UButton v-else color="neutral" variant="subtle" icon="i-lucide-rotate-ccw" @click="run">
        Try again
      </UButton>
    </div>

    <!-- Done. -->
    <div v-else-if="situation === 'done'" class="space-y-3">
      <UAlert
        color="success"
        icon="i-lucide-shield-check"
        :title="outcome?.generated ? 'Your drone has its identity' : 'Here is your drone\'s identity'"
        description="Save the file somewhere safe. It's how SmallFastDrone knows which drone is yours — it holds nothing secret, so it's safe to send us."
      />
      <div class="flex flex-wrap items-center gap-2">
        <UButton color="primary" icon="i-lucide-download" @click="saveIdentityFile">
          Save the identity file
        </UButton>
        <span v-if="saved" class="text-muted text-xs">Saved as {{ outcome?.filename }}</span>
      </div>
    </div>

    <!-- Sealing. Offered only once an identity exists and has been
         verified, and kept behind a disclosure so a one-way action never
         competes with the primary button. -->
    <div v-if="sealKnown && alreadySealed" class="border-default rounded-md border p-4">
      <div class="flex items-start gap-2">
        <UIcon name="i-lucide-lock" class="text-primary mt-0.5 size-4 shrink-0" />
        <p class="text-muted text-sm">
          <span class="text-default font-medium">This drone is sealed.</span>
          It won't give up its secret half to anyone reading the chip. Undoing
          that means wiping the drone completely, from the
          <RouterLink to="/wizard/sfd-recover" class="text-primary underline">
            remove-security wizard
          </RouterLink>.
        </p>
      </div>
    </div>

    <div v-else-if="sealBlocker === null || sealState !== 'idle'" class="border-default rounded-md border p-4">
      <button
        v-if="!showSeal && sealState === 'idle'"
        type="button"
        class="text-muted hover:text-default flex items-center gap-2 text-sm"
        @click="showSeal = true"
      >
        <UIcon name="i-lucide-lock" class="size-4" />
        Seal this drone's memory
        <UIcon name="i-lucide-chevron-down" class="size-3" />
      </button>

      <div v-else-if="sealState === 'idle'" class="space-y-3">
        <UAlert
          color="warning"
          icon="i-lucide-lock"
          title="Sealing can't be undone"
          description="Sealing stops anyone reading your drone's secret half off the chip — including you, and including us. The only way back is wiping the drone completely, which destroys this identity and everything else on it. Your drone works exactly as before; it just stops giving up its secret."
        />

        <!-- Sealing also fixes who can read this drone's recordings, for
             the life of the airframe. Said here because it is the last
             moment it can be changed, and because the two bad cases are
             losses an operator would not otherwise see coming. -->
        <UAlert
          v-if="sealOwnership === 'unclaimed'"
          color="warning"
          variant="subtle"
          icon="i-lucide-unlock"
          title="This drone has no owner, and after sealing it can never be given one"
          description="It will keep recording in the clear, so anyone who takes its card can read where it has flown. If you want its recordings scrambled to you, load your key and give it an owner before sealing."
        />
        <UAlert
          v-else-if="sealOwnership === 'mismatch'"
          color="error"
          variant="subtle"
          icon="i-lucide-key-round"
          title="This drone is owned by a key you don't have loaded"
          description="Only that key will ever read its recordings, and after sealing that can't be changed. Load the matching key and check the mark below before you seal — if it is lost, so is everything this drone records from now on."
        />
        <UAlert
          v-else
          color="success"
          variant="subtle"
          icon="i-lucide-key-round"
          :title="`Its recordings will be readable with your key ${ownerLabel}`"
          description="That key is the only one that will ever read them, and after sealing that can't be changed. Make sure the file it came from is somewhere you won't lose it."
        />
        <div>
          <p class="text-muted text-xs">
            Type <span class="text-default font-mono font-medium">{{ SEAL_PHRASE }}</span> to confirm.
          </p>
          <input
            v-model="sealConfirmation"
            type="text"
            class="border-default mt-1 rounded-md border bg-default px-2 py-1 font-mono text-sm"
            :placeholder="SEAL_PHRASE"
          >
        </div>
        <div class="flex flex-wrap gap-2">
          <UButton color="warning" icon="i-lucide-lock" :disabled="!canSeal" @click="seal">
            Seal this drone
          </UButton>
          <UButton color="neutral" variant="ghost" @click="showSeal = false">
            Not now
          </UButton>
        </div>
      </div>

      <div v-else-if="sealState === 'writing' || sealState === 'restarting'" class="text-muted flex items-center gap-2 text-sm">
        <UIcon name="i-lucide-loader-circle" class="size-4 animate-spin" />
        {{ sealState === 'writing' ? 'Sealing your drone…' : 'Restarting your drone…' }}
      </div>

      <!-- Honest about what was actually confirmed: the request is stored
           and survived a restart. The chip's protection level has no
           MAVLink representation, so claiming to have read it back would
           be a claim we cannot support. -->
      <UAlert
        v-else-if="sealState === 'sealed'"
        color="success"
        icon="i-lucide-lock"
        title="Your drone is sealed"
        description="It restarted with sealing switched on. From now on its secret half can't be read off the chip."
      />
      <div v-else class="space-y-2">
        <UAlert color="error" icon="i-lucide-triangle-alert" :description="sealError ?? 'Couldn\'t seal your drone.'" />
        <UButton color="neutral" variant="subtle" icon="i-lucide-rotate-ccw" @click="sealState = 'idle'">
          Back
        </UButton>
      </div>
    </div>

    <div class="flex items-center gap-2 pt-2">
      <UButton
        v-if="situation === 'done'"
        color="primary"
        trailing-icon="i-lucide-arrow-right"
        @click="finish"
      >
        Done
      </UButton>
      <UButton color="neutral" variant="ghost" :disabled="busy" @click="cancel">
        {{ situation === 'done' ? 'Back' : 'Cancel' }}
      </UButton>
    </div>
  </div>
</template>
