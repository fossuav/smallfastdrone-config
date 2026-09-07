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

// Flight logs. Pulling them off the drone is Phase 4 and isn't here yet;
// what is here is the half that already has something to do, because a
// secured drone writes recordings nobody can read without the operator's
// key — including every other log tool. An operator who copies one off
// the card has a file that looks like nothing, and this is where it
// becomes a flight log again.

import { computed, onMounted, ref } from 'vue'
import { openSfx, parseSfxHeader, SFX_FLAG_STREAM } from '../protocol/sfx'
import { parseIdentityFile } from '../workflow/drone-identity'
import { useOwnerKey } from '../workflow/use-owner-key'

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

onMounted(() => {
  void loadOwnerKey()
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
  if (!file || ownerKey.value === null || identityPublicKey.value === null)
    return

  status.value = 'working'
  message.value = null
  opened.value = null
  try {
    const bytes = new Uint8Array(await file.arrayBuffer())
    const header = parseSfxHeader(bytes)
    const { plaintext } = await openSfx(bytes, ownerKey.value, identityPublicKey.value)
    opened.value = { name: file.name.replace(/\.[^.]*$/, '') || 'flight', bytes: plaintext }
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
      A secured drone scrambles what it records, so only you can read it. Copy a recording off
      the drone's card and open it here to get an ordinary flight log back.
    </p>

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
        :disabled="!ready || status === 'working'"
        color="primary"
        icon="i-lucide-file-search"
        @click="recordingInput?.click()"
      >
        Open a recording
      </UButton>
      <input ref="recordingInput" type="file" class="hidden" @change="chooseRecording">
      <p v-if="!ready" class="text-dimmed text-xs">
        Load both files above first.
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
      Downloading recordings from the drone itself is still to come.
    </p>
  </UCard>
</template>
