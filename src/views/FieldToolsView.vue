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

import type { FieldTool } from '../workflow/field-tools'
import type { ScriptStorageStatus } from '../workflow/script-storage'
import { onMounted, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { useSessionStore } from '../stores/session'
import { useUiStore } from '../stores/ui'
import { installableTools, lockedTools } from '../workflow/field-tools'
import { useLuaEngine } from '../workflow/lua-engine'
import { storageProblemFromError } from '../workflow/script-storage'

const session = useSessionStore()
const ui = useUiStore()
const lua = useLuaEngine()

type Scripting = 'unknown' | 'unavailable' | 'off' | 'on'
const scripting = ref<Scripting>('unknown')
const installed = ref<Record<string, boolean>>({})
// Tool id currently installing/removing, or 'scripting' while enabling it.
const busy = ref<string | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)

const available = installableTools()
const locked = lockedTools()

// Operator copy for an SD-card / storage problem (field tools live on the card).
function storageHint(status: ScriptStorageStatus): string {
  switch (status) {
    case 'no-card': return 'Your flight controller has no SD card to keep field tools on. Insert a formatted SD card, reconnect, and try again.'
    case 'unformatted': return 'Your flight controller can\'t read its SD card. Format it as FAT32, reconnect, and try again.'
    case 'readonly': return 'The SD card is locked. Slide its write-protect switch off, reconnect, and try again.'
    default: return 'Your flight controller can\'t store field tools right now. Check its SD card, reconnect, and try again.'
  }
}

// Probe scripting + which tools are already on the radio.
async function refresh() {
  if (!session.connected || !session.hasHeartbeat)
    return
  loading.value = true
  error.value = null
  try {
    const scr = await lua.checkScripting()
    scripting.value = !scr.available ? 'unavailable' : scr.enabled ? 'on' : 'off'
    if (scripting.value === 'on') {
      const next: Record<string, boolean> = {}
      for (const t of available)
        next[t.id] = await lua.isAppletInstalled(t.id)
      installed.value = next
    }
  }
  catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
  finally {
    loading.value = false
  }
}

// Turn scripting on (write + reboot + reconnect), checking for writable
// storage first so we don't reboot for nothing.
async function enableScripting() {
  busy.value = 'scripting'
  error.value = null
  try {
    const storage = await lua.checkScriptStorage()
    if (storage !== 'ok') {
      error.value = storageHint(storage)
      return
    }
    const ok = await lua.enableScripting()
    if (!ok) {
      error.value = 'Couldn\'t turn on scripting and reconnect. Try the Drone settings page.'
      return
    }
    await refresh()
  }
  catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
  finally {
    busy.value = null
  }
}

// Upload a tool's applet + shared modules and rescan (no reboot). Stays
// installed for field use until removed.
async function install(tool: FieldTool) {
  if (!tool.applet)
    return
  busy.value = tool.id
  error.value = null
  try {
    for (const m of tool.modules ?? [])
      await lua.uploadModule(m.name, m.source)
    await lua.uploadApplet(tool.id, tool.applet)
    await lua.restartScripting()
    installed.value = { ...installed.value, [tool.id]: true }
  }
  catch (e) {
    const problem = storageProblemFromError(e)
    error.value = problem ? storageHint(problem) : (e instanceof Error ? e.message : String(e))
  }
  finally {
    busy.value = null
  }
}

// Remove a tool's applet and rescan so it leaves the radio menu. Shared
// modules are left in place (other tools may use them).
async function remove(tool: FieldTool) {
  busy.value = tool.id
  error.value = null
  try {
    await lua.removeApplet(tool.id)
    await lua.restartScripting()
    installed.value = { ...installed.value, [tool.id]: false }
  }
  catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
  finally {
    busy.value = null
  }
}

onMounted(refresh)
watch(() => session.connected && session.hasHeartbeat, ok => ok && refresh())
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
        v-if="scripting === 'unavailable'"
        color="warning"
        icon="i-lucide-triangle-alert"
        title="Field tools aren't available on this firmware"
        description="This flight controller's firmware was built without scripting, so it can't run radio-menu tools."
      />

      <!-- Scripting off — offer to turn it on (reboot-required). -->
      <UCard v-else-if="scripting === 'off'">
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
            :loading="busy === 'scripting'"
            @click="enableScripting"
          >
            Turn on
          </UButton>
        </div>
      </UCard>

      <!-- Catalogue. -->
      <template v-else-if="scripting === 'on'">
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
                <UBadge v-if="installed[tool.id]" color="success" variant="subtle" size="sm" icon="i-lucide-check">
                  On the radio
                </UBadge>
              </div>
              <p class="text-muted mt-0.5 text-sm">
                {{ tool.description }}
              </p>
            </div>
            <UButton
              v-if="installed[tool.id]"
              color="neutral"
              variant="outline"
              size="sm"
              :loading="busy === tool.id"
              @click="remove(tool)"
            >
              Remove
            </UButton>
            <UButton
              v-else
              color="primary"
              size="sm"
              icon="i-lucide-download"
              :loading="busy === tool.id"
              @click="install(tool)"
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

      <UAlert v-if="error" color="warning" :description="error" />
    </template>
  </div>
</template>
