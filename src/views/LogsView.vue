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

// Flight logs: take them off the drone, and turn a secured drone's
// recordings back into readable ones.
//
// The two halves are separate on purpose. A recording can be opened
// without the drone present — an operator who pulled the card, or who
// was sent a file — and the drone can be emptied without any key,
// because an unsecured drone's logs need none.

import type { FlightLog } from '../workflow/logs'
import { computed, onMounted, ref } from 'vue'
import { MavFtp } from '../protocol/ftp'
import { isSfx, openSfx, parseSfxHeader, SFX_FLAG_STREAM } from '../protocol/sfx'
import { useSessionStore } from '../stores/session'
import { parseIdentityFile } from '../workflow/drone-identity'
import { downloadFlightLog, formatSize, listFlightLogs } from '../workflow/logs'
import { useOwnerKey } from '../workflow/use-owner-key'

const COMP_ID_AUTOPILOT = 1

const session = useSessionStore()

const { ownerKey, ownerLabel, ownerError, loadOwnerKey, importOwnerKeyFile, forgetOwnerKey } = useOwnerKey()

const keyInput = ref<HTMLInputElement | null>(null)
const identityInput = ref<HTMLInputElement | null>(null)
const recordingInput = ref<HTMLInputElement | null>(null)

// The drone's identity is half the agreement, not paperwork: a recording
// cannot be opened without knowing which drone claims to have made it.
const identityPublicKey = ref<Uint8Array | null>(null)
const identityName = ref<string | null>(null)
const identityError = ref<string | null>(null)

const status = ref<'idle' | 'working' | 'done' | 'failed'>('idle')
const message = ref<string | null>(null)
const opened = ref<{ name: string, bytes: Uint8Array } | null>(null)

const ready = computed(() => ownerKey.value !== null && identityPublicKey.value !== null)

// What's on the drone.
const logs = ref<FlightLog[]>([])
const listState = ref<'idle' | 'listing' | 'listed' | 'failed'>('idle')
const listError = ref<string | null>(null)
const fetching = ref<string | null>(null)
const progress = ref(0)

function ftp(): MavFtp | null {
  if (!session.connected || session.sysid === null)
    return null
  return new MavFtp(session.sendMessage, session.subscribeMessages, session.sysid, COMP_ID_AUTOPILOT)
}

async function refresh(): Promise<void> {
  const client = ftp()
  if (!client)
    return
  listState.value = 'listing'
  listError.value = null
  try {
    logs.value = await listFlightLogs(client)
    listState.value = 'listed'
  }
  catch (e) {
    listState.value = 'failed'
    listError.value = e instanceof Error ? e.message : String(e)
  }
}

// Fetch one and treat it exactly as a file the operator picked, so a
// scrambled recording off the drone and one off the card go through the
// same path.
async function fetchLog(log: FlightLog): Promise<void> {
  const client = ftp()
  if (!client)
    return
  fetching.value = log.name
  progress.value = 0
  status.value = 'working'
  message.value = null
  opened.value = null
  try {
    const bytes = await downloadFlightLog(client, log, (received, total) => {
      progress.value = total > 0 ? Math.round((received / total) * 100) : 0
    })
    await handleRecording(bytes, log.name)
  }
  catch (e) {
    status.value = 'failed'
    message.value = e instanceof Error ? e.message : String(e)
  }
  finally {
    fetching.value = null
  }
}

onMounted(() => {
  void loadOwnerKey()
  if (session.connected)
    void refresh()
})

async function chooseKey(event: Event): Promise<void> {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (file)
    await importOwnerKeyFile(await file.text())
  if (keyInput.value)
    keyInput.value.value = ''
}

async function chooseIdentity(event: Event): Promise<void> {
  const file = (event.target as HTMLInputElement).files?.[0]
  identityError.value = null
  if (file) {
    try {
      const identity = parseIdentityFile(await file.text())
      identityPublicKey.value = new Uint8Array(
        Uint8Array.from(atob(identity.public_key), c => c.charCodeAt(0)),
      )
      identityName.value = identity.uid
    }
    catch (e) {
      identityError.value = e instanceof Error ? e.message : String(e)
    }
  }
  if (identityInput.value)
    identityInput.value.value = ''
}

