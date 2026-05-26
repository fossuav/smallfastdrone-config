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

// Wizard runner — the chrome around a single wizard's DesktopView.
// Reads the wizard id from the route, looks the manifest up in the
// registry, evaluates prereqs against the live capability snapshot,
// and (if prereqs pass) lazy-loads the DesktopView and mounts it. The
// view itself owns navigation back to the library; the runner only
// supplies the title bar and a back affordance.

import type { Component } from 'vue'
import { computed, ref, shallowRef, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { useSessionStore } from '../stores/session'
import FieldEnabledToggle from '../ui/components/FieldEnabledToggle.vue'
import {
  checkPrereqs,
  getWizard,
} from '../workflow/wizard-runtime'

const route = useRoute()
const session = useSessionStore()

// Lazy-loaded view component. Held in shallowRef so Vue doesn't try
// to make the component reactive (Vue components shouldn't be deeply
// observed — defeats their internal optimisations).
const desktopView = shallowRef<Component | null>(null)
const loadError = ref<string | null>(null)
// Which wizard id `desktopView` was mounted for. Lets us keep a running
// wizard mounted across a transient connectivity drop (see watcher).
const mountedId = ref<string | null>(null)
// True once a view is mounted — the running wizard owns the screen.
const hasView = computed(() => desktopView.value !== null)

// The current wizard id from the URL (/wizard/:id).
const wizardId = computed(() => String(route.params.id ?? ''))

// Look the manifest up in the registry. Undefined for unknown ids;
// the template renders a friendly "no such wizard" card in that case.
const wizard = computed(() => getWizard(wizardId.value))

// Live FC capability snapshot for prereq evaluation. Mirrors the one
// in WizardLibraryView so a wizard that the library said was startable
// stays startable here.
const caps = computed(() => ({
  connected: session.connected,
  heartbeat: session.hasHeartbeat,
  params_loaded: false,
}))

// Evaluated against the current wizard's prereqs every time caps move.
const prereqs = computed(() =>
  wizard.value
    ? checkPrereqs(wizard.value.manifest.prerequisites, caps.value)
    : { ok: false, missing: [] },
)

// Locked wizards are reachable via direct URL — we render a "Pro" page
// rather than running anything. Same shape as the locked card in the
// library so the experience is consistent.
const isLocked = computed(() => wizard.value?.manifest.locked === true)

// Load the DesktopView once we have a manifest, prereqs pass, and the
// wizard isn't locked. Crucially, once a view is mounted we keep it —
// even if prereqs transiently fail — until the route id changes or the
// wizard becomes locked/unknown. A running wizard owns its own
// connection state: some (motor-check correction, anything reboot-
// required) deliberately drop the link to restart the FC, and must not
// be torn down and re-mounted mid-flight. Watching the specific signals
// (not watchEffect) keeps body reads of desktopView/mountedId untracked.
watch(
  [wizardId, isLocked, () => prereqs.value.ok, () => Boolean(wizard.value)],
  async ([id, locked, prereqOk, haveWizard], prev) => {
    if (!haveWizard || locked) {
      desktopView.value = null
      mountedId.value = null
      loadError.value = null
      return
    }
    // Route moved to a different wizard — drop the old view.
    if (prev && id !== prev[0]) {
      desktopView.value = null
      mountedId.value = null
    }
    // Already mounted for this wizard — keep it across transient prereq
    // drops (e.g. the wizard is rebooting the FC).
    if (mountedId.value === id && desktopView.value)
      return
    if (!prereqOk)
      return
    loadError.value = null
    try {
      desktopView.value = await wizard.value!.loadDesktopView()
      mountedId.value = id
    }
    catch (e) {
      loadError.value = e instanceof Error ? e.message : String(e)
    }
  },
  { immediate: true },
)
</script>

<template>
  <div class="mx-auto w-full max-w-3xl space-y-4">
    <div class="flex items-center gap-2">
      <RouterLink
        to="/wizard"
        class="text-muted hover:text-primary inline-flex items-center gap-1 text-sm"
      >
        <UIcon name="i-lucide-chevron-left" class="size-4" />
        Wizard library
      </RouterLink>
    </div>

    <!-- Unknown wizard id — link rot or a typo. -->
    <UCard v-if="!wizard">
      <template #header>
        <div class="flex items-center gap-3">
          <UIcon name="i-lucide-circle-help" class="text-muted size-6" />
          <h1 class="text-highlighted text-xl font-semibold">
            Wizard not found
          </h1>
        </div>
      </template>
      <p class="text-muted">
        There's no wizard with id <code class="bg-elevated rounded px-1">{{ wizardId }}</code>.
        Head back to the library to see what's available.
      </p>
    </UCard>

    <!-- Locked Pro wizard reached by URL. -->
    <UCard v-else-if="isLocked">
      <template #header>
        <div class="flex items-center gap-3">
          <UIcon :name="wizard.manifest.hero" class="text-secondary size-6" />
          <h1 class="text-highlighted text-xl font-semibold">
            {{ wizard.manifest.title }}
          </h1>
          <UBadge color="warning" variant="solid" size="sm" class="ml-auto">
            Pro
          </UBadge>
        </div>
      </template>
      <p class="text-muted">
        {{ wizard.manifest.description }}
      </p>
      <p v-if="wizard.manifest.unlock_blurb" class="text-muted mt-3 text-sm italic">
        {{ wizard.manifest.unlock_blurb }}
      </p>
    </UCard>

    <!-- Happy path: a mounted wizard's DesktopView. Checked before the
         prereqs card so a running wizard that briefly drops connectivity
         (e.g. while it restarts the FC) keeps its screen instead of
         bouncing to "not ready". -->
    <UCard v-else-if="hasView">
      <template #header>
        <div class="flex items-center justify-between gap-3">
          <div class="flex items-center gap-3">
            <UIcon :name="wizard.manifest.hero" class="text-primary size-6" />
            <h1 class="text-highlighted text-xl font-semibold">
              {{ wizard.manifest.title }}
            </h1>
          </div>
          <!-- Per-wizard field-install toggle (info-blue, "On the radio"):
               makes field-enabling a property of the wizard, not a separate
               concern. Field tools (header radio icon) remains the central
               manager for paid / custom tools + scripting. -->
          <FieldEnabledToggle
            v-if="wizard.manifest.field_capable"
            :wizard-id="wizard.manifest.id"
          />
        </div>
      </template>
      <component :is="desktopView" />
    </UCard>

    <!-- Prereqs aren't satisfied — show what's missing in plain language. -->
    <UCard v-else-if="!prereqs.ok">
      <template #header>
        <div class="flex items-center gap-3">
          <UIcon :name="wizard.manifest.hero" class="text-primary size-6" />
          <h1 class="text-highlighted text-xl font-semibold">
            {{ wizard.manifest.title }}
          </h1>
        </div>
      </template>
      <p class="text-warning text-sm">
        This wizard isn't ready to start yet:
      </p>
      <ul class="text-default mt-2 list-disc pl-6 text-sm">
        <li v-for="(m, i) in prereqs.missing" :key="i">
          {{ m }}
        </li>
      </ul>
    </UCard>

    <!-- View module failed to load (very rare; usually only if the
         build dropped the view file). -->
    <UCard v-else-if="loadError">
      <template #header>
        <h1 class="text-highlighted text-xl font-semibold">
          Wizard couldn't start
        </h1>
      </template>
      <p class="text-error text-sm">
        {{ loadError }}
      </p>
    </UCard>

    <!-- Prereqs pass but the view module is still loading. -->
    <UCard v-else>
      <template #header>
        <div class="flex items-center gap-3">
          <UIcon :name="wizard.manifest.hero" class="text-primary size-6" />
          <h1 class="text-highlighted text-xl font-semibold">
            {{ wizard.manifest.title }}
          </h1>
        </div>
      </template>
      <div class="text-muted py-12 text-center text-sm">
        Loading…
      </div>
    </UCard>
  </div>
</template>
