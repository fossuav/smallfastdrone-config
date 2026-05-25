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
// the journey into a live config dashboard.
//
// Tab selection is route-backed (/bringup?area=<id>) so each tab is a real,
// directly-clickable, deep-linkable destination and browser back/forward
// works between areas. The route also carries returnTo=/bringup so the
// inline wizards' own back/cancel/done paths return here rather than dumping
// the operator at the library. Not yet wired into the real bringup flow —
// staged behind the library's preview link; folds into wizards/bringup if it
// sticks (docs: demonstrate then iterate).

import type { Component } from 'vue'
import { computed, onMounted, shallowRef, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
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
const route = useRoute()
const router = useRouter()

// The bringup areas, in order — same chain as the real meta-wizard. NOTE:
// pre-arm readiness is deliberately NOT surfaced here — that's a pre-first-
// flight gate, not an opening-step concern (a fresh drone can't be arm-ready
// before it's configured). The opening pre-flight area reports hardware
// sanity (sensors present + healthy); a future "Ready for first flight" area
// owns the arm checks. See docs/BRINGUP.md.
const AREA_IDS = ['preflight', 'frame-select', 'motor-check'] as const

// Core sensors the opening pre-flight check cares about (operator labels).
const SENSOR_LABELS: Record<string, string> = {
  gyro: 'Gyro',
  accel: 'Accelerometer',
  mag: 'Compass',
  baro: 'Barometer',
}

function val(name: string): number | undefined {
  return params.effectiveValue(name)
}

interface ConfigField { label: string, value: string }

// Structured "current config" per area, read live from the FC — the headline
// of the ribbon: the operator sees the state of each area at a glance, in
// plain language, without opening the wizard.
const config = computed<Record<string, ConfigField[]>>(() => {
  // Pre-flight: core-sensor health (not arm readiness — see note above).
  let sensors = 'Waiting for status…'
  if (session.subsystems.length > 0) {
    const bad = session.subsystems
      .filter(s => s.key in SENSOR_LABELS && s.state === 'unhealthy')
      .map(s => SENSOR_LABELS[s.key])
    sensors = bad.length === 0 ? 'All healthy' : `${bad.join(', ')} need attention`
  }
  const preflight: ConfigField[] = [
    { label: 'Vehicle', value: session.vehicleLabel ?? '—' },
    { label: 'Sensors', value: sensors },
  ]

  // Frame: configured layout + motor count.
  const frame: ConfigField[] = []
  const cls = val('FRAME_CLASS')
  const typ = val('FRAME_TYPE')
  const geo = cls !== undefined && typ !== undefined ? frameGeometry(Math.trunc(cls), Math.trunc(typ)) : null
  frame.push({ label: 'Layout', value: geo?.label ?? (cls === undefined ? 'Not set yet' : `Frame ${Math.trunc(cls)} / ${Math.trunc(typ ?? 0)}`) })
  if (geo)
    frame.push({ label: 'Motors', value: String(geo.motors.length) })

  // Motors: ESC protocol + telemetry + the order/direction check result.
  const motors: ConfigField[] = []
  const pwm = val(MOT_PWM_TYPE_PARAM)
  if (pwm === undefined) {
    motors.push({ label: 'ESCs', value: 'Not set up yet' })
  }
  else {
    motors.push({ label: 'Protocol', value: protocolLabel(Math.trunc(pwm)) })
    if (isDshot(Math.trunc(pwm)))
      motors.push({ label: 'Telemetry', value: Math.trunc(val(BIDIR_MASK_PARAM) ?? 0) > 0 ? 'RPM on' : 'off' })
  }
  motors.push({ label: 'Check', value: progress.getCompletion(session.fcUid, 'motor-check') ? 'all passing' : 'not run yet' })

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
      fields: config.value[id] ?? [],
    }
  }),
)

const tabs = computed(() => areas.value.map(a => ({ id: a.id, label: a.label, done: a.done })))

// The selected area comes from the URL so tabs are deep-linkable and
// browser back/forward steps between them.
function isAreaId(v: unknown): v is typeof AREA_IDS[number] {
  return typeof v === 'string' && (AREA_IDS as readonly string[]).includes(v)
}
const selected = computed(() =>
  isAreaId(route.query.area)
    ? route.query.area
    : (areas.value.find(a => !a.done)?.id ?? AREA_IDS[0]),
)
const selectedArea = computed(() => areas.value.find(a => a.id === selected.value))

// Navigate to a tab. Carries returnTo=/bringup so the inline wizard's own
// back/cancel/done paths return to the ribbon.
function selectArea(id: string) {
  void router.push({ name: 'bringup-ribbon', query: { area: id, returnTo: '/bringup' } })
}

// Keep the URL canonical: land on /bringup (or return from an inline wizard
// to a bare /bringup) → replace with the resolved area + returnTo so the
// state is always deep-linkable and returnTo is always set.
watch(
  () => route.query.area,
  () => {
    if (route.name === 'bringup-ribbon' && !isAreaId(route.query.area))
      void router.replace({ name: 'bringup-ribbon', query: { area: selected.value, returnTo: '/bringup' } })
  },
  { immediate: true },
)

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
      <!-- The ribbon — route-backed tab navigation. -->
      <WizardRibbon :model-value="selected" :tabs="tabs" @update:model-value="selectArea" />

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
            <div class="mt-0.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
              <span v-for="f in selectedArea.fields" :key="f.label">
                <span class="text-muted">{{ f.label }}:</span>
                <span class="text-default ml-1 font-medium">{{ f.value }}</span>
              </span>
            </div>
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
