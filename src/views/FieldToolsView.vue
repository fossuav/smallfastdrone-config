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

// Field tools — the catalogue of things the operator can install onto the
// radio to run from the transmitter's CRSF menu with no laptop. Promoted out
// of the individual wizards (it's a cross-cutting capability) to a dedicated
// page reached from the app header. Selective: the operator installs only the
// tools they pick. Extensible: paid tools appear as locked "Pro" rows (same
// gating seam as the wizard library), custom operator-supplied applets come in
// behind expert mode. Install/remove go through the lua-engine (FTP upload +
// scripting restart), the consumer of the security uploader seam. The
// registry + asset model is in workflow/field-tools.ts; design in
// docs/WIZARDS.md "Field tools catalogue".

import { onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { isLxa, LxaError, lxaMatchesFc, parseLxaHeader } from '../protocol/lxa'
import { useFieldToolsStore } from '../stores/fieldTools'
import { useSessionStore } from '../stores/session'
import { useUiStore } from '../stores/ui'
import { installableTools, lockedTools } from '../workflow/field-tools'
import { useLuaEngine } from '../workflow/lua-engine'

const session = useSessionStore()
const lua = useLuaEngine()

/*
  Installing an applet SmallFastDrone sent for this drone.

  Not behind expert mode, unlike the custom-applet seam below it: a
  custom applet is one the operator wrote, and this is the opposite -
  something they cannot read or write, addressed to their airframe. It is
  an ordinary thing for a customer to be given.

  The tool never opens it. What it does check, before uploading
  anything, is the drone written on the outside - so choosing the wrong
  file says so immediately rather than after an upload, a scripting
  restart, and a warning in a log nobody is watching.
*/
const appletInput = ref<HTMLInputElement | null>(null)
const appletState = ref<'idle' | 'working' | 'done' | 'failed'>('idle')
const appletMessage = ref<string | null>(null)

async function chooseApplet(event: Event): Promise<void> {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (appletInput.value)
    appletInput.value.value = ''
  if (!file)
    return

  appletState.value = 'working'
  appletMessage.value = null
  try {
    const bytes = new Uint8Array(await file.arrayBuffer())
    if (!isLxa(bytes))
      throw new LxaError('That file isn\'t an applet from SmallFastDrone. They end in .lxa.')
    const header = parseLxaHeader(bytes)
    if (!lxaMatchesFc(header, session.fcUid)) {
      throw new LxaError(
        `That applet was made for a different drone (${header.uid.slice(0, 12)}…). `
        + 'Only the drone it was made for can read it.',
      )
    }
    await lua.installEncryptedApplet(file.name, bytes)
    await lua.restartScripting()
    appletState.value = 'done'
    appletMessage.value = `${file.name} is on your drone. It will run from now on.`
  }
  catch (e) {
    appletState.value = 'failed'
    appletMessage.value = e instanceof Error ? e.message : String(e)
  }
}
const ui = useUiStore()
// Shared install state — the same the wizard cards + header badge read.
// Connect-time refresh is owned by the app shell; this just covers landing
// here directly while already connected.
const field = useFieldToolsStore()

const available = installableTools()
const locked = lockedTools()

onMounted(() => {
  if (session.connected && session.hasHeartbeat)
    void field.refresh()
})
</script>

<template>
  <div class="mx-auto w-full max-w-3xl space-y-4">
    <header class="flex items-start gap-3">
      <UIcon name="i-lucide-radio" class="text-primary size-7" />
      <div class="flex-1">
        <h1 class="text-highlighted text-2xl font-semibold">
          Field tools
        </h1>
        <p class="text-muted text-sm">
          Install these on your radio to run them from the transmitter's own menu — no laptop at the field.
          <UTooltip text="Tools run as scripts on the flight controller and appear in your radio's CRSF menu. Install only the ones you want; remove them any time.">
            <UIcon name="i-lucide-info" class="text-muted ml-0.5 inline size-3.5 align-text-top" />
          </UTooltip>
        </p>
      </div>
    </header>

    <!-- Needs a live FC. -->
    <UCard v-if="!session.connected || !session.hasHeartbeat">
      <div class="text-muted py-8 text-center text-sm">
        <UIcon name="i-lucide-plug" class="mx-auto size-6" />
        <p class="mt-2">
          Connect your drone to manage field tools.
        </p>
        <RouterLink to="/" class="text-primary mt-2 inline-block">
          Go to Connect
        </RouterLink>
      </div>
    </UCard>

    <template v-else>
      <!-- Scripting unavailable on this build. -->
      <UAlert
        v-if="field.scripting === 'unavailable'"
        color="warning"
        icon="i-lucide-triangle-alert"
        title="Field tools aren't available on this firmware"
        description="This flight controller's firmware was built without scripting, so it can't run radio-menu tools."
      />

      <!-- Scripting off — offer to turn it on (reboot-required). -->
      <UCard v-else-if="field.scripting === 'off'">
        <div class="flex items-center justify-between gap-3">
          <div>
            <p class="text-highlighted font-medium">
              Turn on scripting to use field tools
            </p>
            <p class="text-muted text-sm">
              Field tools run as scripts. We'll switch scripting on — it restarts your drone for a few seconds and reconnects automatically.
            </p>
          </div>
          <UButton
            color="primary"
            icon="i-lucide-power"
            :loading="field.busy === 'scripting'"
            @click="field.enableScripting"
          >
            Turn on
          </UButton>
        </div>
      </UCard>

      <!-- Catalogue. -->
      <template v-else-if="field.scripting === 'on'">
        <p class="text-muted text-xs">
          <UIcon name="i-lucide-circle-check" class="text-success mr-1 inline size-3.5 align-text-top" />
          Scripting is on.
        </p>

        <!-- Installable tools. -->
        <ul class="space-y-2">
          <li
            v-for="tool in available"
            :key="tool.id"
            class="border-default flex items-start gap-3 rounded-lg border bg-elevated/30 p-3"
          >
            <div class="bg-primary/10 text-primary flex size-10 shrink-0 items-center justify-center rounded-md">
              <UIcon :name="tool.icon" class="size-6" />
            </div>
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2">
                <h3 class="text-highlighted font-semibold">
                  {{ tool.name }}
                </h3>
                <UBadge v-if="field.installed[tool.id]" color="success" variant="subtle" size="sm" icon="i-lucide-check">
                  On the radio
                </UBadge>
              </div>
              <p class="text-muted mt-0.5 text-sm">
                {{ tool.description }}
              </p>
            </div>
            <UButton
              v-if="field.installed[tool.id]"
              color="neutral"
              variant="outline"
              size="sm"
              :loading="field.busy === tool.id"
              @click="field.remove(tool)"
            >
              Remove
            </UButton>
            <UButton
              v-else
              color="primary"
              size="sm"
              icon="i-lucide-download"
              :loading="field.busy === tool.id"
              @click="field.install(tool)"
            >
              Install
            </UButton>
          </li>
        </ul>

        <!-- Paid (locked) tools — the commercial seam. -->
        <template v-if="locked.length > 0">
          <h2 class="text-muted mt-4 text-xs font-medium tracking-wide uppercase">
            Pro field tools
          </h2>
          <ul class="space-y-2">
            <li
              v-for="tool in locked"
              :key="tool.id"
              class="border-default flex items-start gap-3 rounded-lg border bg-elevated/50 p-3 opacity-75"
            >
              <div class="bg-secondary/10 text-secondary flex size-10 shrink-0 items-center justify-center rounded-md">
                <UIcon :name="tool.icon" class="size-6" />
              </div>
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2">
                  <h3 class="text-highlighted font-semibold">
                    {{ tool.name }}
                  </h3>
                  <UBadge color="warning" variant="solid" size="sm">
                    Pro
                  </UBadge>
                </div>
                <p class="text-muted mt-0.5 text-sm">
                  {{ tool.description }}
                </p>
                <p v-if="tool.unlock_blurb" class="text-muted mt-0.5 text-xs italic">
                  {{ tool.unlock_blurb }}
                </p>
              </div>
              <UButton color="neutral" variant="outline" size="sm" icon="i-lucide-lock" disabled>
                Unlock
              </UButton>
            </li>
          </ul>
        </template>

        <!-- Something SFD made for this airframe. Ordinary, so not
             behind expert mode. -->
        <div class="border-default mt-2 space-y-2 rounded-lg border p-3">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div class="min-w-48 flex-1">
              <p class="text-default text-sm font-medium">
                An applet from SmallFastDrone
              </p>
              <p class="text-muted text-xs">
                Made for this drone and scrambled so only it can read them — not us, not you, not
                another drone.
              </p>
            </div>
            <UButton
              :disabled="!session.connected || appletState === 'working'"
              :loading="appletState === 'working'"
              color="neutral"
              variant="outline"
              size="sm"
              icon="i-lucide-file-plus"
              @click="appletInput?.click()"
            >
              Install one…
            </UButton>
          </div>
          <input ref="appletInput" type="file" accept=".lxa" class="hidden" @change="chooseApplet">
          <UAlert
            v-if="appletState === 'done'"
            color="success"
            variant="subtle"
            icon="i-lucide-check"
            :description="appletMessage ?? ''"
          />
          <UAlert
            v-else-if="appletState === 'failed'"
            color="error"
            variant="subtle"
            icon="i-lucide-triangle-alert"
            :description="appletMessage ?? ''"
          />
        </div>

        <!-- Custom (operator-supplied) — expert-only seam. -->
        <div v-if="ui.expert" class="border-default mt-2 flex items-center justify-between gap-3 rounded-lg border border-dashed p-3">
          <div>
            <p class="text-default text-sm font-medium">
              Add your own applet
            </p>
            <p class="text-muted text-xs">
              Install a custom Lua field tool you've written. Coming soon.
            </p>
          </div>
          <UButton color="neutral" variant="outline" size="sm" icon="i-lucide-plus" disabled>
            Add…
          </UButton>
        </div>
      </template>

      <UAlert v-if="field.error" color="warning" :description="field.error" />
    </template>
  </div>
</template>