// Open one recording. Everything that can go wrong here says which drone
// or which key it thinks is wrong, because "couldn't open it" leaves an
// operator with three files and no idea which one to change.
async function chooseRecording(event: Event): Promise<void> {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (recordingInput.value)
    recordingInput.value.value = ''
  if (!file)
    return
  status.value = 'working'
  message.value = null
  opened.value = null
  await handleRecording(new Uint8Array(await file.arrayBuffer()), file.name)
}

// One path for both sources. A recording that isn't scrambled needs no
// key and is handed straight back — an operator with an ordinary drone
// should not be asked for one.
async function handleRecording(bytes: Uint8Array, filename: string): Promise<void> {
  const stem = filename.replace(/\.[^.]*$/, '') || 'flight'
  try {
    if (!isSfx(bytes)) {
      opened.value = { name: stem, bytes }
      message.value = 'This recording isn\'t scrambled, so there was nothing to unlock.'
      status.value = 'done'
      return
    }
    if (ownerKey.value === null || identityPublicKey.value === null) {
      status.value = 'failed'
      message.value = 'This recording is scrambled. Load your key and the drone\'s identity file to open it.'
      return
    }
    const header = parseSfxHeader(bytes)
    const { plaintext } = await openSfx(bytes, ownerKey.value, identityPublicKey.value)
    opened.value = { name: stem, bytes: plaintext }
    message.value = (header.flags & SFX_FLAG_STREAM) === SFX_FLAG_STREAM
      ? 'Opened. The recording is readable but not tamper-proof — it can\'t be, because a drone that loses power mid-flight never gets to sign off.'
      : 'Opened.'
    status.value = 'done'
  }
  catch (e) {
    status.value = 'failed'
    message.value = e instanceof Error ? e.message : String(e)
  }
}

