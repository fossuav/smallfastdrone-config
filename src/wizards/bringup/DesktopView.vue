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

// Bringup meta-wizard DesktopView — the ribbon. Each bringup area is a tab
// with its done-state; selecting one shows that area's current config
// pulled live from the FC plus the area's wizard mounted full-width below.
// Field-capable areas (motor-check) carry an inline "On the radio" toggle
// in their header — field-install reads as a property OF the area, not a
// separate concern. Selection is route-backed (/wizard/bringup?area=<id>)
// so tabs are deep-linkable + browser back/forward steps between areas;
// the route carries returnTo=/wizard/bringup so the inline wizards'
// back/cancel/done paths return to the ribbon (which then auto-advances
// to the next incomplete area).
//
// Bringup auto-marks itself complete once every sub-wizard is complete —
// no separate Finish, meta-wizards don't take actions of their own. The
// runner provides the title chrome; this view focuses on the journey.

import type { Component } from 'vue'
import { computed, onMounted, shallowRef, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { useParamsStore } from '../../stores/params'
import { useSessionStore } from '../../stores/session'
import { useWizardProgressStore } from '../../stores/wizardProgress'
import EscQuickControls from '../../ui/components/EscQuickControls.vue'
import FieldEnabledToggle from '../../ui/components/FieldEnabledToggle.vue'
import WizardRibbon from '../../ui/components/WizardRibbon.vue'
import { frameGeometry } from '../../workflow/motor-geometry'
import { getWizard } from '../../workflow/wizard-runtime'

const session = useSessionStore()
const params = useParamsStore()
const progress = useWizardProgressStore()
const route = useRoute()
const router = useRouter()

// Ordered chain of bringup areas. Pre-arm readiness is deliberately NOT
// surfaced here — that's a phase-05 (pre-first-flight) gate, not an
// opening-step concern. See docs/BRINGUP.md.
const AREA_IDS = ['preflight', 'frame-select', 'motor-check'] as const

// Where this DesktopView lives, for routing tabs + returnTo.
const RIBBON_PATH = '/wizard/bringup'

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

// Structured "current config" per area, read live from the FC.
const config = computed<Record<string, ConfigField[]>>(() => {
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

  const frame: ConfigField[] = []
  const cls = val('FRAME_CLASS')
  const typ = val('FRAME_TYPE')
  const geo = cls !== undefined && typ !== undefined ? frameGeometry(Math.trunc(cls), Math.trunc(typ)) : null
  frame.push({ label: 'Layout', value: geo?.label ?? (cls === undefined ? 'Not set yet' : `Frame ${Math.trunc(cls)} / ${Math.trunc(typ ?? 0)}`) })
  if (geo)
    frame.push({ label: 'Motors', value: String(geo.motors.length) })

  // Motors has no read-only fields here — its panel hosts EscQuickControls +
  // the direction-check status instead.
  return { 'preflight': preflight, 'frame-select': frame }
})

// Project each area into its tab + panel data.
const areas = computed(() =>
  AREA_IDS.map((id) => {
    const reg = getWizard(id)
    return {
      id,
      label: reg?.manifest.title ?? id,
      hero: reg?.manifest.hero ?? 'i-lucide-wand-2',
      fieldCapable: Boolean(reg?.manifest.field_capable),
      done: Boolean(progress.getCompletion(session.fcUid, id)),
      fields: config.value[id] ?? [],
    }
  }),
)

const tabs = computed(() => areas.value.map(a => ({ id: a.id, label: a.label, done: a.done })))

// Motor order/direction status for the Motors panel.
const motorDirectionStatus = computed(() =>
  progress.getCompletion(session.fcUid, 'motor-check') ? 'checked — all passing' : 'not checked yet',
)

// Selection comes from the URL so tabs are deep-linkable + back/forward works.
function isAreaId(v: unknown): v is typeof AREA_IDS[number] {
  return typeof v === 'string' && (AREA_IDS as readonly string[]).includes(v)
}
const selected = computed(() =>
  isAreaId(route.query.area)
    ? route.query.area
    : (areas.value.find(a => !a.done)?.id ?? AREA_IDS[0]),
)
const selectedArea = computed(() => areas.value.find(a => a.id === selected.value))

// Navigate to a tab. Carries returnTo so the inline wizard's own
// back/cancel/done paths return to the ribbon.
function selectArea(id: string) {
  void router.push({ path: RIBBON_PATH, query: { area: id, returnTo: RIBBON_PATH } })
}

// Keep the URL canonical: land on /wizard/bringup (or return from an inline
// wizard to a bare /wizard/bringup) → replace with the resolved area +
// returnTo so the state is always deep-linkable and returnTo is set.
watch(
  () => route.query.area,
  () => {
    if (route.path === RIBBON_PATH && !isAreaId(route.query.area))
      void router.replace({ path: RIBBON_PATH, query: { area: selected.value, returnTo: RIBBON_PATH } })
  },
  { immediate: true },
)

// Lazy-load + mount the selected area's wizard view full-width below.
const contentView = shallowRef<Component | null>(null)
watch(selected, async (id) => {
  contentView.value = null
  contentView.value = (await getWizard(id)?.loadDesktopView()) ?? null
}, { immediate: true })

// Auto-mark bringup complete once every sub-wizard is complete.
const allComplete = computed(() =>
  areas.value.length > 0 && areas.value.every(a => a.done),
)
watch(
  allComplete,
  (done) => {
    if (done && !progress.isCompleted(session.fcUid, 'bringup')) {
      progress.markComplete(
        session.fcUid,
        'bringup',
        `All ${areas.value.length} bringup steps complete.`,
      )
    }
  },
  { immediate: true },
)

onMounted(() => {
  if (session.connected && params.count === 0)
    void params.load()
})
</script>

<template>
  <div class="space-y-4">
    <!-- Disconnected (and not in a reboot we initiated) — friendly prompt
         rather than stale tabs. The runner keeps us mounted across drops. -->
    <div
      v-if="!session.rebooting && (!session.connected || !session.hasHeartbeat)"
      class="text-muted py-8 text-center text-sm"
    >
      <UIcon name="i-lucide-plug" class="mx-auto size-6" />
      <p class="mt-2">
        Connect your drone to run bringup.
      </p>
      <RouterLink to="/" class="text-primary mt-2 inline-block">
        Go to Connect
      </RouterLink>
    </div>

    <template v-else>
      <!-- The ribbon — route-backed tab navigation. -->
      <WizardRibbon :model-value="selected" :tabs="tabs" @update:model-value="selectArea" />

      <!-- Current-config panel for the selected tab. Field-capable areas
           carry the inline "On the radio" toggle in their header. -->
      <div v-if="selectedArea" class="space-y-3">
        <div class="flex items-start justify-between gap-3">
          <div class="flex items-center gap-3">
            <div class="bg-primary/10 text-primary flex size-10 shrink-0 items-center justify-center rounded-md">
              <UIcon :name="selectedArea.hero" class="size-6" />
            </div>
            <h2 class="text-highlighted font-semibold">
              {{ selectedArea.label }}
            </h2>
          </div>
          <div class="flex items-center gap-4">
            <FieldEnabledToggle
              v-if="selectedArea.fieldCapable"
              :wizard-id="selectedArea.id"
            />
            <RouterLink
              :to="`/wizard/${selected}?returnTo=${RIBBON_PATH}`"
              class="text-muted hover:text-primary inline-flex shrink-0 items-center gap-1 text-sm"
            >
              Open on its own
              <UIcon name="i-lucide-arrow-up-right" class="size-4" />
            </RouterLink>
          </div>
        </div>

        <!-- Motors: ESC settings are quick controls; the direction check is the procedure below. -->
        <template v-if="selected === 'motor-check'">
          <EscQuickControls />
          <div class="text-sm">
            <span class="text-muted">Motor direction:</span>
            <span class="text-default ml-1 font-medium">{{ motorDirectionStatus }}</span>
          </div>
        </template>

        <!-- Other areas: read-only current-config fields. -->
        <div v-else class="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
          <span v-for="f in selectedArea.fields" :key="f.label">
            <span class="text-muted">{{ f.label }}:</span>
            <span class="text-default ml-1 font-medium">{{ f.value }}</span>
          </span>
        </div>
      </div>

      <hr class="border-default my-4">

      <!-- The selected area's wizard, full width. Motors skips ESC setup
           since the panel above owns it. -->
      <component :is="contentView" v-if="contentView" :key="selected" :skip-esc="selected === 'motor-check'" />
      <div v-else class="text-muted py-12 text-center text-sm">
        Loading…
      </div>
    </template>
  </div>
</template>
