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

// Firmware view — operator-supplied .apj file picker → parsed metadata
// + board-id confirm → confirm + flash → progress → result. v1 covers
// the bootloader path (over the existing USB-serial connection); DFU
// (recovery / fresh-chip) is a follow-on slice. See docs/FIRMWARE.md.
//
// Test-on-hardware notes:
//   - Connect normally first, then visit this page.
//   - The flash will: reboot the FC to bootloader, take over the serial
//     port at 115200, sync, erase, program, verify, reboot, and reconnect
//     MAVLink. Watch the phase line; "programming" shows the % bar.
//   - On Chromium the WebSerial permission should carry across the
//     bootloader's re-enumeration as long as VID:PID is unchanged
//     (true for most ChibiOS-based AP boards). If it isn't, the
//     reopen will time out — surface an error and the operator can
//     reconnect manually.

import type { ApjFirmware } from '../protocol/apj'
import { computed, ref } from 'vue'
import { parseApj } from '../protocol/apj'
import { useSessionStore } from '../stores/session'
import { useFirmwareFlash } from '../workflow/firmware'

const session = useSessionStore()
// Destructure so the refs auto-unwrap in the template (Vue only
// auto-unwraps top-level setup bindings).
const { phase, progress, error: flashError, flash, reset } = useFirmwareFlash()

// The parsed file (null until the operator picks one). Errors from
// parseApj land in `parseError` and are surfaced as operator copy.
const firmware = ref<ApjFirmware | null>(null)
const filename = ref<string>('')
const parseError = ref<string | null>(null)

// Hidden <input type=file>; the visible button triggers it.
const fileInput = ref<HTMLInputElement | null>(null)

function openPicker() {
  fileInput.value?.click()
}

async function onFileChosen(ev: Event) {
  const input = ev.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file)
    return
  filename.value = file.name
  parseError.value = null
  firmware.value = null
  try {
    const json = await file.text()
    firmware.value = await parseApj(json)
    reset()
  }
  catch (e) {
    parseError.value = e instanceof Error ? e.message : String(e)
  }
  // Clear the input so the same file can be re-picked.
  input.value = ''
}

async function startFlash() {
  if (!firmware.value)
    return
  try {
    await flash(firmware.value)
  }
  catch {
    // flashError is already populated; UI reads from it.
  }
}

const canStart = computed(() =>
  firmware.value !== null
  && session.connected
  && session.hasHeartbeat
  && session.transport.kind === 'webserial'
  && (phase.value === 'idle' || phase.value === 'done' || phase.value === 'error'),
)

const phaseLabel = computed(() => {
  switch (phase.value) {
    case 'idle': return ''
    case 'rebooting-to-bootloader': return 'Restarting your drone in upload mode…'
    case 'syncing': return 'Reaching the bootloader…'
    case 'verifying-board': return 'Checking this firmware matches your drone…'
    case 'erasing': return 'Erasing the old firmware…'
    case 'programming': return 'Writing the new firmware…'
    case 'verifying': return 'Verifying what was written…'
    case 'restarting': return 'Restarting your drone…'
    case 'reconnecting': return 'Reconnecting…'
    case 'done': return 'Done — your drone is running the new firmware.'
    case 'error': return 'Something went wrong.'
  }
  return ''
})

const isRunning = computed(() =>
  phase.value !== 'idle' && phase.value !== 'done' && phase.value !== 'error',
)
</script>

