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

// Field-tools install state — the single source of truth for which field
// tools are currently on the radio. Shared so the Field tools page, the
// per-wizard indicators in the library, and the header badge all agree
// (rather than each querying the FC independently and drifting). Install /
// remove / enable-scripting live here too, so a change made on the Field page
// is immediately reflected on the wizard cards. Owns no UI.

import type { FieldTool } from '../workflow/field-tools'
import type { ScriptStorageStatus } from '../workflow/script-storage'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { installableTools } from '../workflow/field-tools'
import { useLuaEngine } from '../workflow/lua-engine'
import { storageProblemFromError } from '../workflow/script-storage'

export type ScriptingState = 'unknown' | 'unavailable' | 'off' | 'on'

export const useFieldToolsStore = defineStore('fieldTools', () => {
  const lua = useLuaEngine()

  const scripting = ref<ScriptingState>('unknown')
  // Tool id -> present on the FC. Only meaningful while connected + scripting on.
  const installed = ref<Record<string, boolean>>({})
  // Tool id currently installing/removing, or 'scripting' while enabling it.
  const busy = ref<string | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)

  const installedCount = computed(() => Object.values(installed.value).filter(Boolean).length)
  function isInstalled(id: string): boolean {
    return installed.value[id] === true
  }

  // Operator copy for an SD-card / storage problem (field tools live on the card).
  function storageHint(status: ScriptStorageStatus): string {
    switch (status) {
      case 'no-card': return 'Your flight controller has no SD card to keep field tools on. Insert a formatted SD card, reconnect, and try again.'
      case 'unformatted': return 'Your flight controller can\'t read its SD card. Format it as FAT32, reconnect, and try again.'
      case 'readonly': return 'The SD card is locked. Slide its write-protect switch off, reconnect, and try again.'
      default: return 'Your flight controller can\'t store field tools right now. Check its SD card, reconnect, and try again.'
    }
  }

  // Probe scripting + which tools are on the radio, in one directory listing.
  // Coalesced: several surfaces (App shell, the Field page, the library) all
  // refresh on connect, and FTP isn't concurrency-safe — overlapping listings
  // wedge the link. So a refresh already in flight is shared, never doubled.
  let inflight: Promise<void> | null = null
  async function doRefresh() {
    loading.value = true
    error.value = null
    try {
      const scr = await lua.checkScripting()
      scripting.value = !scr.available ? 'unavailable' : scr.enabled ? 'on' : 'off'
      installed.value = scripting.value === 'on'
        ? await lua.installedApplets(installableTools().map(t => t.id))
        : {}
    }
    catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
    }
    finally {
      loading.value = false
    }
  }
  function refresh(): Promise<void> {
    inflight ??= doRefresh().finally(() => {
      inflight = null
    })
    return inflight
  }

  // Clear when the link drops / we switch drones, so a stale install state
  // never shows for a drone that isn't there.
  function reset() {
    scripting.value = 'unknown'
    installed.value = {}
    busy.value = null
    error.value = null
  }

  // Turn scripting on (write + reboot + reconnect), storage-checked first.
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

  // Upload a tool's applet + shared modules and rescan (no reboot).
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

  // Remove a tool's applet and rescan so it leaves the radio menu.
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

  return {
    scripting,
    installed,
    busy,
    loading,
    error,
    installedCount,
    isInstalled,
    refresh,
    reset,
    enableScripting,
    install,
    remove,
  }
})
