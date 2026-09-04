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

// Top-level application shell: brand header (logo + nav + message bell +
// expert toggle) above a routed main area. Reads the route table to
// render the nav; filters out routes flagged expert:true unless the
// operator has enabled expert mode in the UI store.

import { computed, watch } from 'vue'
import { RouterLink, RouterView } from 'vue-router'
import logoUrl from './assets/sfd-logo.png'
import { routes } from './router'
import { useFieldToolsStore } from './stores/fieldTools'
import { useSessionStore } from './stores/session'
import { useUiStore } from './stores/ui'
import MessageBell from './ui/components/MessageBell.vue'
import SecurityBadge from './ui/components/SecurityBadge.vue'

const ui = useUiStore()
const session = useSessionStore()
const field = useFieldToolsStore()

// Keep field-install state current app-wide so the header badge + the wizard
// cards reflect the live FC: refresh on (re)connect, clear on disconnect.
watch(
  () => session.connected && session.hasHeartbeat,
  (ok) => {
    if (ok)
      void field.refresh()
    else
      field.reset()
  },
)

// Project the route table into the nav menu's expected shape. Routes
// without a `meta.label` are not navigable (none today, but the filter
// keeps the shape robust); routes flagged expert:true only show when
// expert mode is on.
const navItems = computed(() =>
  routes
    .filter(r => r.meta?.label)
    .filter(r => !r.meta?.expert || ui.expert)
    .map(r => ({
      label: r.meta!.label as string,
      icon: r.meta!.icon as string,
      // navTo lets a route serve its real path while the nav link points
      // somewhere else (e.g. "Bringup" routes to the ribbon, /wizard the
      // library stays reachable via in-page links).
      to: (r.meta?.navTo as string | undefined) ?? r.path,
    })),
)
</script>

<template>
  <UApp>
    <div class="min-h-dvh flex flex-col bg-default">
      <header class="border-b border-default bg-elevated">
        <div class="mx-auto max-w-7xl flex items-center justify-between gap-6 px-4 py-3">
          <div class="flex items-center gap-6">
            <RouterLink to="/" class="flex items-center" aria-label="SmallFastDrone home">
              <img
                :src="logoUrl"
                alt="SmallFastDrone"
                class="h-10 w-auto dark:invert"
              >
            </RouterLink>
            <UNavigationMenu :items="navItems" />
          </div>

          <div class="flex items-center gap-3">
            <!-- Whether this drone is secured follows the operator across
                 every page, so it belongs in the chrome rather than on one
                 view. Renders nothing on an ordinary drone. -->
            <SecurityBadge compact />
            <MessageBell />
            <!-- Entry point to the field-tools catalogue (run wizards from the
                 radio). Cross-cutting, so it lives in the chrome; the page
                 holds the catalogue. -->
            <UTooltip text="Field tools — run from your radio">
              <UButton
                to="/field"
                icon="i-lucide-radio"
                variant="ghost"
                color="neutral"
                size="sm"
                aria-label="Field tools"
              >
                <template v-if="field.installedCount > 0" #trailing>
                  <UBadge color="success" variant="solid" size="sm" class="justify-center rounded-full px-1 text-[10px] leading-none">
                    {{ field.installedCount }}
                  </UBadge>
                </template>
              </UButton>
            </UTooltip>
            <label class="flex cursor-pointer items-center gap-2 text-sm">
              <span class="text-muted select-none">Expert</span>
              <USwitch v-model="ui.expert" color="secondary" />
            </label>
          </div>
        </div>
      </header>

      <main class="mx-auto w-full max-w-7xl flex-1 p-6">
        <RouterView />
      </main>
    </div>
  </UApp>
</template>
