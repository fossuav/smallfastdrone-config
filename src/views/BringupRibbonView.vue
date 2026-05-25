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

// PROTOTYPE — ribbon layout for the bringup journey. A reimagining of the
// bringup meta-wizard's vertical step list (see wizards/bringup/DesktopView)
// as a horizontal tab ribbon across the top: each bringup area is a tab with
// a done-state, selecting one shows that area's CURRENT CONFIG pulled live
// from the FC plus the area's wizard full-width beneath. Buys back the
// horizontal real estate the narrow centered runner card wastes, and turns
// the journey into a live config dashboard. Reachable from the wizard
// library's "preview" link; not yet wired into the real bringup flow —
// staged so we can react to it before committing (docs: demonstrate then
// iterate). If it sticks, it folds into wizards/bringup.

import type { Component } from 'vue'
import { computed, onMounted, ref, shallowRef, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { useParamsStore } from '../stores/params'
import { useSessionStore } from '../stores/session'
import { useWizardProgressStore } from '../stores/wizardProgress'
import WizardRibbon from '../ui/components/WizardRibbon.vue'
import { BIDIR_MASK_PARAM, isDshot, MOT_PWM_TYPE_PARAM, protocolLabel } from '../workflow/esc-setup'
import { frameGeometry } from '../workflow/motor-geometry'
import { getWizard } from '../workflow/wizard-runtime'

const session = useSessionStore()
const params = useParamsStore()
const progress = useWizardProgressStore()

// The bringup areas, in order — same chain as the real meta-wizard.
const AREA_IDS = ['preflight', 'frame-select', 'motor-check'] as const

function val(name: string): number | undefined {
  return params.effectiveValue(name)
}

// One-line "current config" per area, read live from the FC. This is the
// headline of the ribbon: the operator sees the state of each area at a
// glance, in plain language, without opening the wizard.
const summaries = computed<Record<string, string>>(() => {
  // Pre-flight: overall sensor readiness.
  let preflight = 'Waiting for sensor status…'
  if (session.subsystems.length > 0)
    preflight = session.readyToArm ? 'All checks passing — ready to arm' : 'Some checks not passing yet'

  // Frame: the configured layout name.
  let frame = 'Not set yet'
  const cls = val('FRAME_CLASS')
  const typ = val('FRAME_TYPE')
  if (cls !== undefined && typ !== undefined)
    frame = frameGeometry(Math.trunc(cls), Math.trunc(typ))?.label ?? `Frame ${Math.trunc(cls)} / ${Math.trunc(typ)}`

  // Motors: ESC protocol + telemetry, plus the check result if we have one.
  let motors = 'Not set up yet'
  const pwm = val(MOT_PWM_TYPE_PARAM)
  if (pwm !== undefined) {
    const proto = protocolLabel(Math.trunc(pwm))
    const rpm = isDshot(Math.trunc(pwm)) && Math.trunc(val(BIDIR_MASK_PARAM) ?? 0) > 0
    motors = rpm ? `${proto} · RPM telemetry on` : proto
  }
  const motorCheck = progress.getCompletion(session.fcUid, 'motor-check')
  if (motorCheck)
    motors += ' · all check out'

  return { 'preflight': preflight, 'frame-select': frame, 'motor-check': motors }
})

// Project each area into its tab + panel data.
const areas = computed(() =>
  AREA_IDS.map((id) => {
    const reg = getWizard(id)
    return {
      id,
      label: reg?.manifest.title ?? id,
      hero: reg?.manifest.hero ?? 'i-lucide-wand-2',
      done: Boolean(progress.getCompletion(session.fcUid, id)),
      summary: summaries.value[id] ?? '—',
    }
  }),
)

const tabs = computed(() => areas.value.map(a => ({ id: a.id, label: a.label, done: a.done })))
const selected = ref<string>(AREA_IDS[0])
const selectedArea = computed(() => areas.value.find(a => a.id === selected.value))

// Lazy-load + mount the selected area's real wizard view full-width below
// the ribbon — same registry path the runner uses.
const contentView = shallowRef<Component | null>(null)
watch(selected, async (id) => {
  contentView.value = null
  contentView.value = (await getWizard(id)?.loadDesktopView()) ?? null
}, { immediate: true })

onMounted(() => {
  if (session.connected && params.count === 0)
    void params.load()
  // Open on the first area that isn't done yet — where the operator's
  // attention belongs.
  const next = areas.value.find(a => !a.done)
  if (next)
    selected.value = next.id
})
</script>

<template>
  <div class="mx-auto w-full max-w-5xl space-y-4">
    <div class="flex items-center justify-between gap-3">
      <div class="flex items-center gap-3">
        <UIcon name="i-lucide-list-checks" class="text-primary size-7" />
        <div>
          <h1 class="text-highlighted text-xl font-semibold">
            Bringup
          </h1>
          <p class="text-muted text-sm">
            Each tab is one part of getting your drone ready. The tab shows what's set now.
          </p>
        </div>
      </div>
      <UBadge color="warning" variant="subtle" size="sm">
        Ribbon preview
      </UBadge>
    </div>

    <!-- Not connected — the config + wizards need a live FC. -->
    <UCard v-if="!session.connected || !session.hasHeartbeat">
      <div class="text-muted py-8 text-center text-sm">
        <UIcon name="i-lucide-plug" class="mx-auto size-6" />
        <p class="mt-2">
          Connect your drone to preview the ribbon.
        </p>
        <RouterLink to="/" class="text-primary mt-2 inline-block">
          Go to Connect
        </RouterLink>
      </div>
    </UCard>

    <UCard v-else>
      <!-- The ribbon. -->
      <WizardRibbon v-model="selected" :tabs="tabs" />

      <!-- Current-config panel for the selected tab. -->
      <div v-if="selectedArea" class="mt-4 flex items-start justify-between gap-3">
        <div class="flex items-start gap-3">
          <div class="bg-primary/10 text-primary flex size-10 shrink-0 items-center justify-center rounded-md">
            <UIcon :name="selectedArea.hero" class="size-6" />
          </div>
          <div>
            <h2 class="text-highlighted font-semibold">
              {{ selectedArea.label }}
            </h2>
            <p class="text-muted text-sm">
              <span class="text-default font-medium">Now:</span> {{ selectedArea.summary }}
            </p>
          </div>
        </div>
        <RouterLink
          :to="`/wizard/${selected}?returnTo=/bringup`"
          class="text-muted hover:text-primary inline-flex shrink-0 items-center gap-1 text-sm"
        >
          Open on its own
          <UIcon name="i-lucide-arrow-up-right" class="size-4" />
        </RouterLink>
      </div>

      <hr class="border-default my-4">

      <!-- The selected area's wizard, full width. -->
      <component :is="contentView" v-if="contentView" :key="selected" />
      <div v-else class="text-muted py-12 text-center text-sm">
        Loading…
      </div>
    </UCard>
  </div>
</template>