// Hand the plain log back to the operator for whatever reads logs.
function save(): void {
  if (!opened.value)
    return
  const url = URL.createObjectURL(new Blob([opened.value.bytes as BlobPart], { type: 'application/octet-stream' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `${opened.value.name}.bin`
  anchor.click()
  URL.revokeObjectURL(url)
}
</script>

<template>
  <UCard class="mx-auto w-full max-w-2xl">
    <template #header>
      <div class="flex items-center gap-3">
        <UIcon name="i-lucide-file-text" class="text-primary size-6" />
        <h1 class="text-highlighted text-xl font-semibold">
          Flight logs
        </h1>
      </div>
    </template>

    <p class="text-muted">
      Take flight recordings off your drone. A secured drone scrambles what it records, so only
      you can read it — load your key below and it comes back as an ordinary flight log.
    </p>

    <!-- On the drone. Needs no key: an unsecured drone's recordings need
         none, and a secured one's are unscrambled after the download. -->
    <div class="border-default mt-4 rounded-lg border p-3">
      <div class="flex flex-wrap items-center gap-3">
        <UIcon name="i-lucide-hard-drive" class="text-primary size-5 shrink-0" />
        <p class="text-highlighted min-w-40 flex-1 text-sm font-medium">
          On your drone
        </p>
        <UButton
          :disabled="!session.connected || listState === 'listing'"
          color="neutral"
          variant="subtle"
          size="sm"
          icon="i-lucide-refresh-cw"
          @click="refresh"
        >
          {{ listState === 'listing' ? 'Looking…' : 'Look again' }}
        </UButton>
      </div>

      <p v-if="!session.connected" class="text-dimmed mt-2 text-xs">
        Connect to your drone to see what it has recorded.
      </p>
      <UAlert
        v-else-if="listState === 'failed'"
        class="mt-2"
        color="error"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        :description="listError ?? ''"
      />
      <p v-else-if="listState === 'listed' && logs.length === 0" class="text-dimmed mt-2 text-xs">
        Nothing recorded yet — or there's no card in the drone.
      </p>

      <ul v-else-if="logs.length > 0" class="divide-default mt-2 divide-y">
        <li v-for="log in logs" :key="log.name" class="flex items-center gap-3 py-2">
          <UIcon name="i-lucide-file-text" class="text-dimmed size-4 shrink-0" />
          <span class="text-highlighted flex-1 font-mono text-sm">{{ log.name }}</span>
          <span class="text-muted text-xs">{{ formatSize(log.size) }}</span>
          <UButton
            :disabled="fetching !== null"
            :loading="fetching === log.name"
            color="neutral"
            variant="ghost"
            size="xs"
            icon="i-lucide-download"
            @click="fetchLog(log)"
          >
            {{ fetching === log.name ? `${progress}%` : 'Get it' }}
          </UButton>
        </li>
      </ul>
      <p v-if="logs.length > 0" class="text-dimmed mt-2 text-xs">
        A recording still being written shows the size it had when it was last saved.
      </p>
    </div>

    <div class="mt-4 space-y-3">
      <!-- Both halves are needed, and the reason differs, so they are
           asked for separately rather than as one blurred step. -->
      <div class="border-default flex flex-wrap items-center gap-3 rounded-lg border p-3">
        <UIcon name="i-lucide-key-round" class="text-primary size-5 shrink-0" />
        <div class="min-w-40 flex-1">
          <p class="text-highlighted text-sm font-medium">
            Your key
          </p>
          <p class="text-dimmed text-xs">
            The one you kept when you secured the drone.
          </p>
        </div>
        <template v-if="ownerKey">
          <UBadge color="success" variant="subtle" icon="i-lucide-check">
            Loaded
          </UBadge>
          <span class="text-muted font-mono text-xs">{{ ownerLabel }}</span>
          <UButton color="neutral" variant="ghost" size="xs" @click="forgetOwnerKey">
            Change
          </UButton>
        </template>
        <UButton v-else color="neutral" variant="subtle" size="sm" icon="i-lucide-folder-open" @click="keyInput?.click()">
          Load
        </UButton>
        <input ref="keyInput" type="file" accept="application/json,.json" class="hidden" @change="chooseKey">
      </div>

      <div class="border-default flex flex-wrap items-center gap-3 rounded-lg border p-3">
        <UIcon name="i-lucide-fingerprint" class="text-primary size-5 shrink-0" />
        <div class="min-w-40 flex-1">
          <p class="text-highlighted text-sm font-medium">
            The drone's identity file
          </p>
          <p class="text-dimmed text-xs">
            Saved when the drone was given its identity. A recording can't be opened without it.
          </p>
        </div>
        <template v-if="identityPublicKey">
          <UBadge color="success" variant="subtle" icon="i-lucide-check">
            Loaded
          </UBadge>
          <span class="text-muted font-mono text-xs">{{ identityName?.slice(0, 12) }}</span>
        </template>
        <UButton color="neutral" variant="subtle" size="sm" icon="i-lucide-folder-open" @click="identityInput?.click()">
          {{ identityPublicKey ? 'Change' : 'Load' }}
        </UButton>
        <input ref="identityInput" type="file" accept="application/json,.json" class="hidden" @change="chooseIdentity">
      </div>

      <UAlert v-if="ownerError" color="error" variant="subtle" icon="i-lucide-triangle-alert" :description="ownerError" />
      <UAlert v-if="identityError" color="error" variant="subtle" icon="i-lucide-triangle-alert" :description="identityError" />

      <UButton
        :disabled="status === 'working'"
        color="primary"
        icon="i-lucide-file-search"
        @click="recordingInput?.click()"
      >
        Open a recording from a file
      </UButton>
      <input ref="recordingInput" type="file" class="hidden" @change="chooseRecording">
      <p v-if="!ready" class="text-dimmed text-xs">
        A scrambled recording needs both files above. One that isn't scrambled opens without them.
      </p>

      <UAlert
        v-if="status === 'done'"
        color="success"
        icon="i-lucide-check"
        title="That's your flight log"
        :description="message ?? ''"
      />
      <UAlert
        v-else-if="status === 'failed'"
        color="error"
        icon="i-lucide-triangle-alert"
        title="Couldn't open it"
        :description="message ?? ''"
      />
      <UButton v-if="status === 'done'" color="neutral" variant="subtle" icon="i-lucide-download" @click="save">
        Save the flight log
      </UButton>
    </div>

    <p class="text-dimmed mt-6 text-xs">
      Flight logs are read with a log analysis tool — this page gets them off the drone and
      makes them readable.
    </p>
  </UCard>
</template>