<template>
  <div class="mx-auto w-full max-w-3xl space-y-4">
    <header class="flex items-center gap-3">
      <UIcon name="i-lucide-cpu" class="text-primary size-7" />
      <div>
        <h1 class="text-highlighted text-2xl font-semibold">
          Firmware
        </h1>
        <p class="text-muted text-sm">
          Install a SmallFastDrone firmware image. Pick the file you downloaded; we'll confirm it matches your drone and flash it.
        </p>
      </div>
    </header>

    <!-- Needs a live MAVLink connection over USB serial — the bootloader
         path piggy-backs the same port. -->
    <UCard v-if="!session.connected || !session.hasHeartbeat">
      <div class="text-muted py-8 text-center text-sm">
        <UIcon name="i-lucide-plug" class="mx-auto size-6" />
        <p class="mt-2">
          Connect your drone before installing firmware.
        </p>
      </div>
    </UCard>

    <UAlert
      v-else-if="session.transport.kind !== 'webserial'"
      color="warning"
      icon="i-lucide-triangle-alert"
      title="Firmware install needs a USB connection"
      description="You're connected over the SITL bridge. Firmware install talks directly to the FC's bootloader over USB — connect over USB serial to use it."
    />

    <template v-else>
      <!-- Step 1: pick a file. -->
      <UCard>
        <div class="flex items-start justify-between gap-3">
          <div>
            <h2 class="text-highlighted font-semibold">
              Choose a firmware file
            </h2>
            <p class="text-muted mt-1 text-sm">
              SmallFastDrone firmware ships as a <code class="bg-muted rounded px-1 py-0.5">.apj</code> file. Drop the one you downloaded here.
            </p>
          </div>
          <UButton color="primary" icon="i-lucide-file-plus" :disabled="isRunning" @click="openPicker">
            Pick a .apj file
          </UButton>
          <input
            ref="fileInput"
            type="file"
            accept=".apj,application/json"
            class="hidden"
            @change="onFileChosen"
          >
        </div>

        <UAlert v-if="parseError" color="warning" class="mt-3" :description="parseError" />

        <div v-if="firmware" class="mt-4 space-y-2 text-sm">
          <p class="text-default">
            <span class="text-muted">File:</span>
            <span class="text-default ml-1 font-medium">{{ filename }}</span>
          </p>
          <p class="text-default">
            <span class="text-muted">For:</span>
            <span class="text-default ml-1 font-medium">{{ firmware.description }}</span>
            <span class="text-muted ml-1">(board {{ firmware.boardId }})</span>
          </p>
          <p v-if="firmware.summary" class="text-default">
            <span class="text-muted">Version:</span>
            <span class="text-default ml-1 font-medium">{{ firmware.summary }}</span>
          </p>
          <p class="text-default">
            <span class="text-muted">Image:</span>
            <span class="text-default ml-1 font-medium">{{ (firmware.imageSize / 1024).toFixed(1) }} KB</span>
          </p>
        </div>
      </UCard>

      <!-- Step 2: confirm + flash. -->
      <UCard v-if="firmware">
        <div class="flex items-start justify-between gap-3">
          <div>
            <h2 class="text-highlighted font-semibold">
              Ready to install
            </h2>
            <p class="text-muted mt-1 text-sm">
              Your drone will restart twice — once into upload mode, then back into normal mode on the new firmware. Don't unplug it until "Done" appears.
            </p>
          </div>
          <UButton
            color="primary"
            icon="i-lucide-download"
            :loading="isRunning"
            :disabled="!canStart"
            @click="startFlash"
          >
            Install firmware
          </UButton>
        </div>

        <!-- Progress / phase. -->
        <div v-if="phaseLabel" class="mt-4 space-y-2">
          <div class="flex items-center gap-2 text-sm">
            <UIcon
              v-if="phase === 'done'"
              name="i-lucide-circle-check"
              class="text-success size-4"
            />
            <UIcon
              v-else-if="phase === 'error'"
              name="i-lucide-triangle-alert"
              class="text-warning size-4"
            />
            <UIcon
              v-else
              name="i-lucide-loader-circle"
              class="text-muted size-4 animate-spin"
            />
            <span :class="phase === 'done' ? 'text-success font-medium' : 'text-default'">
              {{ phaseLabel }}
            </span>
          </div>
          <UProgress
            v-if="phase === 'programming' && progress !== null"
            :model-value="Math.round((progress ?? 0) * 100)"
            color="primary"
            size="sm"
          />
          <UAlert
            v-if="flashError"
            color="warning"
            :description="flashError"
          />
        </div>
      </UCard>
    </template>
  </div>
</template>
